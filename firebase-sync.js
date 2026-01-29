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
            updateSyncStatus('synced', `Синхронизировано (${user.isAnonymous ? 'Анонимно' : user.email || 'Пользователь'})`);
            document.getElementById('btn-sync-login').style.display = 'none';
            document.getElementById('btn-sync-logout').style.display = 'inline-block';
            await setupSyncListener();
            await syncToCloud();
        } else {
            currentUserId = null;
            syncEnabled = false;
            updateSyncStatus('local', 'Локально');
            document.getElementById('btn-sync-login').style.display = 'inline-block';
            document.getElementById('btn-sync-logout').style.display = 'none';
            if (unsubscribeListener) {
                unsubscribeListener();
                unsubscribeListener = null;
            }
        }
    });
}

// Вход (анонимный)
async function loginSync() {
    if (!isFirebaseAvailable()) {
        alert('Firebase не настроен. Пожалуйста, настройте Firebase конфигурацию в index.html');
        return;
    }

    try {
        const { signInAnonymously } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js');
        await signInAnonymously(window.firebaseAuth);
    } catch (error) {
        console.error('Ошибка входа:', error);
        alert('Не удалось войти: ' + error.message);
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
    if (!syncEnabled || !currentUserId) return;

    try {
        const { doc, setDoc, serverTimestamp } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js');
        const userDocRef = doc(window.firebaseDb, 'users', currentUserId);
        
        const loadSubs = window.loadSubscriptions || (() => {
            const stored = localStorage.getItem('subscriptions');
            if (!stored) return [];
            try {
                return JSON.parse(stored);
            } catch {
                return [];
            }
        });
        const subscriptions = loadSubs();
        
        await setDoc(userDocRef, {
            subscriptions: subscriptions,
            lastUpdated: serverTimestamp()
        }, { merge: true });
        
        updateSyncStatus('syncing', 'Синхронизация...');
        setTimeout(() => {
            if (syncEnabled) {
                updateSyncStatus('synced', 'Синхронизировано');
            }
        }, 500);
    } catch (error) {
        console.error('Ошибка сохранения в облако:', error);
        updateSyncStatus('error', 'Ошибка сохранения');
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
        
        if (loginBtn) {
            loginBtn.addEventListener('click', loginSync);
        }
        if (logoutBtn) {
            logoutBtn.addEventListener('click', logoutSync);
        }
    }, 1000);
});

// Экспорт функций для использования в app.js
window.firebaseSync = {
    syncToCloud,
    loadFromCloud,
    isEnabled: () => syncEnabled,
    login: loginSync,
    logout: logoutSync
};
