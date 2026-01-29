// Модуль синхронизации с Firebase
// Требуется настройка Firebase конфигурации в index.html

let syncEnabled = false;
let currentUserId = null;
let unsubscribeListener = null;

// Проверка доступности Firebase
function isFirebaseAvailable() {
    return typeof window.firebaseAuth !== 'undefined' && 
           typeof window.firebaseDb !== 'undefined';
}

// Инициализация синхронизации
async function initSync() {
    if (!isFirebaseAvailable()) {
        console.log('Firebase не настроен. Работаем в локальном режиме.');
        updateSyncStatus('local', 'Firebase не настроен');
        return;
    }

    const { signInAnonymously, onAuthStateChanged, signOut } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js');
    
    // Слушаем изменения состояния аутентификации
    onAuthStateChanged(window.firebaseAuth, async (user) => {
        if (user) {
            currentUserId = user.uid;
            syncEnabled = true;
            updateSyncStatus('syncing', 'Подключение...');
            document.getElementById('btn-sync-login').style.display = 'none';
            document.getElementById('btn-sync-logout').style.display = 'inline-block';
            
            try {
                // Сначала настраиваем слушатель (только для получения обновлений)
                await setupSyncListener();
                
                // Загружаем данные из облака при входе (если есть)
                const cloudData = await loadFromCloud();
                const localTimestamp = getLocalTimestamp();
                const cloudTimestamp = await getCloudTimestamp();
                
                if (cloudData && cloudData.length > 0) {
                    // Есть данные в облаке - сравниваем с локальными
                    if (cloudTimestamp > localTimestamp || localTimestamp === 0) {
                        // Облачные данные новее или локальных нет - загружаем из облака
                        if (window.saveSubscriptions) {
                            window.saveSubscriptions(cloudData);
                        }
                        if (window.subscriptions) {
                            window.subscriptions = cloudData;
                            if (window.render) {
                                window.render();
                            }
                        }
                        updateSyncStatus('synced', `Загружено из облака (${user.email || 'Пользователь'})`);
                    } else if (localTimestamp > cloudTimestamp) {
                        // Локальные данные новее - показываем кнопку сохранения
                        updateSyncStatus('local-newer', `Локальные данные новее (${user.email || 'Пользователь'})`);
                    } else {
                        // Данные синхронизированы
                        updateSyncStatus('synced', `Синхронизировано (${user.email || 'Пользователь'})`);
                    }
                } else {
                    // Нет данных в облаке - показываем статус готовности к сохранению
                    if (localTimestamp > 0) {
                        updateSyncStatus('ready', `Готово к сохранению (${user.email || 'Пользователь'})`);
                    } else {
                        updateSyncStatus('ready', `Войдите для синхронизации (${user.email || 'Пользователь'})`);
                    }
                }
                
                // Показываем кнопки сохранения и загрузки
                const saveBtn = document.getElementById('btn-sync-save');
                const loadBtn = document.getElementById('btn-sync-load');
                if (saveBtn) {
                    saveBtn.style.display = 'inline-block';
                }
                if (loadBtn) {
                    loadBtn.style.display = 'inline-block';
                }
            } catch (error) {
                console.error('Ошибка при настройке синхронизации:', error);
                updateSyncStatus('error', 'Ошибка подключения');
            }
        } else {
            currentUserId = null;
            syncEnabled = false;
            updateSyncStatus('local', 'Локально');
            document.getElementById('btn-sync-login').style.display = 'inline-block';
            document.getElementById('btn-sync-logout').style.display = 'none';
            const saveBtn = document.getElementById('btn-sync-save');
            const loadBtn = document.getElementById('btn-sync-load');
            if (saveBtn) {
                saveBtn.style.display = 'none';
            }
            if (loadBtn) {
                loadBtn.style.display = 'none';
            }
            if (unsubscribeListener) {
                unsubscribeListener();
                unsubscribeListener = null;
            }
        }
    });
}

// Открытие модального окна входа
function openAuthModal() {
    if (!isFirebaseAvailable()) {
        alert('Firebase не настроен. Пожалуйста, настройте Firebase конфигурацию в index.html');
        return;
    }
    document.getElementById('auth-modal').style.display = 'flex';
    switchAuthTab('login');
}

// Закрытие модального окна входа
function closeAuthModal() {
    document.getElementById('auth-modal').style.display = 'none';
    document.getElementById('auth-error').style.display = 'none';
    document.getElementById('auth-form').reset();
}

// Переключение между вкладками входа/регистрации
function switchAuthTab(tab) {
    const loginTab = document.querySelector('[data-tab="login"]');
    const registerTab = document.querySelector('[data-tab="register"]');
    const title = document.getElementById('auth-title');
    const submitBtn = document.getElementById('auth-submit-btn');
    
    if (tab === 'login') {
        loginTab.classList.add('active');
        registerTab.classList.remove('active');
        title.textContent = 'Вход для синхронизации';
        submitBtn.textContent = 'Войти';
    } else {
        loginTab.classList.remove('active');
        registerTab.classList.add('active');
        title.textContent = 'Регистрация для синхронизации';
        submitBtn.textContent = 'Зарегистрироваться';
    }
}

// Вход по email/password
async function loginWithEmail(email, password) {
    try {
        const { signInWithEmailAndPassword } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js');
        await signInWithEmailAndPassword(window.firebaseAuth, email, password);
        closeAuthModal();
        return true;
    } catch (error) {
        console.error('Ошибка входа:', error);
        showAuthError(getAuthErrorMessage(error));
        return false;
    }
}

// Регистрация по email/password
async function registerWithEmail(email, password) {
    try {
        const { createUserWithEmailAndPassword } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js');
        await createUserWithEmailAndPassword(window.firebaseAuth, email, password);
        closeAuthModal();
        return true;
    } catch (error) {
        console.error('Ошибка регистрации:', error);
        showAuthError(getAuthErrorMessage(error));
        return false;
    }
}

// Получение понятного сообщения об ошибке
function getAuthErrorMessage(error) {
    const errorMessages = {
        'auth/user-not-found': 'Пользователь с таким email не найден',
        'auth/wrong-password': 'Неверный пароль',
        'auth/email-already-in-use': 'Email уже используется',
        'auth/weak-password': 'Пароль слишком слабый (минимум 6 символов)',
        'auth/invalid-email': 'Неверный формат email',
        'auth/network-request-failed': 'Ошибка сети. Проверьте интернет-соединение',
        'auth/too-many-requests': 'Слишком много попыток. Попробуйте позже'
    };
    return errorMessages[error.code] || error.message || 'Произошла ошибка';
}

// Показать ошибку аутентификации
function showAuthError(message) {
    const errorEl = document.getElementById('auth-error');
    errorEl.textContent = message;
    errorEl.style.display = 'block';
}

// Обработка формы входа/регистрации
async function handleAuthForm(e) {
    e.preventDefault();
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;
    const activeTab = document.querySelector('.auth-tab.active').dataset.tab;
    
    if (!email || !password) {
        showAuthError('Заполните все поля');
        return;
    }
    
    if (password.length < 6) {
        showAuthError('Пароль должен содержать минимум 6 символов');
        return;
    }
    
    if (activeTab === 'login') {
        await loginWithEmail(email, password);
    } else {
        await registerWithEmail(email, password);
    }
}

// Выход
async function logoutSync() {
    if (!isFirebaseAvailable()) return;
    
    try {
        const { signOut } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js');
        await signOut(window.firebaseAuth);
        if (unsubscribeListener) {
            unsubscribeListener();
            unsubscribeListener = null;
        }
    } catch (error) {
        console.error('Ошибка выхода:', error);
    }
}

// Настройка слушателя изменений в облаке
async function setupSyncListener() {
    if (!syncEnabled || !currentUserId) return;

    const { doc, onSnapshot } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js');
    const userDocRef = doc(window.firebaseDb, 'users', currentUserId);

    // Отписываемся от предыдущего слушателя, если есть
    if (unsubscribeListener) {
        unsubscribeListener();
    }

    unsubscribeListener = onSnapshot(userDocRef, (snapshot) => {
        if (!snapshot.exists()) return;
        
        const cloudData = snapshot.data();
        if (cloudData && cloudData.subscriptions) {
            // Получаем локальные данные
            const loadSubs = window.loadSubscriptions || (() => {
                const stored = localStorage.getItem('subscriptions');
                if (!stored) return [];
                try {
                    return JSON.parse(stored);
                } catch {
                    return [];
                }
            });
            const localData = loadSubs();
            
            // Сравниваем временные метки
            const cloudTimestamp = cloudData.lastUpdated?.toMillis ? cloudData.lastUpdated.toMillis() : (cloudData.lastUpdated || 0);
            const localTimestamp = getLocalTimestamp();
            
            // Если облачные данные новее, загружаем их
            if (cloudTimestamp > localTimestamp) {
                console.log('Загружаем данные из облака...');
                const saveSubs = window.saveSubscriptions || ((subs) => {
                    localStorage.setItem('subscriptions', JSON.stringify(subs));
                });
                saveSubs(cloudData.subscriptions);
                if (window.subscriptions) {
                    window.subscriptions = cloudData.subscriptions;
                    if (window.render) {
                        window.render();
                    }
                }
                updateSyncStatus('synced', 'Синхронизировано (обновлено из облака)');
            }
        }
    }, (error) => {
        console.error('Ошибка синхронизации:', error);
        updateSyncStatus('error', 'Ошибка синхронизации');
    });
}

// Синхронизация данных в облако
async function syncToCloud() {
    if (!syncEnabled || !currentUserId) {
        console.log('Синхронизация отключена или пользователь не авторизован');
        return;
    }

    try {
        updateSyncStatus('syncing', 'Синхронизация...');
        
        const { doc, setDoc, serverTimestamp } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js');
        const userDocRef = doc(window.firebaseDb, 'users', currentUserId);
        
        // Загружаем подписки (асинхронно, если доступна функция, иначе синхронно из localStorage)
        let subscriptions;
        if (window.loadSubscriptions && typeof window.loadSubscriptions === 'function') {
            // Проверяем, асинхронная ли это функция
            const result = window.loadSubscriptions();
            if (result instanceof Promise) {
                subscriptions = await result;
            } else {
                subscriptions = result;
            }
        } else {
            // Fallback: загружаем напрямую из localStorage
            const stored = localStorage.getItem('subscriptions');
            if (!stored) {
                subscriptions = [];
            } else {
                try {
                    subscriptions = JSON.parse(stored);
                } catch (e) {
                    console.error('Ошибка парсинга локальных данных:', e);
                    subscriptions = [];
                }
            }
        }
        
        // Проверяем, что subscriptions - это массив
        if (!Array.isArray(subscriptions)) {
            console.warn('Подписки не являются массивом, преобразуем:', subscriptions);
            subscriptions = [];
        }
        
        console.log('Синхронизация подписок в облако:', subscriptions.length, 'подписок');
        
        await setDoc(userDocRef, {
            subscriptions: subscriptions,
            lastUpdated: serverTimestamp()
        }, { merge: true });
        
        console.log('Данные успешно сохранены в облако');
        updateSyncStatus('synced', 'Синхронизировано');
        
    } catch (error) {
        console.error('Ошибка сохранения в облако:', error);
        console.error('Детали ошибки:', {
            code: error.code,
            message: error.message,
            stack: error.stack
        });
        
        // Более детальное сообщение об ошибке
        let errorMessage = 'Ошибка сохранения';
        if (error.code === 'permission-denied') {
            errorMessage = 'Ошибка: Нет доступа. Проверьте правила Firestore.';
        } else if (error.code === 'unavailable') {
            errorMessage = 'Ошибка: Сервис недоступен. Проверьте интернет.';
        } else if (error.message) {
            errorMessage = 'Ошибка: ' + error.message;
        }
        
        updateSyncStatus('error', errorMessage);
        
        // Показываем alert только для критических ошибок
        if (error.code === 'permission-denied') {
            alert('Ошибка доступа к Firebase!\n\n' +
                  'Возможные причины:\n' +
                  '1. Правила Firestore не настроены правильно\n' +
                  '2. Анонимная аутентификация не включена\n\n' +
                  'Проверьте консоль браузера (F12) для подробностей.');
        }
    }
}

// Загрузка данных из облака
async function loadFromCloud() {
    if (!syncEnabled || !currentUserId) return null;

    try {
        const { doc, getDoc } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js');
        const userDocRef = doc(window.firebaseDb, 'users', currentUserId);
        const snapshot = await getDoc(userDocRef);
        
        if (snapshot.exists()) {
            const data = snapshot.data();
            return data.subscriptions || [];
        }
    } catch (error) {
        console.error('Ошибка загрузки из облака:', error);
    }
    return null;
}

// Получение временной метки из облака
async function getCloudTimestamp() {
    if (!syncEnabled || !currentUserId) return 0;

    try {
        const { doc, getDoc } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js');
        const userDocRef = doc(window.firebaseDb, 'users', currentUserId);
        const snapshot = await getDoc(userDocRef);
        
        if (snapshot.exists()) {
            const data = snapshot.data();
            if (data.lastUpdated) {
                // Firestore Timestamp
                if (data.lastUpdated.toMillis) {
                    return data.lastUpdated.toMillis();
                }
                // Обычное число
                return data.lastUpdated || 0;
            }
        }
    } catch (error) {
        console.error('Ошибка получения временной метки:', error);
    }
    return 0;
}

// Явное сохранение в облако (по нажатию кнопки)
async function saveToCloudExplicit() {
    if (!syncEnabled || !currentUserId) {
        alert('Вы не вошли в систему. Пожалуйста, войдите для синхронизации.');
        return;
    }

    // Проверяем, есть ли более новые данные в облаке
    const cloudTimestamp = await getCloudTimestamp();
    const localTimestamp = getLocalTimestamp();
    
    if (cloudTimestamp > localTimestamp) {
        const confirmSave = confirm(
            'В облаке есть более новые данные!\n\n' +
            'Локальные данные: ' + new Date(localTimestamp).toLocaleString('ru-RU') + '\n' +
            'Облачные данные: ' + new Date(cloudTimestamp).toLocaleString('ru-RU') + '\n\n' +
            'Вы уверены, что хотите перезаписать облачные данные локальными?'
        );
        
        if (!confirmSave) {
            updateSyncStatus('ready', 'Сохранение отменено');
            return;
        }
    }

    // Сохраняем в облако
    updateSyncStatus('syncing', 'Сохранение в облако...');
    
    try {
        await syncToCloud();
        updateSyncStatus('synced', 'Сохранено в облако');
        
        // Показываем уведомление об успехе
        if (Notification.permission === 'granted') {
            new Notification('Данные сохранены', {
                body: 'Ваши подписки успешно сохранены в облако',
                icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="green"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>'
            });
        }
    } catch (error) {
        console.error('Ошибка сохранения:', error);
        updateSyncStatus('error', 'Ошибка сохранения');
        alert('Не удалось сохранить данные в облако: ' + (error.message || 'Неизвестная ошибка'));
    }
}

// Явная загрузка из облака (по нажатию кнопки)
async function loadFromCloudExplicit() {
    if (!syncEnabled || !currentUserId) {
        alert('Вы не вошли в систему. Пожалуйста, войдите для синхронизации.');
        return;
    }

    const localTimestamp = getLocalTimestamp();
    const cloudTimestamp = await getCloudTimestamp();
    
    // Проверяем, есть ли более новые локальные данные
    if (localTimestamp > cloudTimestamp && localTimestamp > 0) {
        const confirmLoad = confirm(
            'У вас есть локальные изменения, которые новее облачных!\n\n' +
            'Локальные данные: ' + new Date(localTimestamp).toLocaleString('ru-RU') + '\n' +
            'Облачные данные: ' + new Date(cloudTimestamp).toLocaleString('ru-RU') + '\n\n' +
            'Загрузка из облака перезапишет ваши локальные данные. Продолжить?'
        );
        
        if (!confirmLoad) {
            updateSyncStatus('ready', 'Загрузка отменена');
            return;
        }
    }

    // Загружаем из облака
    updateSyncStatus('syncing', 'Загрузка из облака...');
    
    try {
        const cloudData = await loadFromCloud();
        
        if (cloudData && cloudData.length >= 0) {
            // Сохраняем загруженные данные локально
            if (window.saveSubscriptions) {
                window.saveSubscriptions(cloudData);
            }
            if (window.subscriptions) {
                window.subscriptions = cloudData;
                if (window.render) {
                    window.render();
                }
            }
            
            updateSyncStatus('synced', 'Загружено из облака');
            
            // Показываем уведомление об успехе
            if (Notification.permission === 'granted') {
                new Notification('Данные загружены', {
                    body: `Загружено ${cloudData.length} подписок из облака`,
                    icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="blue"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>'
                });
            }
        } else {
            updateSyncStatus('ready', 'В облаке нет данных');
            alert('В облаке нет сохраненных данных.');
        }
    } catch (error) {
        console.error('Ошибка загрузки:', error);
        updateSyncStatus('error', 'Ошибка загрузки');
        alert('Не удалось загрузить данные из облака: ' + (error.message || 'Неизвестная ошибка'));
    }
}

// Обновление статуса синхронизации
function updateSyncStatus(status, text) {
    const statusEl = document.getElementById('sync-status');
    if (!statusEl) return;
    
    statusEl.textContent = text;
    statusEl.className = 'sync-status';
    
    switch (status) {
        case 'synced':
            statusEl.textContent = '✅ ' + (text || 'Синхронизировано');
            statusEl.title = 'Данные синхронизированы с облаком';
            break;
        case 'syncing':
            statusEl.textContent = '🔄 ' + (text || 'Синхронизация...');
            statusEl.title = 'Идет синхронизация...';
            break;
        case 'ready':
            statusEl.textContent = '💾 ' + (text || 'Готово к сохранению');
            statusEl.title = 'Нажмите "Сохранить в облако" для синхронизации';
            break;
        case 'local-newer':
            statusEl.textContent = '⚠️ ' + (text || 'Локальные данные новее');
            statusEl.title = 'Локальные данные новее облачных. Нажмите "Сохранить в облако"';
            break;
        case 'error':
            statusEl.textContent = '❌ ' + (text || 'Ошибка');
            statusEl.title = 'Ошибка синхронизации';
            break;
        case 'local':
        default:
            statusEl.textContent = '⚪ ' + (text || 'Локально');
            statusEl.title = 'Данные хранятся только локально';
            break;
    }
}

// Получение локальной временной метки
function getLocalTimestamp() {
    const stored = localStorage.getItem('subscriptions_timestamp');
    return stored ? parseInt(stored, 10) : 0;
}

// Сохранение временной метки
function saveLocalTimestamp() {
    localStorage.setItem('subscriptions_timestamp', Date.now().toString());
}

// Инициализация при загрузке страницы
document.addEventListener('DOMContentLoaded', () => {
    // Ждем загрузки Firebase
    setTimeout(() => {
        initSync();
        
        // Настраиваем обработчики кнопок
        const loginBtn = document.getElementById('btn-sync-login');
        const logoutBtn = document.getElementById('btn-sync-logout');
        const saveBtn = document.getElementById('btn-sync-save');
        const loadBtn = document.getElementById('btn-sync-load');
        
        if (loginBtn) {
            loginBtn.addEventListener('click', openAuthModal);
        }
        if (logoutBtn) {
            logoutBtn.addEventListener('click', logoutSync);
        }
        if (saveBtn) {
            saveBtn.addEventListener('click', saveToCloudExplicit);
        }
        if (loadBtn) {
            loadBtn.addEventListener('click', loadFromCloudExplicit);
        }
        
        // Обработчики модального окна аутентификации
        const authModal = document.getElementById('auth-modal');
        const authForm = document.getElementById('auth-form');
        const authCloseBtn = document.getElementById('auth-close-btn');
        const authCancelBtn = document.getElementById('auth-cancel-btn');
        const authTabs = document.querySelectorAll('.auth-tab');
        
        if (authForm) {
            authForm.addEventListener('submit', handleAuthForm);
        }
        if (authCloseBtn) {
            authCloseBtn.addEventListener('click', closeAuthModal);
        }
        if (authCancelBtn) {
            authCancelBtn.addEventListener('click', closeAuthModal);
        }
        if (authTabs.length > 0) {
            authTabs.forEach(tab => {
                tab.addEventListener('click', () => {
                    switchAuthTab(tab.dataset.tab);
                });
            });
        }
        
        // Закрытие модального окна по клику вне области
        if (authModal) {
            authModal.addEventListener('click', (e) => {
                if (e.target.id === 'auth-modal') {
                    closeAuthModal();
                }
            });
        }
    }, 1000);
});

// Экспорт функций для использования в app.js
window.firebaseSync = {
    syncToCloud,
    loadFromCloud,
    saveToCloudExplicit,
    loadFromCloudExplicit,
    isEnabled: () => syncEnabled,
    login: openAuthModal,
    logout: logoutSync
};
