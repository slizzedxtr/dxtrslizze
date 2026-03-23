const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const token = process.env.BOT_TOKEN;
const adminId = process.env.ADMIN_CHAT_ID;
const mongoURI = process.env.MONGODB_URI;
const bot = new TelegramBot(token, { polling: true });

// --- ПОДКЛЮЧЕНИЕ К БАЗЕ ---
mongoose.connect(mongoURI)
    .then(() => console.log('Connected to MongoDB!'))
    .catch(err => console.error('MongoDB error:', err));

// --- МОДЕЛИ ДАННЫХ (БАЗА) ---
const UserSchema = new mongoose.Schema({
    clientId: { type: String, unique: true },
    fpHash: String, // ОТПЕЧАТОК БРАУЗЕРА
    nickname: String,
    isBanned: { type: Boolean, default: false },
    banExpireAt: { type: Number, default: 0 },
    banReason: String,
    banDurationText: String
});
const User = mongoose.model('User', UserSchema);

const MessageMapSchema = new mongoose.Schema({
    tgMsgId: Number,
    clientId: String,
    text: String,
    createdAt: { type: Date, expires: '24h', default: Date.now }
});
const MessageMap = mongoose.model('MessageMap', MessageMapSchema);

const PendingMsgSchema = new mongoose.Schema({
    clientId: String,
    text: String,
    isWarning: { type: Boolean, default: false },
    isSuccess: { type: Boolean, default: false },
    timestamp: { type: Number, default: Date.now }
});
const PendingMsg = mongoose.model('PendingMsg', PendingMsgSchema);

const EXPIRATION_TIME = 60 * 60 * 1000; // 1 час на доставку

// --- ВЕБ-СОКЕТЫ (САЙТ) ---
io.on('connection', (socket) => {
    io.emit('online_update', io.engine.clientsCount);

    socket.on('disconnect', () => {
        io.emit('online_update', io.engine.clientsCount);
    });

    socket.on('register_client', async (data) => {
        // Поддержка старых клиентов (передавали строку) и новых (передают объект)
        const clientId = typeof data === 'string' ? data : data.clientId;
        const fpHash = typeof data === 'object' ? data.fpHash : null;

        socket.join(clientId);
        
        // Ищем юзера
        let user = await User.findOne({ clientId });
        if (!user) {
            user = await User.create({ clientId, fpHash });
        } else if (fpHash && user.fpHash !== fpHash) {
            // Обновляем отпечаток, если он появился или изменился
            user.fpHash = fpHash;
            await user.save();
        }

        // КРОСС-БАН: Если этот clientId чист, но его отпечаток fpHash забанен на другом аккаунте
        if (!user.isBanned && fpHash) {
            const bannedTwin = await User.findOne({ fpHash, isBanned: true });
            if (bannedTwin) {
                // Проверяем, не истек ли бан у двойника
                if (bannedTwin.banExpireAt !== 0 && bannedTwin.banExpireAt < Date.now()) {
                    bannedTwin.isBanned = false;
                    await bannedTwin.save();
                } else {
                    // Заражаем текущего юзера баном
                    user.isBanned = true;
                    user.banExpireAt = bannedTwin.banExpireAt;
                    user.banReason = bannedTwin.banReason;
                    user.banDurationText = bannedTwin.banDurationText;
                    await user.save();
                    bot.sendMessage(adminId, `🛡 <b>Anti-Spam System:</b>\nПользователь пытался обойти блокировку сбросом кэша. Бан восстановлен по отпечатку железа (<code>${fpHash}</code>).`, { parse_mode: 'HTML' });
                }
            }
        }

        // Проверка снятия бана по времени для текущего юзера
        if (user.isBanned) {
            if (user.banExpireAt !== 0 && user.banExpireAt < Date.now()) {
                user.isBanned = false;
                await user.save();
                socket.emit('ban_status', { isBanned: false });
                sendToUser(clientId, "Ограничение снято. Приятного пользования! И больше не нарушайте 🤫", 'success', null, null);
            } else {
                socket.emit('ban_status', { isBanned: true });
            }
        }

        socket.emit('user_data', { nickname: user.nickname || null, isBanned: user.isBanned });

        // Проверка отложенных сообщений
        const pending = await PendingMsg.find({ clientId });
        if (pending.length > 0) {
            const now = Date.now();
            let sentCount = 0;
            for (const m of pending) {
                if (now - m.timestamp < EXPIRATION_TIME) {
                    socket.emit('receive_message', { text: m.text, isWarning: m.isWarning, isSuccess: m.isSuccess });
                    sentCount++;
                }
            }
            await PendingMsg.deleteMany({ clientId });
            if (sentCount > 0) {
                bot.sendMessage(adminId, `🔔 <b>Юзер вернулся!</b>\nПользователь <code>${clientId}</code> зашёл на сайт и получил ${sentCount} отложенных сообщений.`, { parse_mode: 'HTML' });
            }
        }
    });

    socket.on('send_message', async (data) => {
        const user = await User.findOne({ clientId: data.clientId });
        
        if (user && user.isBanned) {
            if (user.banExpireAt === 0 || user.banExpireAt > Date.now()) return;
            else {
                user.isBanned = false;
                await user.save();
            }
        }

        const nickStr = (user && user.nickname) ? ` (<b>${user.nickname}</b>)` : '';
        const tgText = `
🌐 <b>Новый запрос с сайта!</b>

💬 <i>«${data.text}»</i>

👤 ID: <code>${data.clientId}</code>${nickStr}
➖➖➖➖➖➖➖➖➖
💡 <i>Ответь реплаем (или используй /nick для имени), либо выбери действие:</i>`;

        bot.sendMessage(adminId, tgText, {
            parse_mode: 'HTML',
            reply_markup: { 
                inline_keyboard: [
                    [
                        { text: "Ban 1h ⏳", callback_data: `ban1h_${data.clientId}` },
                        { text: "Ban Perm 🚫", callback_data: `banperm_${data.clientId}` }
                    ],
                    [
                        { text: "Spam ⚠️", callback_data: `spam_${data.clientId}` }
                    ]
                ] 
            }
        }).then(async (msg) => {
            await MessageMap.create({ tgMsgId: msg.message_id, clientId: data.clientId, text: data.text });
        });
    });
});

// --- КНОПКИ В ТЕЛЕГРАМЕ ---
bot.on('callback_query', async (query) => {
    if (query.from.id.toString() !== adminId.toString()) return;
    
    if (query.data.startsWith('spam_')) {
        const cId = query.data.replace('spam_', '');
        await sendToUser(cId, "Пожалуйста, не присылайте сообщения которые не имеют смысл или не связаны с темой сайта.", 'warning', query.message.message_id, "Spam-фильтр");
        bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: adminId, message_id: query.message.message_id });
        bot.answerCallbackQuery(query.id, { text: "Отправлено" });
    }

    if (query.data.startsWith('ban1h_') || query.data.startsWith('banperm_')) {
        const isPerm = query.data.startsWith('banperm_');
        const clientId = query.data.replace(isPerm ? 'banperm_' : 'ban1h_', '');
        const expireAt = isPerm ? 0 : Date.now() + 3600000;
        const banMsg = isPerm ? "Вам НАВСЕГДА был перекрыт доступ к связи с тех. поддержкой." : "Вам был перекрыт доступ к связи с тех. поддержкой сроком на 1 час.";
        
        const mapped = await MessageMap.findOne({ tgMsgId: query.message.message_id });
        const reason = mapped ? mapped.text : "Нарушение правил";

        // Баним основной clientId
        const bannedUser = await User.findOneAndUpdate({ clientId }, { 
            isBanned: true, banExpireAt: expireAt, banReason: reason, banDurationText: isPerm ? "Навсегда" : "1 час" 
        }, { new: true, upsert: true });
        
        // Массовый бан: Если у этого юзера есть fpHash, баним всех юзеров с таким же отпечатком
        if (bannedUser && bannedUser.fpHash) {
            await User.updateMany(
                { fpHash: bannedUser.fpHash }, 
                { isBanned: true, banExpireAt: expireAt, banReason: reason, banDurationText: isPerm ? "Навсегда" : "1 час" }
            );
        }

        io.to(clientId).emit('ban_status', { isBanned: true });
        await sendToUser(clientId, banMsg, 'warning', query.message.message_id, "Блокировка");
        
        bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: adminId, message_id: query.message.message_id });
        bot.answerCallbackQuery(query.id, { text: isPerm ? "Выдан перманентный бан" : "Выдан бан на 1 час" });
    }

    if (query.data.startsWith('baninfo_')) {
        const clientId = query.data.replace('baninfo_', '');
        const user = await User.findOne({ clientId });
        
        if (!user || !user.isBanned) return bot.answerCallbackQuery(query.id, {text: "Пользователь уже разбанен"});

        const nick = user.nickname || "Без ника";
        const text = `👤 <b>${nick}</b> (<code>${clientId}</code>)\n\n💬 <b>Причина:</b> <i>"${user.banReason}"</i>\n⏳ <b>Срок:</b> ${user.banDurationText}`;
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

    if (query.data === 'banlist') {
        sendBannedMenu(adminId, query.message.message_id);
    }

    if (query.data.startsWith('unban_')) {
        const clientId = query.data.replace('unban_', '');
        
        // Разбаниваем юзера
        const unbannedUser = await User.findOneAndUpdate({ clientId }, { isBanned: false }, { new: true });
        
        // Разбаниваем всех его клонов по железу (fpHash)
        if (unbannedUser && unbannedUser.fpHash) {
            await User.updateMany({ fpHash: unbannedUser.fpHash }, { isBanned: false });
        }
        
        io.to(clientId).emit('ban_status', { isBanned: false });
        await sendToUser(clientId, "Ограничение снято. Администратор досрочно снял блокировку с вас. Приятного пользования! И больше не нарушайте 🤫", 'success', null, null);

        bot.answerCallbackQuery(query.id, {text: "Разблокирован!"});
        sendBannedMenu(adminId, query.message.message_id);
    }
});

// --- КОМАНДЫ И РЕПЛАИ ---
bot.on('message', async (msg) => {
    if (msg.from.id.toString() !== adminId.toString()) return;
    const text = msg.text || '';

    if (text === '/bans') {
        sendBannedMenu(msg.chat.id);
        return;
    }

    if (msg.reply_to_message) {
        const mapped = await MessageMap.findOne({ tgMsgId: msg.reply_to_message.message_id });
        if (!mapped) return;

        const clientId = mapped.clientId;

        if (text.startsWith('/nick ')) {
            const nick = text.replace('/nick ', '').trim();
            await User.findOneAndUpdate({ clientId }, { nickname: nick }, { upsert: true });
            io.to(clientId).emit('user_data', { nickname: nick });
            bot.sendMessage(adminId, `✅ Никнейм <b>${nick}</b> сохранен в базе для ${clientId}!`, { parse_mode: 'HTML', reply_to_message_id: msg.message_id });
            return;
        }

        if (text === '/ban 1h' || text === '/ban perm') {
            const isPerm = text === '/ban perm';
            const expireAt = isPerm ? 0 : Date.now() + 3600000;
            const banMsg = isPerm ? "Вам НАВСЕГДА был перекрыт доступ к связи с тех. поддержкой." : "Вам был перекрыт доступ к связи с тех. поддержкой сроком на 1 час.";
            
            const bannedUser = await User.findOneAndUpdate({ clientId }, { 
                isBanned: true, banExpireAt: expireAt, banReason: mapped.text, banDurationText: isPerm ? "Навсегда" : "1 час" 
            }, { new: true, upsert: true });

            if (bannedUser && bannedUser.fpHash) {
                await User.updateMany(
                    { fpHash: bannedUser.fpHash }, 
                    { isBanned: true, banExpireAt: expireAt, banReason: mapped.text, banDurationText: isPerm ? "Навсегда" : "1 час" }
                );
            }
            
            io.to(clientId).emit('ban_status', { isBanned: true });
            await sendToUser(clientId, banMsg, 'warning', msg.message_id, "Блокировка");
            return;
        }

        await sendToUser(clientId, text, 'normal', msg.message_id, "Ответ");
    }
});

async function sendToUser(clientId, text, type, msgId, action) {
    const isWarning = type === 'warning';
    const isSuccess = type === 'success';
    const room = io.sockets.adapter.rooms.get(clientId);

    if (room && room.size > 0) {
        io.to(clientId).emit('receive_message', { text, isWarning, isSuccess });
        if (msgId) bot.sendMessage(adminId, `✅ <b>${action} доставлен(о)!</b>`, { reply_to_message_id: msgId, parse_mode: 'HTML' });
    } else {
        await PendingMsg.create({ clientId, text, isWarning, isSuccess });
        if (msgId) bot.sendMessage(adminId, `⏳ <b>${action}:</b> Юзер оффлайн. Сохранено в БД.`, { reply_to_message_id: msgId, parse_mode: 'HTML' });
    }
}

async function sendBannedMenu(chatId, messageId = null) {
    const bannedUsers = await User.find({ isBanned: true });
    const validBans = [];
    
    for (const u of bannedUsers) {
        if (u.banExpireAt > 0 && u.banExpireAt < Date.now()) {
            u.isBanned = false;
            await u.save();
        } else {
            validBans.push(u);
        }
    }

    if (validBans.length === 0) {
        const text = "✅ Список заблокированных пуст.";
        if (messageId) bot.editMessageText(text, { chat_id: chatId, message_id: messageId });
        else bot.sendMessage(chatId, text);
        return;
    }

    const keyboard = [];
    for (const u of validBans) {
        const nick = u.nickname || "Без ника";
        keyboard.push([{ text: `${nick} ( ${u.clientId} )`, callback_data: `baninfo_${u.clientId}` }]);
    }

    const opts = { reply_markup: { inline_keyboard: keyboard }, parse_mode: 'HTML' };
    const title = "🚫 <b>Заблокированные пользователи:</b>";
    
    if (messageId) bot.editMessageText(title, { chat_id: chatId, message_id: messageId, ...opts });
    else bot.sendMessage(chatId, title, opts);
}

server.listen(process.env.PORT || 3000, () => console.log("Server running with MongoDB Active!"));
