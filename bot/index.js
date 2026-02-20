/**
 * Telegram-бот для трекера подписок.
 * - Уведомления за 2 дня до списания
 * - /list — список подписок по дате (от ближайшего к дальнему)
 * - /add, /delete — добавление и удаление подписок
 * - /link_КОД — привязка к аккаунту (код из веб-приложения)
 */

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const admin = require('firebase-admin');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TZ = process.env.TZ || 'Europe/Moscow';

if (!BOT_TOKEN) {
  console.error('Укажите TELEGRAM_BOT_TOKEN в .env');
  process.exit(1);
}

// Firebase Admin (сервисный аккаунт из файла или из переменной)
let app;
if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  app = admin.initializeApp({ credential: admin.credential.applicationDefault() });
} else if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  const cred = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  app = admin.initializeApp({ credential: admin.credential.cert(cred) });
} else {
  console.error('Укажите GOOGLE_APPLICATION_CREDENTIALS или FIREBASE_SERVICE_ACCOUNT_JSON');
  process.exit(1);
}

const db = admin.firestore();
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Состояние диалога для /add: chatId -> { step, name?, price?, currency?, nextBillingDate?, billingCycle? }
const addState = new Map();

// ——— Получение uid по chatId ———
async function getUidByChatId(chatId) {
  const snap = await db.collection('users').where('telegramChatId', '==', Number(chatId)).limit(1).get();
  if (snap.empty) return null;
  return snap.docs[0].id;
}

async function getSubscriptions(uid) {
  const doc = await db.collection('users').doc(uid).get();
  if (!doc.exists) return [];
  const data = doc.data();
  const subs = data.subscriptions || [];
  return Array.isArray(subs) ? subs : [];
}

function sortByNextBilling(subs) {
  return [...subs].sort((a, b) => {
    const da = new Date(a.nextBillingDate || 0).getTime();
    const db_ = new Date(b.nextBillingDate || 0).getTime();
    return da - db_;
  });
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

function getCategoryEmoji(category) {
  return category === 'on-the-way-out' ? '🔲' : '🟧';
}

function formatList(subs) {
  if (subs.length === 0) return '📭 Подписок пока нет. Добавьте через /add или в веб-приложении.';
  const sorted = sortByNextBilling(subs);
  const lines = sorted.map((s, i) => {
    const d = new Date(s.nextBillingDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    d.setHours(0, 0, 0, 0);
    const diffDays = Math.ceil((d - today) / (1000 * 60 * 60 * 24));
    let daysText = '';
    if (diffDays === 0) daysText = 'сегодня';
    else if (diffDays === 1) daysText = 'завтра';
    else if (diffDays > 0) daysText = `через ${diffDays} дн.`;
    else daysText = 'просрочено';
    const dateStr = formatDate(s.nextBillingDate);
    const priceStr = `${s.price} ${s.currency || '₽'}`;
    const emoji = getCategoryEmoji(s.category);
    return `${i + 1}. ${emoji} **${escapeMarkdown(s.name)}** — **${escapeMarkdown(priceStr)}**  - ${daysText} (${dateStr} г.)`;
  });
  return '📋 **Подписки** (от ближайшего к дальнему):\n🟧 нужные · 🔲 на-вылет\n\n' + lines.join('\n');
}

function escapeMarkdown(s) {
  if (!s) return '';
  return String(s).replace(/([_*[\]()~`>#+=|{}.!-])/g, '\\$1');
}

// ——— Сохранение подписок в Firestore ———
async function saveSubscriptions(uid, subscriptions) {
  await db.collection('users').doc(uid).set(
    { subscriptions, lastUpdated: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
}

// ——— Команда /start ———
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const uid = await getUidByChatId(chatId);
  if (uid) {
    await bot.sendMessage(chatId, '👋 Вы уже привязаны к аккаунту.\n\nКоманды:\n/list — список подписок\n/add — добавить подписку\n/delete — удалить подписку\n/delete_НОМЕР — удалить по номеру из списка', { parse_mode: 'Markdown' });
  } else {
    await bot.sendMessage(
      chatId,
      '👋 Привет! Я бот трекера подписок.\n\nЧтобы привязать этот чат к аккаунту:\n1. Откройте веб-приложение и войдите в аккаунт.\n2. Нажмите «Привязать Telegram» и получите код.\n3. Отправьте мне: /link_КОД\n\nПример: /link_123456',
      { parse_mode: 'Markdown' }
    );
  }
});

// ——— Команда /link_КОД ———
bot.onText(/\/link_(\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const code = match[1].trim();
  const codeDoc = await db.collection('link_codes').doc(code).get();
  if (!codeDoc.exists) {
    await bot.sendMessage(chatId, '❌ Код не найден или уже использован. Получите новый код в веб-приложении.');
    return;
  }
  const { uid, expiresAt } = codeDoc.data();
  const expires = expiresAt && (expiresAt.toMillis ? expiresAt.toMillis() : expiresAt);
  if (expires && Date.now() > expires) {
    await db.collection('link_codes').doc(code).delete();
    await bot.sendMessage(chatId, '❌ Код истёк. Получите новый код в веб-приложении.');
    return;
  }
  await db.collection('users').doc(uid).set({ telegramChatId: Number(chatId) }, { merge: true });
  await db.collection('link_codes').doc(code).delete();
  await bot.sendMessage(chatId, '✅ Аккаунт привязан! Теперь вы можете использовать /list, /add, /delete и получать напоминания за 2 дня до списания.');
});

// ——— Команда /list ———
bot.onText(/\/list/, async (msg) => {
  const chatId = msg.chat.id;
  const uid = await getUidByChatId(chatId);
  if (!uid) {
    await bot.sendMessage(chatId, 'Сначала привяжите аккаунт: /link_КОД (код берёте в веб-приложении).');
    return;
  }
  const subs = await getSubscriptions(uid);
  await bot.sendMessage(chatId, formatList(subs), { parse_mode: 'HTML' });
});

// ——— Отмена текущего действия ———
bot.onText(/\/(cancel|отмена)/i, (msg) => {
  const chatId = msg.chat.id;
  if (addState.has(chatId)) {
    addState.delete(chatId);
    bot.sendMessage(chatId, 'Отменено.');
  }
});

// ——— Команда /add (пошаговый ввод) ———
bot.onText(/\/add/, async (msg) => {
  const chatId = msg.chat.id;
  const uid = await getUidByChatId(chatId);
  if (!uid) {
    await bot.sendMessage(chatId, 'Сначала привяжите аккаунт: /link_КОД');
    return;
  }
  addState.set(chatId, { step: 'name' });
  await bot.sendMessage(chatId, 'Введите **название** подписки (например: Netflix):', { parse_mode: 'Markdown' });
});

// Обработка ответов в режиме /add
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  if (msg.entities?.some((e) => e.type === 'bot_command')) return; // команды обрабатываются отдельно

  const state = addState.get(chatId);
  if (!state) return;

  const uid = await getUidByChatId(chatId);
  if (!uid) {
    addState.delete(chatId);
    return;
  }

  if (state.step === 'name') {
    state.name = text;
    state.step = 'price';
    await bot.sendMessage(chatId, 'Введите **цену** (число, например 399):', { parse_mode: 'Markdown' });
    return;
  }
  if (state.step === 'price') {
    const price = parseFloat(text.replace(',', '.'));
    if (Number.isNaN(price) || price < 0) {
      await bot.sendMessage(chatId, 'Введите число (например 399 или 9.99):');
      return;
    }
    state.price = price;
    state.step = 'currency';
    await bot.sendMessage(chatId, 'Введите **валюту**: ₽ , $ или €', { parse_mode: 'Markdown' });
    return;
  }
  if (state.step === 'currency') {
    const cur = text.replace(/руб|rub/gi, '₽').trim();
    const currency = cur === '₽' || cur === '$' || cur === '€' ? cur : '₽';
    state.currency = currency;
    state.step = 'date';
    await bot.sendMessage(chatId, 'Введите **дату следующего списания** в формате ГГГГ-ММ-ДД (например 2026-03-15):', { parse_mode: 'Markdown' });
    return;
  }
  if (state.step === 'date') {
    const dateMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!dateMatch) {
      await bot.sendMessage(chatId, 'Формат: ГГГГ-ММ-ДД (например 2026-03-15):');
      return;
    }
    state.nextBillingDate = text;
    state.step = 'cycle';
    await bot.sendMessage(chatId, 'Введите **период**: monthly (в месяц) или yearly (в год):', { parse_mode: 'Markdown' });
    return;
  }
  if (state.step === 'cycle') {
    const cycle = /year|год/i.test(text) ? 'yearly' : 'monthly';
    state.billingCycle = cycle;
    state.step = 'category';
    await bot.sendMessage(chatId, 'Категория: **нужная** (🟧) или **на-вылет** (🔲)? Ответьте: needed или out', { parse_mode: 'Markdown' });
    return;
  }
  if (state.step === 'category') {
    const category = /out|вылет/i.test(text) ? 'on-the-way-out' : 'needed';
    state.category = category;
    addState.delete(chatId);

    const subs = await getSubscriptions(uid);
    const newSub = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      name: state.name,
      price: state.price,
      currency: state.currency || '₽',
      nextBillingDate: state.nextBillingDate,
      billingCycle: state.billingCycle || 'monthly',
      group: 'mine',
      category: state.category || 'needed',
      excludeFromStats: false,
      notes: ''
    };
    subs.push(newSub);
    await saveSubscriptions(uid, subs);
    const emoji = getCategoryEmoji(category);
    await bot.sendMessage(chatId, `✅ Подписка ${emoji} **${escapeMarkdown(state.name)}** добавлена.`, { parse_mode: 'Markdown' });
  }
});

// ——— Команда /delete и /delete_НОМЕР ———
bot.onText(/\/delete(?:_(\d+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const numArg = match[1];
  const uid = await getUidByChatId(chatId);
  if (!uid) {
    await bot.sendMessage(chatId, 'Сначала привяжите аккаунт: /link_КОД');
    return;
  }
  const subs = sortByNextBilling(await getSubscriptions(uid));
  if (subs.length === 0) {
    await bot.sendMessage(chatId, 'Нет подписок для удаления.');
    return;
  }
  if (numArg) {
    const idx = parseInt(numArg, 10);
    if (idx < 1 || idx > subs.length) {
      await bot.sendMessage(chatId, `Укажите номер от 1 до ${subs.length}.`);
      return;
    }
    const toRemove = subs[idx - 1];
    const newSubs = (await getSubscriptions(uid)).filter((s) => s.id !== toRemove.id);
    await saveSubscriptions(uid, newSubs);
    await bot.sendMessage(chatId, `🗑 Подписка «${toRemove.name}» удалена.`);
    return;
  }
  const buttons = subs.slice(0, 15).map((s, i) => {
    const emoji = getCategoryEmoji(s.category);
    return [{ text: `${i + 1}. ${emoji} ${s.name}`, callback_data: `del_${s.id}` }];
  });
  await bot.sendMessage(chatId, 'Выберите подписку для удаления (или отправьте /delete_НОМЕР):', {
    reply_markup: { inline_keyboard: [...buttons, [{ text: 'Отмена', callback_data: 'del_cancel' }]] }
  });
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  if (!data.startsWith('del_')) return;
  await bot.answerCallbackQuery(query.id);
  if (data === 'del_cancel') {
    await bot.editMessageText('Отменено.', { chat_id: chatId, message_id: query.message.message_id });
    return;
  }
  const subId = data.replace('del_', '');
  const uid = await getUidByChatId(chatId);
  if (!uid) return;
  const subs = await getSubscriptions(uid);
  const sub = subs.find((s) => s.id === subId);
  if (!sub) {
    await bot.editMessageText('Подписка уже удалена или не найдена.', { chat_id: chatId, message_id: query.message.message_id });
    return;
  }
  const newSubs = subs.filter((s) => s.id !== subId);
  await saveSubscriptions(uid, newSubs);
  await bot.editMessageText(`🗑 Подписка «${sub.name}» удалена.`, { chat_id: chatId, message_id: query.message.message_id });
});

// ——— Ежедневная проверка: уведомления за 2 дня до списания ———
function getDateInDays(days) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

cron.schedule(
  '0 9 * * *',
  async () => {
    const targetDate = getDateInDays(2);
    const usersSnap = await db.collection('users').get();
    for (const doc of usersSnap.docs) {
      const chatId = doc.data().telegramChatId;
      if (!chatId) continue;
      const subs = (doc.data().subscriptions || []).filter((s) => s.nextBillingDate === targetDate);
      if (subs.length === 0) continue;
      const lines = subs.map((s) => {
        const emoji = getCategoryEmoji(s.category);
        return `• ${emoji} ${s.name} — ${s.price} ${s.currency || '₽'}`;
      });
      const text = `⏰ Через 2 дня списание:\n\n${lines.join('\n')}`;
      try {
        await bot.sendMessage(chatId, text);
      } catch (e) {
        console.warn('Не удалось отправить уведомление в', chatId, e.message);
      }
    }
  },
  { timezone: TZ }
);

console.log('Бот запущен. Ожидаю сообщения...');
