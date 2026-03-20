const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const token = process.env.BOT_TOKEN;
const adminId = process.env.ADMIN_CHAT_ID;
const bot = new TelegramBot(token, { polling: true });

// --- ХРАНИЛИЩА ДАННЫХ ---
const messageMap = new Map(); // ТГ Msg ID -> { clientId, text } (храним текст для причины бана)
const pendingMessages = new Map(); // Client ID -> [{text, timestamp, isWarning}]
const EXPIRATION_TIME = 60 * 60 * 1000; // 1 час для очереди

// НОВЫЕ ХРАНИЛИЩА:
const nicknames = new Map(); // Client ID -> Nickname
const bannedUsers = new Map(); // Client ID -> { expireAt, reasonText, durationText }

// --- ВЕБ-СОКЕТЫ (САЙТ) ---
io.on('connection', (socket) => {
    
    socket.on('register_client', (clientId) => {
        socket.join(clientId);
        console.log(`User connected: ${clientId}`);

        // Проверяем, не в бане ли юзер при заходе
        if (bannedUsers.has(clientId)) {
            const banInfo = bannedUsers.get(clientId);
            if (banInfo.expireAt === 0 || banInfo.expireAt > Date.now()) {
                socket.emit('ban_status', { isBanned: true });
            } else {
                bannedUsers.delete(clientId); // Бан истек
                socket.emit('ban_status', { isBanned: false });
            }
        }

        // Проверяем очередь сообщений
        if (pendingMessages.has(clientId)) {
            const userQueue = pendingMessages.get(clientId);
            const now = Date.now();
            const validMessages = [];

            userQueue.forEach(msgObj => {
                if (now - msgObj.timestamp < EXPIRATION_TIME) {
                    validMessages.push(msgObj);
                }
            });

            if (validMessages.length > 0) {
                validMessages.forEach(msg => {
                    socket.emit('receive_message', { text: msg.text, isWarning: msg.isWarning });
                });
                bot.sendMessage(adminId, `🔔 <b>Юзер вернулся!</b>\nПользователь <code>${clientId}</code> получил свои сообщения.`, { parse_mode: 'HTML' });
            }
            pendingMessages.delete(clientId);
        }
    });

    socket.on('send_message', (data) => {
        // Если юзер в бане, блокируем отправку на сервере
        if (bannedUsers.has(data.clientId)) {
            const banInfo = bannedUsers.get(data.clientId);
            if (banInfo.expireAt === 0 || banInfo.expireAt > Date.now()) return;
            else bannedUsers.delete(data.clientId);
        }

        const nick = nicknames.get(data.clientId) ? ` (<b>${nicknames.get(data.clientId)}</b>)` : '';
        const tgMessage = `
🌐 <b>Новый запрос с сайта!</b>

💬 <i>«${data.text}»</i>

👤 ID: <code>${data.clientId}</code>${nick}
➖➖➖➖➖➖➖➖➖
💡 <i>Ответь, используй /nick, /ban 1h, /ban perm или Spam:</i>`;

        const options = {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [[{ text: "Spam ⚠️", callback_data: `spam_${data.clientId}` }]]
            }
        };

        bot.sendMessage(adminId, tgMessage, options)
        .then((msg) => {
            // Сохраняем и ID, и текст (чтобы знать причину бана)
            messageMap.set(msg.message_id, { clientId: data.clientId, text: data.text });
        });
    });
});

// --- КНОПКИ (SPAM И МЕНЮ БАНОВ) ---
bot.on('callback_query', (query) => {
    const userId = query.from.id.toString();
    if (userId !== adminId.toString()) {
        return bot.answerCallbackQuery(query.id, { text: "Доступ запрещён!", show_alert: true });
    }

    // 1. Кнопка SPAM
    if (query.data.startsWith('spam_')) {
        const clientId = query.data.replace('spam_', '');
        const spamText = "Пожалуйста, не присылайте сообщения которые не имеют смысл или не связаны с темой сайта.";
        
        sendToUser(clientId, spamText, true, query.message.message_id, "Spam-фильтр");

        bot.editMessageReplyMarkup({ inline_keyboard: [] }, { 
            chat_id: query.message.chat.id, message_id: query.message.message_id 
        });
        bot.answerCallbackQuery(query.id, { text: "Предупреждение отправлено" });
    }

    // 2. Инфо о забаненном
    if (query.data.startsWith('baninfo_')) {
        const clientId = query.data.replace('baninfo_', '');
        const info = bannedUsers.get(clientId);
        const nick = nicknames.get(clientId) || "Без ника";
        
        if (!info) return bot.answerCallbackQuery(query.id, {text: "Пользователь уже разбанен"});

        const text = `👤 <b>${nick}</b> (<code>${clientId}</code>)\n\n💬 <b>Причина:</b> <i>"${info.reasonText}"</i>\n⏳ <b>Срок:</b> ${info.durationText}`;
        const opts = {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [{text: "🔓 Разблокировать", callback_data: `unban_${clientId}`}],
                    [{text: "🔙 Назад к списку", callback_data: `banlist`}]
                ]
            }
        };
        bot.editMessageText(text, {chat_id: adminId, message_id: query.message.message_id, ...opts});
    }

    // 3. Возврат к списку банов
    if (query.data === 'banlist') {
        sendBannedMenu(adminId, query.message.message_id);
    }

    // 4. Разбан
    if (query.data.startsWith('unban_')) {
        const clientId = query.data.replace('unban_', '');
        bannedUsers.delete(clientId);
        io.to(clientId).emit('ban_status', { isBanned: false }); // Снимаем замок на сайте
        
        bot.answerCallbackQuery(query.id, {text: "Разблокирован!"});
        sendBannedMenu(adminId, query.message.message_id); // Обновляем список
    }
});

// --- ОТВЕТЫ И КОМАНДЫ ИЗ ТЕЛЕГРАМ ---
bot.on('message', (msg) => {
    const text = msg.text || '';

    // Меню банов по команде /bans
    if (text === '/bans' && msg.from.id.toString() === adminId.toString()) {
        sendBannedMenu(msg.chat.id);
        return;
    }

    // Обработка реплая на сообщение бота
    if (msg.reply_to_message && messageMap.has(msg.reply_to_message.message_id)) {
        const targetData = messageMap.get(msg.reply_to_message.message_id);
        const clientId = targetData.clientId;
        const reasonText = targetData.text;

        // Команда: Задать ник
        if (text.startsWith('/nick ')) {
            const nick = text.replace('/nick ', '').trim();
            nicknames.set(clientId, nick);
            bot.sendMessage(adminId, `✅ Никнейм <b>${nick}</b> привязан к пользователю <code>${clientId}</code>`, { parse_mode: 'HTML', reply_to_message_id: msg.message_id });
            return;
        }

        // Команда: Бан
        if (text === '/ban 1h' || text === '/ban perm') {
            const isPerm = (text === '/ban perm');
            const expireAt = isPerm ? 0 : Date.now() + (60 * 60 * 1000);
            const durationText = isPerm ? "Навсегда" : "1 час";
            const banMsg = isPerm ? "Вам НАВСЕГДА был перекрыт доступ к связи с тех. поддержкой." : "Вам был перекрыт доступ к связи с тех. поддержкой сроком на 1 час.";

            bannedUsers.set(clientId, { expireAt, reasonText, durationText });
            
            // Блокируем чат на фронте и шлем красное сообщение
            io.to(clientId).emit('ban_status', { isBanned: true });
            sendToUser(clientId, banMsg, true, msg.message_id, "Блокировка");

            bot.sendMessage(adminId, `🚫 Пользователь <code>${clientId}</code> заблокирован (${durationText}).`, { parse_mode: 'HTML', reply_to_message_id: msg.message_id });
            return;
        }

        // Если это не команда, а обычный текст - отправляем юзеру
        sendToUser(clientId, text, false, msg.message_id, "Ответ");
    }
});

// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ---

// Функция отправки сообщений (учитывает онлайн/оффлайн)
function sendToUser(clientId, text, isWarning, msgId, actionName) {
    const room = io.sockets.adapter.rooms.get(clientId);
    if (room && room.size > 0) {
        io.to(clientId).emit('receive_message', { text: text, isWarning: isWarning });
        bot.sendMessage(adminId, `✅ <b>${actionName} доставлен(о)!</b>`, { reply_to_message_id: msgId, parse_mode: 'HTML' });
    } else {
        if (!pendingMessages.has(clientId)) pendingMessages.set(clientId, []);
        pendingMessages.get(clientId).push({ text, timestamp: Date.now(), isWarning });
        bot.sendMessage(adminId, `⏳ <b>${actionName}:</b> Юзер оффлайн. Сохранено в очередь.`, { reply_to_message_id: msgId, parse_mode: 'HTML' });
    }
}

// Генерация меню заблокированных
function sendBannedMenu(chatId, messageId = null) {
    // Очищаем истекшие баны перед показом
    for (const [clientId, info] of bannedUsers.entries()) {
        if (info.expireAt > 0 && info.expireAt < Date.now()) bannedUsers.delete(clientId);
    }

    if (bannedUsers.size === 0) {
        const text = "✅ Список заблокированных пуст.";
        if (messageId) bot.editMessageText(text, { chat_id: chatId, message_id: messageId });
        else bot.sendMessage(chatId, text);
        return;
    }

    const keyboard = [];
    for (const [clientId, info] of bannedUsers.entries()) {
        const nick = nicknames.get(clientId) || "Без ника";
        keyboard.push([{ text: `${nick} ( ${clientId} )`, callback_data: `baninfo_${clientId}` }]);
    }

    const opts = { reply_markup: { inline_keyboard: keyboard } };
    const title = "🚫 <b>Заблокированные пользователи:</b>";
    
    if (messageId) bot.editMessageText(title, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', ...opts });
    else bot.sendMessage(chatId, title, { parse_mode: 'HTML', ...opts });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
