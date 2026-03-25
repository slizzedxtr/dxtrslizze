const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors');
const mongoose = require('mongoose');
const multer = require('multer');
const { GridFSBucket, ObjectId } = require('mongodb');
const { Readable } = require('stream');

const app = express();
app.use(cors());
app.use(express.json()); 
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const token = process.env.BOT_TOKEN;
const adminId = process.env.ADMIN_CHAT_ID;
const mongoURI = process.env.MONGODB_URI;
const ADMIN_PASS = process.env.ADMIN_PASS || 'DXTR-promo777!'; 
const bot = new TelegramBot(token, { polling: true });

let gfsBucket;

mongoose.connect(mongoURI)
    .then(() => {
        console.log('Connected to MongoDB!');
        gfsBucket = new GridFSBucket(mongoose.connection.db, { bucketName: 'promomedia' });
    })
    .catch(err => console.error('MongoDB error:', err));

// --- Схемы БД ---
const CounterSchema = new mongoose.Schema({
    _id: { type: String, required: true },
    seq: { type: Number, default: 0 }
});
const Counter = mongoose.model('Counter', CounterSchema);

const UserSchema = new mongoose.Schema({
    clientId: { type: String, unique: true },
    fpHash: String,
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

const EXPIRATION_TIME = 60 * 60 * 1000;

const PromoSchema = new mongoose.Schema({
    code: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    coverId: { type: mongoose.Schema.Types.ObjectId, required: true },
    trackId: { type: mongoose.Schema.Types.ObjectId, required: true },
    createdAt: { type: Date, default: Date.now }
});
const Promo = mongoose.model('Promo', PromoSchema);

// ИЗМЕНЕНИЕ 1: Теперь уникальным ключом является clientId
const AdminBanSchema = new mongoose.Schema({
    clientId: { type: String, required: true, unique: true },
    fpHash: String,
    expiresAt: { type: Date, required: true }
});
const AdminBan = mongoose.model('AdminBan', AdminBanSchema);

const upload = multer({ storage: multer.memoryStorage() });

function uploadToGridFS(file) {
    return new Promise((resolve, reject) => {
        const readableStream = new Readable();
        readableStream.push(file.buffer);
        readableStream.push(null);
        
        const uploadStream = gfsBucket.openUploadStream(file.originalname, { contentType: file.mimetype });
        readableStream.pipe(uploadStream)
            .on('error', reject)
            .on('finish', () => resolve(uploadStream.id));
    });
}

// ================= API =================
app.post('/api/promo', upload.fields([{ name: 'cover', maxCount: 1 }, { name: 'track', maxCount: 1 }]), async (req, res) => {
    try {
        const { password, promo, title } = req.body;
        if (password !== ADMIN_PASS) return res.status(403).json({ error: 'Неверный пароль' });
        
        const existing = await Promo.findOne({ code: promo });
        if (existing) return res.status(400).json({ error: 'Промокод уже существует' });

        const coverFile = req.files['cover'][0];
        const trackFile = req.files['track'][0];

        const coverId = await uploadToGridFS(coverFile);
        const trackId = await uploadToGridFS(trackFile);

        const newPromo = new Promo({ code: promo, title, coverId, trackId });
        await newPromo.save();

        res.json({ success: true, message: 'Промокод успешно создан' });
    } catch (err) { res.status(500).json({ error: 'Ошибка сервера при создании' }); }
});

app.post('/api/promos-list', async (req, res) => {
    const { password } = req.body;
    if (password !== ADMIN_PASS) return res.status(403).json({ error: 'Неверный пароль' });
    const promos = await Promo.find().sort({ createdAt: -1 });
    res.json(promos);
});

app.delete('/api/promo/:code', async (req, res) => {
    const { password } = req.body;
    if (password !== ADMIN_PASS) return res.status(403).json({ error: 'Неверный пароль' });

    const promo = await Promo.findOne({ code: req.params.code });
    if (!promo) return res.status(404).json({ error: 'Не найдено' });

    try { await gfsBucket.delete(new ObjectId(promo.coverId)); } catch(e){}
    try { await gfsBucket.delete(new ObjectId(promo.trackId)); } catch(e){}
    
    await Promo.deleteOne({ _id: promo._id });
    res.json({ success: true, message: 'Удалено' });
});

app.put('/api/promo/:code', async (req, res) => {
    try {
        const { password, newCode, newTitle } = req.body;
        if (password !== ADMIN_PASS) return res.status(403).json({ error: 'Неверный пароль' });

        const promo = await Promo.findOne({ code: req.params.code });
        if (!promo) return res.status(404).json({ error: 'Код не найден' });

        if (newCode !== promo.code) {
            const existing = await Promo.findOne({ code: newCode });
            if (existing) return res.status(400).json({ error: 'Такой код уже занят' });
        }

        promo.code = newCode || promo.code;
        promo.title = newTitle || promo.title;
        await promo.save();

        res.json({ success: true, message: 'Изменено' });
    } catch (err) { res.status(500).json({ error: 'Ошибка сервера при редактировании' }); }
});

app.get('/api/check/:code', async (req, res) => {
    const promo = await Promo.findOne({ code: req.params.code });
    if (!promo) return res.status(404).json({ error: 'Неверный код' });
    
    res.json({
        title: promo.title,
        coverUrl: `/api/media/${promo.coverId}`,
        trackUrl: `/api/media/${promo.trackId}`
    });
});

app.get('/api/media/:id', async (req, res) => {
    try {
        const fileId = new ObjectId(req.params.id);
        const files = await gfsBucket.find({ _id: fileId }).toArray();
        if (!files || files.length === 0) return res.status(404).send('Файл не найден');
        
        res.set('Content-Type', files[0].contentType);
        const downloadStream = gfsBucket.openDownloadStream(fileId);
        downloadStream.pipe(res);
    } catch (err) { res.status(404).send('Некорректный ID файла'); }
});

// ================= SOCKETS =================
io.on('connection', (socket) => {
    io.emit('online_update', io.engine.clientsCount);
    socket.on('disconnect', () => { io.emit('online_update', io.engine.clientsCount); });

    // ИЗМЕНЕНИЕ 2: Проверка бана админки теперь идет по clientId
    socket.on('check_admin_ban', async (data) => {
        if (!data.clientId) return;
        socket.join(`admin_${data.clientId}`); // Отдельная комната для событий админки этого юзера
        
        const ban = await AdminBan.findOne({ clientId: data.clientId });
        if (ban) {
            if (ban.expiresAt > Date.now()) {
                const timeLeft = Math.ceil((ban.expiresAt - Date.now()) / 1000);
                socket.emit('admin_ban_status', { isBanned: true, timeRemaining: timeLeft });
            } else {
                await AdminBan.deleteOne({ _id: ban._id });
                socket.emit('admin_ban_status', { isBanned: false });
            }
        }
    });

    // ИЗМЕНЕНИЕ 3: Выдача бана админки теперь привязывается к clientId
    socket.on('trigger_admin_ban', async (data) => {
        if (!data.clientId || !data.duration) return;
        const expiresAt = new Date(Date.now() + data.duration * 1000);
        socket.join(`admin_${data.clientId}`);
        
        const fpToSave = (data.fpHash && data.fpHash !== 'blocked') ? data.fpHash : null;

        const ban = await AdminBan.findOneAndUpdate(
            { clientId: data.clientId },
            { expiresAt, fpHash: fpToSave },
            { upsert: true, new: true }
        );

        const user = await User.findOne({ clientId: data.clientId });
        const nickStr = (user && user.nickname) ? user.nickname : "Без ника";
        const displayId = data.clientId;
        
        const m = Math.floor(data.duration / 60);
        const s = data.duration % 60;

        const tgText = `
🚨 <b>АВТОБАН: ПОПЫТКА ВЗЛОМА АДМИНКИ!</b>

👤 <b>${nickStr}</b> (<code>${displayId}</code>)
💬 <b>Причина:</b> <i>Многократные попытки подбора пароля</i>
⏳ <b>Авторазбан через:</b> ${m} мин ${s} сек

💡 <i>Ответь реплаем на это сообщение, чтобы отправить юзеру сообщение в чат тех.поддержки, или используй /nick для смены имени.</i>`;

        bot.sendMessage(adminId, tgText, {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [{text: "🔓 Разблокировать доступ", callback_data: `alert_apunban_${ban._id}`}]
                ]
            }
        }).then(async (msg) => {
            await MessageMap.create({ tgMsgId: msg.message_id, clientId: displayId, text: "Автобан в админке" });
        });
    });

    socket.on('register_client', async (data) => {
        const rawClientId = typeof data === 'string' ? data : data.clientId;
        const fpHash = typeof data === 'object' ? data.fpHash : null;

        let user = null;
        let clientId = null;

        const isNumeric = /^\d+$/.test(rawClientId);

        if (isNumeric) {
            user = await User.findOne({ clientId: rawClientId });
        }

        if (!user) {
            if (fpHash && fpHash !== 'blocked') {
                user = await User.findOne({ fpHash });
            }
            
            if (user && !/^\d+$/.test(user.clientId)) {
                const counter = await Counter.findByIdAndUpdate(
                    { _id: 'userId' },
                    { $inc: { seq: 1 } },
                    { new: true, upsert: true }
                );
                clientId = counter.seq.toString();
                
                await PendingMsg.updateMany({ clientId: user.clientId }, { clientId: clientId });
                await AdminBan.updateMany({ clientId: user.clientId }, { clientId: clientId });
                
                user.clientId = clientId;
                await user.save();
                socket.emit('assign_id', { newId: clientId });
            } else if (!user) {
                const counter = await Counter.findByIdAndUpdate(
                    { _id: 'userId' },
                    { $inc: { seq: 1 } },
                    { new: true, upsert: true }
                );
                clientId = counter.seq.toString();
                user = await User.create({ clientId, fpHash: (fpHash !== 'blocked' ? fpHash : null) });
                socket.emit('assign_id', { newId: clientId });
            } else {
                clientId = user.clientId;
                socket.emit('assign_id', { newId: clientId });
            }
        } else {
            clientId = user.clientId;
            if (fpHash && fpHash !== 'blocked' && user.fpHash !== fpHash) {
                user.fpHash = fpHash;
                await user.save();
            }
        }

        socket.join(clientId);
        
        if (!user.isBanned && fpHash && fpHash !== 'blocked') {
            const bannedTwin = await User.findOne({ fpHash, isBanned: true, clientId: { $ne: clientId } });
            if (bannedTwin) {
                if (bannedTwin.banExpireAt !== 0 && bannedTwin.banExpireAt < Date.now()) {
                    bannedTwin.isBanned = false;
                    await bannedTwin.save();
                } else {
                    user.isBanned = true;
                    user.banExpireAt = bannedTwin.banExpireAt;
                    user.banReason = bannedTwin.banReason;
                    user.banDurationText = bannedTwin.banDurationText;
                    await user.save();
                    bot.sendMessage(adminId, `🛡 <b>Anti-Spam System:</b>\nПользователь пытался обойти блокировку чата сбросом кэша. Бан восстановлен по отпечатку железа (<code>${fpHash}</code>). ID нарушителя: <code>${clientId}</code>`, { parse_mode: 'HTML' });
                }
            }
        }

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
            else { user.isBanned = false; await user.save(); }
        }

        const nickStr = (user && user.nickname) ? ` (<b>${user.nickname}</b>)` : '';
        const tgText = `🌐 <b>Новый запрос с сайта!</b>\n\n💬 <i>«${data.text}»</i>\n\n👤 ID: <code>${data.clientId}</code>${nickStr}\n➖➖➖➖➖➖➖➖➖\n💡 <i>Ответь реплаем (или используй /nick для имени), либо выбери действие:</i>`;

        bot.sendMessage(adminId, tgText, {
            parse_mode: 'HTML',
            reply_markup: { 
                inline_keyboard: [
                    [ { text: "Ban 1h ⏳", callback_data: `ban1h_${data.clientId}` }, { text: "Ban Perm 🚫", callback_data: `banperm_${data.clientId}` } ],
                    [ { text: "Spam ⚠️", callback_data: `spam_${data.clientId}` } ]
                ] 
            }
        }).then(async (msg) => {
            await MessageMap.create({ tgMsgId: msg.message_id, clientId: data.clientId, text: data.text });
        });
    });
});

// ================= TELEGRAM =================
bot.on('callback_query', async (query) => {
    if (query.from.id.toString() !== adminId.toString()) return;
    
    // --- ОБРАБОТКА БАНОВ ТЕХПОДДЕРЖКИ ---
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

        const bannedUser = await User.findOneAndUpdate({ clientId }, { 
            isBanned: true, banExpireAt: expireAt, banReason: reason, banDurationText: isPerm ? "Навсегда" : "1 час" 
        }, { new: true, upsert: true });
        
        if (bannedUser && bannedUser.fpHash) {
            await User.updateMany(
                { fpHash: bannedUser.fpHash }, 
                { isBanned: true, banExpireAt: expireAt, banReason: reason, banDurationText: isPerm ? "Навсегда" : "1 час" }
            );
        }

        io.to(clientId).emit('ban_status', { isBanned: true });
        await sendToUser(clientId, banMsg, 'warning', query.message.message_id, "Блокировка чата");
        
        bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: adminId, message_id: query.message.message_id });
        bot.answerCallbackQuery(query.id, { text: isPerm ? "Выдан перманентный бан чата" : "Выдан бан чата на 1 час" });
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

    if (query.data === 'banlist') { sendBannedMenu(adminId, query.message.message_id); }

    if (query.data.startsWith('unban_')) {
        const clientId = query.data.replace('unban_', '');
        const unbannedUser = await User.findOneAndUpdate({ clientId }, { isBanned: false }, { new: true });
        
        if (unbannedUser && unbannedUser.fpHash) {
            await User.updateMany({ fpHash: unbannedUser.fpHash }, { isBanned: false });
        }
        
        io.to(clientId).emit('ban_status', { isBanned: false });
        await sendToUser(clientId, "Ограничение снято. Администратор досрочно снял блокировку с вас. Приятного пользования! И больше не нарушайте 🤫", 'success', null, null);

        bot.answerCallbackQuery(query.id, {text: "Чат разблокирован!"});
        sendBannedMenu(adminId, query.message.message_id);
    }

    // --- ОБРАБОТКА БАНОВ АДМИН ПАНЕЛИ (/apban) ---
    if (query.data === 'apbanlist') { sendApBannedMenu(adminId, query.message.message_id); }

    if (query.data.startsWith('apbaninfo_')) {
        const banId = query.data.replace('apbaninfo_', '');
        const ban = await AdminBan.findById(banId);
        
        if (!ban || ban.expiresAt.getTime() < Date.now()) {
            if (ban) await AdminBan.deleteOne({ _id: ban._id });
            return bot.answerCallbackQuery(query.id, {text: "Пользователь уже разбанен (срок истек)"});
        }

        const user = await User.findOne({ clientId: ban.clientId });
        const nick = (user && user.nickname) ? user.nickname : "Без ника";
        const displayId = ban.clientId;

        const timeLeft = Math.ceil((ban.expiresAt.getTime() - Date.now()) / 1000);
        const m = Math.floor(timeLeft / 60);
        const s = timeLeft % 60;
        
        const text = `🔐 <b>${nick}</b> (<code>${displayId}</code>)\n\n💬 <b>Причина:</b> <i>Многократные попытки входа в админ-панель (попытка подбора пароля)</i>\n⏳ <b>Осталось до разбана:</b> ${m} мин ${s} сек`;
        
        const opts = {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [{text: "🔓 Разблокировать доступ", callback_data: `apunban_${ban._id}`}],
                    [{text: "🔙 Назад к списку", callback_data: `apbanlist`}]
                ]
            }
        };
        bot.editMessageText(text, {chat_id: adminId, message_id: query.message.message_id, ...opts});
    }

    // ИЗМЕНЕНИЕ 4: Разбан отправляется в комнату admin_ID
    if (query.data.startsWith('apunban_')) {
        const banId = query.data.replace('apunban_', '');
        const ban = await AdminBan.findByIdAndDelete(banId);

        if (ban && ban.clientId) {
            io.to(`admin_${ban.clientId}`).emit('admin_unbanned');
        }

        bot.answerCallbackQuery(query.id, {text: "Доступ в админку открыт!"});
        sendApBannedMenu(adminId, query.message.message_id);
    }

    // Разбан прямо из быстрого уведомления (алерта)
    if (query.data.startsWith('alert_apunban_')) {
        const banId = query.data.replace('alert_apunban_', '');
        const ban = await AdminBan.findByIdAndDelete(banId);

        if (ban && ban.clientId) {
            io.to(`admin_${ban.clientId}`).emit('admin_unbanned');
        }

        bot.answerCallbackQuery(query.id, {text: "Доступ в админку открыт!"});
        bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: adminId, message_id: query.message.message_id });
        bot.sendMessage(adminId, "✅ <b>Доступ восстановлен.</b>", { parse_mode: 'HTML', reply_to_message_id: query.message.message_id });
    }
});

bot.on('message', async (msg) => {
    if (msg.from.id.toString() !== adminId.toString()) return;
    const text = msg.text || '';

    if (text === '/bans') { sendBannedMenu(msg.chat.id); return; }
    if (text === '/apban') { sendApBannedMenu(msg.chat.id); return; }

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
            await sendToUser(clientId, banMsg, 'warning', msg.message_id, "Блокировка чата");
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
        } else { validBans.push(u); }
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
    const title = "🚫 <b>Заблокированные в техподдержке:</b>";
    
    if (messageId) bot.editMessageText(title, { chat_id: chatId, message_id: messageId, ...opts });
    else bot.sendMessage(chatId, title, opts);
}

async function sendApBannedMenu(chatId, messageId = null) {
    const adminBans = await AdminBan.find();
    const validBans = [];
    const now = Date.now();
    
    for (const ban of adminBans) {
        if (ban.expiresAt.getTime() < now) { await AdminBan.deleteOne({ _id: ban._id }); } 
        else { validBans.push(ban); }
    }

    if (validBans.length === 0) {
        const text = "✅ Список заблокированных в админ-панели пуст.";
        if (messageId) bot.editMessageText(text, { chat_id: chatId, message_id: messageId });
        else bot.sendMessage(chatId, text);
        return;
    }

    const keyboard = [];
    for (const ban of validBans) {
        const user = await User.findOne({ clientId: ban.clientId });
        const nick = (user && user.nickname) ? user.nickname : "Без ника";
        const displayId = ban.clientId;
        keyboard.push([{ text: `🔐 ${nick} ( ${displayId} )`, callback_data: `apbaninfo_${ban._id}` }]);
    }

    const opts = { reply_markup: { inline_keyboard: keyboard }, parse_mode: 'HTML' };
    const title = "🔐 <b>Заблокированные в Админ-панели:</b>";
    
    if (messageId) bot.editMessageText(title, { chat_id: chatId, message_id: messageId, ...opts });
    else bot.sendMessage(chatId, title, opts);
}

server.listen(process.env.PORT || 3000, () => console.log("Server running with MongoDB Active!"));
