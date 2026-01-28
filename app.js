// Хранение данных
const STORAGE_KEY = 'subscriptions';

function saveSubscriptions(subscriptions) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(subscriptions));
}

function loadSubscriptions() {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];
    try {
        return JSON.parse(stored);
    } catch {
        return [];
    }
}

// Уведомления
async function requestNotificationPermission() {
    if (!('Notification' in window)) {
        console.log('Браузер не поддерживает уведомления');
        return false;
    }
    if (Notification.permission === 'granted') return true;
    if (Notification.permission !== 'denied') {
        const permission = await Notification.requestPermission();
        return permission === 'granted';
    }
    return false;
}

function showNotification(title, body) {
    if (Notification.permission === 'granted') {
        new Notification(title, { body });
    }
}

function checkUpcomingBilling(subscriptions) {
    const today = new Date();
    subscriptions.forEach((sub) => {
        const billingDate = new Date(sub.nextBillingDate);
        const diffTime = billingDate.getTime() - today.getTime();
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        if (diffDays === 2 || diffDays === 1) {
            showNotification(
                `Скоро списание: ${sub.name}`,
                `Через ${diffDays} ${diffDays === 1 ? 'день' : 'дня'} будет списано ${sub.price} ${sub.currency}`
            );
        }
    });
}

// Парсинг выписки
function pad2(n) {
    return n < 10 ? `0${n}` : `${n}`;
}

function parseDateToIso(input, fallbackYear) {
    // Поддержка формата [DD.MM.YYYY HH:MM]
    let m = input.match(/\[(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
    if (m) {
        const day = Number(m[1]);
        const month = Number(m[2]);
        let year = Number(m[3]);
        if (year < 100) year = 2000 + year;
        if (day && month && day <= 31 && month <= 12 && year >= 2000 && year <= 2100) {
            return `${year}-${pad2(month)}-${pad2(day)}`;
        }
    }
    // Стандартный формат DD.MM.YYYY или DD/MM/YYYY
    m = input.match(/\b(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?\b/);
    if (!m) return null;
    const day = Number(m[1]);
    const month = Number(m[2]);
    if (!day || !month || day > 31 || month > 12) return null;
    const yearRaw = m[3];
    let year;
    if (!yearRaw) {
        year = fallbackYear ?? new Date().getFullYear();
    } else if (yearRaw.length === 2) {
        year = 2000 + Number(yearRaw);
    } else {
        year = Number(yearRaw);
    }
    if (!year || year < 2000 || year > 2100) return null;
    return `${year}-${pad2(month)}-${pad2(day)}`;
}

function detectCurrency(s) {
    if (/[€]/.test(s)) return '€';
    if (/[$]/.test(s)) return '$';
    if (/[₽]|RUB|руб/i.test(s)) return '₽';
    return '₽';
}

function parseAmount(s) {
    // Поддержка формата "Покупка: X.XX €"
    let m = s.match(/Покупка:\s*(\d+[.,]\d+)\s*€/i);
    if (m) {
        const num = m[1].replace(',', '.');
        const value = Number(num);
        if (Number.isFinite(value)) return Math.abs(value);
    }
    // Стандартный парсинг
    const cleaned = s.replace(/\u00A0/g, ' ').replace(/[^\d,.\- ]/g, ' ').trim();
    m = cleaned.match(/-?\d[\d ]*(?:[.,]\d{1,2})?/);
    if (!m) return null;
    const num = m[0].replace(/ /g, '').replace(',', '.');
    const value = Number(num);
    if (!Number.isFinite(value)) return null;
    return Math.abs(value);
}

function normalizeMerchant(s) {
    return s.toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/[^\p{L}\p{N} ]/gu, ' ')
        .replace(/\b(оплата|покупка|списание|карта|перевод|услуги|подписка)\b/giu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function titleize(s) {
    const t = s.trim();
    if (!t) return 'Подписка';
    return t.length > 40 ? `${t.slice(0, 40)}…` : t;
}

function parseStatementText(text) {
    // Объединяем многострочные записи в одну строку
    const normalized = text.replace(/\n\s*\n/g, '\n').replace(/\n/g, ' ');
    const lines = normalized.split(/Плати по миру/i).map(l => l.trim()).filter(l => l.length > 10);
    const fallbackYear = new Date().getFullYear();
    const tx = [];
    for (const rawLine of lines) {
        const dateIso = parseDateToIso(rawLine, fallbackYear);
        const amount = parseAmount(rawLine);
        if (!dateIso || amount == null) continue;
        // Извлекаем название компании
        let desc = rawLine;
        // Убираем дату
        desc = desc.replace(/\[.*?\]/g, ' ');
        desc = desc.replace(/\b(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?\b/g, ' ');
        // Убираем сумму и валюту
        desc = desc.replace(/Покупка:\s*\d+[.,]\d+\s*€/gi, ' ');
        desc = desc.replace(/-?\d[\d ]*(?:[.,]\d{1,2})?\s*€/g, ' ');
        desc = desc.replace(/Карта:\s*\*\d+/gi, ' ');
        desc = desc.replace(/Остаток:.*/gi, ' ');
        desc = desc.replace(/[₽$€]/g, ' ');
        desc = desc.replace(/\b(RUB|USD|EUR|руб|Плати по миру)\b/gi, ' ');
        desc = desc.replace(/\s+/g, ' ').trim();
        if (desc.length < 2) continue;
        tx.push({ date: dateIso, description: desc, amount, currency: detectCurrency(rawLine), raw: rawLine });
    }
    tx.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    return tx;
}

function addMonths(iso, months) {
    // Парсим дату напрямую из ISO строки (YYYY-MM-DD)
    const [year, month, day] = iso.split('-').map(Number);
    
    // Вычисляем новый год и месяц
    let newYear = year;
    let newMonth = month + months;
    
    // Корректируем год и месяц, если месяц выходит за границы
    while (newMonth > 12) {
        newMonth -= 12;
        newYear += 1;
    }
    while (newMonth < 1) {
        newMonth += 12;
        newYear -= 1;
    }
    
    // Определяем последний день целевого месяца
    const lastDayOfMonth = new Date(newYear, newMonth, 0).getDate();
    
    // Используем исходный день, если он существует в целевом месяце,
    // иначе используем последний день месяца
    const resultDay = Math.min(day, lastDayOfMonth);
    
    // Форматируем обратно в ISO строку
    const resultMonthStr = String(newMonth).padStart(2, '0');
    const resultDayStr = String(resultDay).padStart(2, '0');
    return `${newYear}-${resultMonthStr}-${resultDayStr}`;
}

function addYears(iso, years) {
    return addMonths(iso, years * 12);
}

function inferCycle(datesIso) {
    if (datesIso.length < 2) return { cycle: 'monthly', confidence: 'low' };
    const times = datesIso.map(d => new Date(d).getTime()).sort((a, b) => a - b);
    const diffsDays = [];
    for (let i = 1; i < times.length; i++) {
        diffsDays.push(Math.round((times[i] - times[i - 1]) / (1000 * 60 * 60 * 24)));
    }
    const monthLike = diffsDays.filter(x => x >= 28 && x <= 33).length;
    const yearLike = diffsDays.filter(x => x >= 350 && x <= 380).length;
    if (yearLike >= 1 && yearLike >= monthLike) {
        return { cycle: 'yearly', confidence: yearLike >= 2 ? 'high' : 'medium' };
    }
    if (monthLike >= 1) {
        return { cycle: 'monthly', confidence: monthLike >= 2 ? 'high' : 'medium' };
    }
    return { cycle: 'monthly', confidence: 'low' };
}

function buildSubscriptionCandidates(transactions) {
    const groups = new Map();
    for (const t of transactions) {
        const key = normalizeMerchant(t.description);
        if (!key) continue;
        const arr = groups.get(key) ?? [];
        arr.push(t);
        groups.set(key, arr);
    }
    const candidates = [];
    for (const [key, arr] of groups.entries()) {
        if (arr.length < 2) continue;
        const sorted = [...arr].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
        const last = sorted[sorted.length - 1];
        const { cycle, confidence } = inferCycle(sorted.map(t => t.date));
        candidates.push({
            key, name: titleize(sorted[0].description), currency: last.currency,
            lastAmount: last.amount, lastPaymentDate: last.date,
            inferredCycle: cycle, confidence, transactions: sorted
        });
    }
    const score = (c) => {
        const cScore = c.confidence === 'high' ? 3 : c.confidence === 'medium' ? 2 : 1;
        return cScore * 100 + c.transactions.length;
    };
    candidates.sort((a, b) => score(b) - score(a));
    return candidates;
}

function inferNextBillingDate(candidate) {
    if (candidate.inferredCycle === 'yearly') {
        return addYears(candidate.lastPaymentDate, 1);
    }
    return addMonths(candidate.lastPaymentDate, 1);
}

// Основное приложение
let subscriptions = [];
let currentFilter = 'all';
let editingId = null;
let viewMode = 'grid'; // 'grid' или 'list'

function formatDate(date) {
    return new Date(date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

function getMonthlyPrice(sub) {
    return sub.billingCycle === 'monthly' ? sub.price : sub.price / 12;
}

function renderStatistics() {
    const calculateMonthlyByCurrency = (group) => {
        const filtered = group 
            ? subscriptions.filter(s => s.group === group && !s.excludeFromStats)
            : subscriptions.filter(s => !s.excludeFromStats);
        const totals = {};
        filtered.forEach(sub => {
            const monthlyPrice = getMonthlyPrice(sub);
            totals[sub.currency] = (totals[sub.currency] || 0) + monthlyPrice;
        });
        return totals;
    };
    const formatTotals = (totals) => {
        return Object.entries(totals).map(([currency, amount]) => `${amount.toFixed(2)} ${currency}`).join(' + ') || '0 ₽';
    };
    const allTotals = calculateMonthlyByCurrency();
    const mineTotals = calculateMonthlyByCurrency('mine');
    const othersTotals = calculateMonthlyByCurrency('others');
    const upcomingCount = subscriptions.filter(sub => {
        const billingDate = new Date(sub.nextBillingDate);
        const today = new Date();
        const diffTime = billingDate.getTime() - today.getTime();
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        return diffDays <= 2 && diffDays >= 0;
    }).length;
    const statsHtml = `
        <h2>Статистика</h2>
        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-label">Всего подписок</div>
                <div class="stat-value">${subscriptions.filter(s => !s.excludeFromStats).length}</div>
            </div>
            <div class="stat-card primary">
                <div class="stat-label">Всего в месяц</div>
                <div class="stat-value stat-value-multi">${formatTotals(allTotals)}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Мои подписки</div>
                <div class="stat-value stat-value-multi">${formatTotals(mineTotals)}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Для других</div>
                <div class="stat-value stat-value-multi">${formatTotals(othersTotals)}</div>
            </div>
            ${upcomingCount > 0 ? `
            <div class="stat-card warning">
                <div class="stat-label">Скоро списание</div>
                <div class="stat-value">${upcomingCount}</div>
            </div>` : ''}
        </div>
    `;
    document.getElementById('statistics').innerHTML = statsHtml;
}

function renderSubscriptions() {
    const filtered = currentFilter === 'all' 
        ? subscriptions 
        : subscriptions.filter(s => s.group === currentFilter);
    const sorted = [...filtered].sort((a, b) => 
        new Date(a.nextBillingDate).getTime() - new Date(b.nextBillingDate).getTime()
    );
    const container = document.getElementById('subscriptions-container');
    container.className = viewMode === 'list' ? 'subscriptions-list' : 'subscriptions-grid';
    
    if (sorted.length === 0) {
        container.innerHTML = '<div class="empty-state"><p>Пока нет подписок. Добавьте первую!</p></div>';
        return;
    }
    container.innerHTML = sorted.map(sub => {
        const billingDate = new Date(sub.nextBillingDate);
        const today = new Date();
        const diffTime = billingDate.getTime() - today.getTime();
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        const isUpcoming = diffDays <= 2 && diffDays >= 0;
        const isOverdue = diffDays < 0;
        const monthlyPrice = getMonthlyPrice(sub);
        let daysText = '';
        if (diffDays >= 0) {
            if (diffDays === 0) daysText = 'Сегодня!';
            else if (diffDays === 1) daysText = 'Завтра!';
            else if (diffDays === 2) daysText = 'Через 2 дня';
            else daysText = `через ${diffDays} ${diffDays === 1 ? 'день' : diffDays < 5 ? 'дня' : 'дней'}`;
        } else {
            daysText = 'Просрочено!';
        }
        return `
            <div class="subscription-card ${isUpcoming ? 'upcoming' : ''} ${isOverdue ? 'overdue' : ''}">
                <div class="card-header">
                    <h3>${escapeHtml(sub.name)}</h3>
                    <div class="card-actions">
                        <button class="icon-btn" data-edit-id="${sub.id}" title="Редактировать">✏️</button>
                        <button class="icon-btn" data-delete-id="${sub.id}" title="Удалить">🗑️</button>
                    </div>
                </div>
                <div class="card-content">
                    <div class="price-info">
                        <span class="price">${sub.price} ${sub.currency}</span>
                        <span class="billing-cycle">${sub.billingCycle === 'monthly' ? 'в месяц' : 'в год'}</span>
                    </div>
                    <div class="monthly-price">~${monthlyPrice.toFixed(2)} ${sub.currency}/мес</div>
                    <div class="billing-date">
                        <span class="label">Следующее списание:</span>
                        <span class="date ${isUpcoming ? 'warning' : ''} ${isOverdue ? 'error' : ''}">${formatDate(billingDate)}</span>
                        <span class="days-left ${isOverdue ? 'error' : ''}">${daysText}</span>
                    </div>
                    ${sub.notes ? `
                    <div class="notes">
                        <span class="label">Заметки:</span>
                        <span>${escapeHtml(sub.notes)}</span>
                    </div>` : ''}
                </div>
                <div class="card-footer">
                    ${sub.excludeFromStats ? '<span class="badge badge-excluded">Не в статистике</span>' : ''}
                    <span class="badge ${sub.group === 'mine' ? 'badge-mine' : 'badge-others'}">
                        ${sub.group === 'mine' ? 'Мои подписки' : 'Для других'}
                    </span>
                </div>
            </div>
        `;
    }).join('');
    // Добавляем обработчики для кнопок редактирования и удаления
    container.querySelectorAll('[data-edit-id]').forEach(btn => {
        btn.onclick = () => editSubscription(btn.dataset.editId);
    });
    container.querySelectorAll('[data-delete-id]').forEach(btn => {
        btn.onclick = () => deleteSubscription(btn.dataset.deleteId);
    });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function render() {
    renderStatistics();
    renderSubscriptions();
}

function openForm(sub = null) {
    editingId = sub ? sub.id : null;
    document.getElementById('form-title').textContent = sub ? 'Редактировать подписку' : 'Добавить подписку';
    if (sub) {
        document.getElementById('name').value = sub.name;
        document.getElementById('price').value = sub.price;
        document.getElementById('currency').value = sub.currency;
        document.getElementById('nextBillingDate').value = sub.nextBillingDate;
        document.getElementById('billingCycle').value = sub.billingCycle;
        document.getElementById('group').value = sub.group;
        document.getElementById('excludeFromStats').checked = sub.excludeFromStats || false;
        document.getElementById('notes').value = sub.notes || '';
    } else {
        document.getElementById('subscription-form').reset();
        document.getElementById('nextBillingDate').value = new Date().toISOString().split('T')[0];
        document.getElementById('excludeFromStats').checked = false;
    }
    document.getElementById('form-modal').style.display = 'flex';
}

function closeForm() {
    document.getElementById('form-modal').style.display = 'none';
    editingId = null;
}

function handleFormSubmit(e) {
    e.preventDefault();
    try {
        const sub = {
            id: editingId || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            name: document.getElementById('name').value.trim(),
            price: parseFloat(document.getElementById('price').value) || 0,
            currency: document.getElementById('currency').value,
            nextBillingDate: document.getElementById('nextBillingDate').value,
            billingCycle: document.getElementById('billingCycle').value,
            group: document.getElementById('group').value,
            excludeFromStats: document.getElementById('excludeFromStats').checked,
            notes: document.getElementById('notes').value.trim()
        };
        if (editingId) {
            subscriptions = subscriptions.map(s => s.id === editingId ? sub : s);
        } else {
            subscriptions.push(sub);
        }
        saveSubscriptions(subscriptions);
        render();
        checkUpcomingBilling(subscriptions);
        closeForm();
    } catch (err) {
        console.error('Ошибка при сохранении:', err);
        alert('Произошла ошибка при сохранении подписки');
    }
}

function editSubscription(id) {
    const sub = subscriptions.find(s => s.id === id);
    if (sub) openForm(sub);
}

function deleteSubscription(id) {
    if (confirm('Вы уверены, что хотите удалить эту подписку?')) {
        subscriptions = subscriptions.filter(s => s.id !== id);
        saveSubscriptions(subscriptions);
        render();
    }
}

function setFilter(filter) {
    currentFilter = filter;
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.filter === filter);
    });
    renderSubscriptions();
}

function setViewMode(mode) {
    viewMode = mode;
    document.getElementById('view-grid').classList.toggle('active', mode === 'grid');
    document.getElementById('view-list').classList.toggle('active', mode === 'list');
    renderSubscriptions();
}

// Импорт
let importFiles = [];
let importCandidates = [];

function openImport() {
    document.getElementById('import-modal').style.display = 'flex';
    importFiles = [];
    importCandidates = [];
    document.getElementById('file-input').value = '';
    document.getElementById('text-input').value = '';
    document.getElementById('import-files-list').innerHTML = '';
    document.getElementById('import-results').innerHTML = '';
    document.getElementById('import-raw').style.display = 'none';
    document.getElementById('import-progress').textContent = '';
    document.getElementById('btn-ocr').disabled = true;
    document.getElementById('btn-parse-text').disabled = true;
}

function closeImport() {
    document.getElementById('import-modal').style.display = 'none';
}

function handleFileSelect(e) {
    importFiles = Array.from(e.target.files || []);
    document.getElementById('btn-ocr').disabled = importFiles.length === 0;
    const filesList = document.getElementById('import-files-list');
    filesList.innerHTML = importFiles.map(f => 
        `<span class="file-chip">${escapeHtml(f.name)}</span>`
    ).join('');
}

function handleTextInput() {
    const text = document.getElementById('text-input').value.trim();
    document.getElementById('btn-parse-text').disabled = text.length < 10;
}

async function runOCR() {
    if (importFiles.length === 0) return;
    if (typeof Tesseract === 'undefined') {
        alert('Библиотека OCR не загружена. Пожалуйста, проверьте подключение к интернету и обновите страницу.');
        return;
    }
    const progressEl = document.getElementById('import-progress');
    progressEl.textContent = 'Подготовка…';
    document.getElementById('btn-ocr').disabled = true;
    try {
        let full = '';
        for (let i = 0; i < importFiles.length; i++) {
            const f = importFiles[i];
            progressEl.textContent = `Распознаю ${i + 1} из ${importFiles.length}: ${f.name}`;
            const { data } = await Tesseract.recognize(f, 'rus+eng', {
                logger: m => {
                    if (m.status === 'recognizing text' && m.progress) {
                        const pct = Math.round(m.progress * 100);
                        progressEl.textContent = `Распознаю ${i + 1}/${importFiles.length}: ${f.name} (${pct}%)`;
                    }
                }
            });
            full += `\n${data.text}\n`;
        }
        parseFromText(full.trim());
    } catch (err) {
        progressEl.textContent = `Ошибка: ${err.message}`;
        console.error('OCR ошибка:', err);
    } finally {
        document.getElementById('btn-ocr').disabled = false;
    }
}

function parseFromText(text) {
    const progressEl = document.getElementById('import-progress');
    progressEl.textContent = 'Разбираю операции…';
    const tx = parseStatementText(text);
    importCandidates = buildSubscriptionCandidates(tx);
    progressEl.textContent = importCandidates.length 
        ? `Найдено кандидатов: ${importCandidates.length}`
        : 'Не удалось уверенно выделить подписки (проверьте, что в строках есть дата и сумма).';
    renderImportResults();
    document.getElementById('import-raw-text').textContent = text;
    document.getElementById('import-raw').style.display = text ? 'block' : 'none';
}

function renderImportResults() {
    const resultsEl = document.getElementById('import-results');
    if (importCandidates.length === 0) {
        resultsEl.innerHTML = '';
        return;
    }
    const group = document.getElementById('import-group').value;
    resultsEl.innerHTML = `
        <h3>Найденные подписки (кандидаты)</h3>
        <div class="candidate-list">
            ${importCandidates.map(c => `
                <div class="candidate">
                    <div class="candidate-name">${escapeHtml(c.name)}</div>
                    <div class="candidate-meta">
                        Последнее списание: <b>${c.lastPaymentDate}</b> • ~${c.lastAmount.toFixed(2)} ${c.currency} • цикл: 
                        <b>${c.inferredCycle === 'monthly' ? 'ежемесячно' : 'ежегодно'}</b> • уверенность: <b>${c.confidence}</b>
                    </div>
                    <div class="candidate-next">
                        Следующее списание (предполож.): <b>${inferNextBillingDate(c)}</b>
                    </div>
                </div>
            `).join('')}
        </div>
        <div class="import-actions">
            <button class="import-apply" id="import-apply-btn">Импортировать</button>
            <button class="import-cancel" id="import-cancel-btn">Отмена</button>
        </div>
    `;
}

function applyImport() {
    const group = document.getElementById('import-group').value;
    const existingByName = new Map();
    subscriptions.forEach(s => existingByName.set(s.name.toLowerCase(), s));
    importCandidates.forEach(c => {
        const nextBillingDate = inferNextBillingDate(c);
        const existingSame = existingByName.get(c.name.toLowerCase());
        const sub = {
            id: existingSame?.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            name: c.name,
            price: c.lastAmount,
            currency: c.currency,
            nextBillingDate,
            billingCycle: c.inferredCycle,
            group: existingSame?.group || group,
            excludeFromStats: existingSame?.excludeFromStats || false,
            notes: (existingSame?.notes ? `${existingSame.notes}\n` : '') +
                `Импортировано из выписки. Последнее списание: ${c.lastPaymentDate}. Уверенность: ${c.confidence}.`
        };
        const index = subscriptions.findIndex(s => s.id === sub.id);
        if (index >= 0) {
            subscriptions[index] = sub;
        } else {
            subscriptions.push(sub);
        }
    });
    saveSubscriptions(subscriptions);
    render();
    checkUpcomingBilling(subscriptions);
    closeImport();
}

// Переключение стилей
const THEME_STORAGE_KEY = 'subscription-tracker-theme';

function setTheme(theme) {
    const mainStylesheet = document.getElementById('main-stylesheet');
    const pixelStylesheet = document.getElementById('pixel-art-stylesheet');
    const natureBtn = document.getElementById('theme-nature');
    const pixelBtn = document.getElementById('theme-pixel');
    
    if (theme === 'pixel') {
        mainStylesheet.disabled = true;
        pixelStylesheet.disabled = false;
        if (natureBtn) natureBtn.classList.remove('active');
        if (pixelBtn) pixelBtn.classList.add('active');
    } else {
        mainStylesheet.disabled = false;
        pixelStylesheet.disabled = true;
        if (natureBtn) natureBtn.classList.add('active');
        if (pixelBtn) pixelBtn.classList.remove('active');
    }
    
    localStorage.setItem(THEME_STORAGE_KEY, theme);
}

function initTheme() {
    const savedTheme = localStorage.getItem(THEME_STORAGE_KEY) || 'nature';
    setTheme(savedTheme);
    
    // Обработчики переключения темы
    const natureBtn = document.getElementById('theme-nature');
    const pixelBtn = document.getElementById('theme-pixel');
    
    if (natureBtn) {
        natureBtn.onclick = () => setTheme('nature');
    }
    if (pixelBtn) {
        pixelBtn.onclick = () => setTheme('pixel');
    }
}

// Инициализация
function init() {
    try {
        console.log('Инициализация приложения...');
        initTheme();
        subscriptions = loadSubscriptions();
        console.log('Загружено подписок:', subscriptions.length);
        render();
        console.log('Рендеринг завершен');
        requestNotificationPermission();
        checkUpcomingBilling(subscriptions);
        setInterval(() => {
            subscriptions = loadSubscriptions();
            checkUpcomingBilling(subscriptions);
        }, 30 * 60 * 1000);
        
        // Обработчики событий
        const btnAdd = document.getElementById('btn-add');
        const btnImport = document.getElementById('btn-import');
        const btnAutoImport = document.getElementById('btn-auto-import');
        if (!btnAdd || !btnImport) {
            throw new Error('Не найдены кнопки управления');
        }
        btnAdd.onclick = () => openForm();
        btnImport.onclick = openImport;
        
        // Переключатели режима отображения
        document.getElementById('view-grid').onclick = () => setViewMode('grid');
        document.getElementById('view-list').onclick = () => setViewMode('list');
        document.querySelectorAll('.filter-btn').forEach(btn => {
            btn.onclick = () => setFilter(btn.dataset.filter);
        });
        document.getElementById('file-input').onchange = handleFileSelect;
        document.getElementById('text-input').oninput = handleTextInput;
        document.getElementById('btn-ocr').onclick = runOCR;
        document.getElementById('btn-parse-text').onclick = () => {
            parseFromText(document.getElementById('text-input').value.trim());
        };
        document.getElementById('subscription-form').onsubmit = handleFormSubmit;
        document.getElementById('form-close-btn').onclick = closeForm;
        document.getElementById('form-cancel-btn').onclick = closeForm;
        document.getElementById('import-close-btn').onclick = closeImport;
        
        // Обработчики для динамически создаваемых кнопок импорта
        document.addEventListener('click', (e) => {
            if (e.target.id === 'import-apply-btn') {
                applyImport();
            } else if (e.target.id === 'import-cancel-btn') {
                closeImport();
            }
        });
        
        // Закрытие модальных окон по клику вне области
        document.getElementById('form-modal').onclick = (e) => {
            if (e.target.id === 'form-modal') closeForm();
        };
        document.getElementById('import-modal').onclick = (e) => {
            if (e.target.id === 'import-modal') closeImport();
        };
        console.log('Инициализация завершена успешно');
        
        // Функция для автоматического импорта подписок
        window.autoImportSubscriptions = function() {
            // Актуальные данные подписок
            const subscriptionsData = [
                { name: 'KREA.AI INC', price: 8.78, currency: '€', lastPayment: '2026-01-01', cycle: 'monthly' },
                { name: 'MIDJOURNEY INC.', price: 8.85, currency: '€', lastPayment: '2026-01-14', cycle: 'monthly' },
                { name: 'WWW.PERPLEXITY.AI', price: 17.45, currency: '€', lastPayment: '2026-01-21', cycle: 'monthly' },
                { name: 'OPENAI *CHATGPT SUBSCR', price: 17.26, currency: '€', lastPayment: '2025-12-29', cycle: 'monthly' },
                { name: 'OBSIDIAN', price: 4.54, currency: '€', lastPayment: '2026-01-06', cycle: 'monthly' },
                { name: 'OPENROUTER, INC', price: 9.38, currency: '€', lastPayment: '2026-01-27', cycle: 'monthly' },
                { name: 'CURSOR, AI POWERED IDE', price: 17.15, currency: '€', lastPayment: '2026-01-27', cycle: 'monthly' }
            ];
            
            const existingByName = new Map();
            subscriptions.forEach(s => existingByName.set(s.name.toLowerCase(), s));
            
            let imported = 0;
            subscriptionsData.forEach(data => {
                // Вычисляем следующую дату списания
                const nextBillingDate = data.cycle === 'yearly' 
                    ? addYears(data.lastPayment, 1)
                    : addMonths(data.lastPayment, 1);
                
                const existingSame = existingByName.get(data.name.toLowerCase());
                const sub = {
                    id: existingSame?.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
                    name: data.name,
                    price: data.price,
                    currency: data.currency,
                    nextBillingDate: nextBillingDate,
                    billingCycle: data.cycle,
                    group: existingSame?.group || 'mine',
                    excludeFromStats: existingSame?.excludeFromStats || false,
                    notes: existingSame?.notes || `Импортировано. Последнее списание: ${data.lastPayment}.`
                };
                
                const index = subscriptions.findIndex(s => s.id === sub.id);
                if (index >= 0) {
                    subscriptions[index] = sub;
                } else {
                    subscriptions.push(sub);
                    imported++;
                }
            });
            
            saveSubscriptions(subscriptions);
            render();
            checkUpcomingBilling(subscriptions);
            
            alert(`Импортировано ${imported} новых подписок! Всего подписок: ${subscriptions.length}`);
        };
        console.log('Для импорта подписок выполните в консоли: autoImportSubscriptions()');
    } catch (err) {
        console.error('Ошибка инициализации:', err);
        document.body.innerHTML = `
            <div style="padding: 20px; text-align: center; color: red;">
                <h1>Ошибка загрузки приложения</h1>
                <p>${err.message}</p>
                <p>Пожалуйста, откройте консоль браузера (F12) для подробностей.</p>
                <pre>${err.stack}</pre>
            </div>
        `;
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
