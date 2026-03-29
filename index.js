const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors');
const mongoose = require('mongoose');
const multer = require('multer');
const { GridFSBucket, ObjectId } = require('mongodb');
const { Readable } = require('stream');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json()); 
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const token = process.env.BOT_TOKEN;
const adminId = process.env.ADMIN_CHAT_ID;
const mongoURI = process.env.MONGODB_URI;
const ADMIN_PASS = process.env.ADMIN_PASS || 'DXTR-promo777!'; 
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_key';
const bot = new TelegramBot(token, { polling: true });

// --- ИНИЦИАЛИЗАЦИЯ SUPABASE ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

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
    username: { type: String, unique: true, required: true, lowercase: true },
    password: { type: String, required: true },
    clientId: { type: String, unique: true },
    nickname: String,
    avatarUrl: { type: String, default: 'dslogo.png' },
    dscoin_balance: { type: Number, default: 100 },
    fpHash: String,
    isBanned: { type: Boolean, default: false },
    banExpireAt: { type: Number, default: 0 },
    banReason: String,
    banDurationText: String,
    regDate: { type: Date, default: Date.now }
});
const User = mongoose.model('User', UserSchema);

const MessageMapSchema = new mongoose.Schema({
    tgMsgId: Number,
    clientId: String,
    linkedUser: String, 
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

async function uploadToSupabase(file, folderName) {
    if (!file) return null;
    const ext = file.originalname.split('.').pop();
    const fileName = `${folderName}/${Date.now()}_${Math.random().toString(36).substring(7)}.${ext}`;
    
    const { data, error } = await supabase.storage
        .from('music-content')
        .upload(fileName, file.buffer, { contentType: file.mimetype, upsert: false });

    if (error) throw error;
    const { data: publicUrlData } = supabase.storage.from('music-content').getPublicUrl(fileName);
    return publicUrlData.publicUrl;
}

// ================= API АВТОРИЗАЦИИ =================

app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Заполните все поля' });

        const lowerUser = String(username).toLowerCase();
        const existing = await User.findOne({ username: lowerUser });
        if (existing) return res.status(400).json({ error: 'Этот никнейм уже занят' });

        const hashedPassword = await bcrypt.hash(password, 10);
        
        const counter = await Counter.findByIdAndUpdate(
            { _id: 'userId' },
            { $inc: { seq: 1 } },
            { new: true, upsert: true }
        );
        const clientId = counter.seq.toString();

        const newUser = await User.create({
            username: lowerUser,
            password: hashedPassword,
            clientId: clientId,
            nickname: username
        });

        const token = jwt.sign({ clientId: newUser.clientId, username: newUser.username }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ success: true, token, user: { username: newUser.nickname, clientId: newUser.clientId, avatarUrl: newUser.avatarUrl } });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка сервера при регистрации' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const lowerUser = String(username).toLowerCase();
        
        const user = await User.findOne({ username: lowerUser });
        if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ error: 'Неверный пароль' });

        const token = jwt.sign({ clientId: user.clientId, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ success: true, token, user: { username: user.nickname, clientId: user.clientId, avatarUrl: user.avatarUrl } });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка сервера при входе' });
    }
});

app.get('/api/auth/me', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Нет токена' });

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const user = await User.findOne({ clientId: decoded.clientId });
        if (!user) return res.status(404).json({ error: 'Юзер не найден' });

        res.json({ success: true, user: { username: user.nickname, clientId: user.clientId, avatarUrl: user.avatarUrl } });
    } catch (err) {
        res.status(401).json({ error: 'Неверный или просроченный токен' });
    }
});

// ДОБАВЛЕНО: upload.single('avatar') для приема файла
app.put('/api/auth/update', upload.single('avatar'), async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Нет токена' });

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const user = await User.findOne({ clientId: decoded.clientId });
        if (!user) return res.status(404).json({ error: 'Юзер не найден' });

        const { newNickname, oldPassword, newPassword } = req.body;

        if (newNickname) user.nickname = newNickname;

        if (oldPassword && newPassword) {
            const isMatch = await bcrypt.compare(oldPassword, user.password);
            if (!isMatch) return res.status(400).json({ error: 'Неверный старый пароль' });
            user.password = await bcrypt.hash(newPassword, 10);
        }

        let avatarChanged = false;

        // Обработка файла аватара
        if (req.file) {
            if (req.file.size > 2 * 1024 * 1024) {
                return res.status(400).json({ error: 'Файл слишком большой (макс. 2МБ)' });
            }

            // Удаляем старый аватар из Supabase (если это не дефолтный)
            if (user.avatarUrl && user.avatarUrl.includes('/music-content/')) {
                const oldPath = user.avatarUrl.split('/music-content/')[1];
                if (oldPath) await supabase.storage.from('music-content').remove([oldPath]);
            }

            const newAvatarUrl = await uploadToSupabase(req.file, 'avatars');
            user.avatarUrl = newAvatarUrl;
            avatarChanged = true;
        }

        await user.save();

        // Уведомление в Телеграм об изменении аватара
        if (avatarChanged) {
            const tgText = `🖼 <b>Пользователь обновил аватар!</b>\n\n👤 Ник: <b>${user.nickname || user.username}</b>\n🔑 ID: <code>${user.clientId}</code>\n🔗 <a href="${user.avatarUrl}">Посмотреть загруженное фото</a>`;
            
            bot.sendMessage(adminId, tgText, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [ { text: "🗑 Удалить аватар", callback_data: `delavatar_${user.clientId}` } ]
                    ]
                }
            }).catch(e => console.error("Ошибка отправки ТГ-уведомления об аватаре:", e.message));
        }

        res.json({ success: true, message: 'Профиль обновлен', user: { nickname: user.nickname, avatarUrl: user.avatarUrl } });
    } catch (err) { 
        console.error("Ошибка при обновлении профиля:", err);
        res.status(500).json({ error: 'Ошибка сервера' }); 
    }
});

app.post('/api/auth/recover', async (req, res) => {
    try {
        const { username } = req.body;
        if (!username) return res.status(400).json({ error: 'Укажите никнейм' });

        const safeUsername = String(username).toLowerCase();
        const user = await User.findOne({ username: safeUsername });
        
        if (!user) return res.status(404).json({ error: 'Аккаунт не найден' });

        bot.sendMessage(adminId, `🚨 <b>ЗАПРОС ВОССТАНОВЛЕНИЯ ПАРОЛЯ</b>\n\n👤 Аккаунт: <b>${user.nickname || user.username}</b>\n🔑 ID: <code>${user.clientId}</code>\n\nПользователь забыл пароль. Вы можете связаться с ним или сбросить пароль через базу данных.`, { parse_mode: 'HTML' })
           .catch(err => console.error("Ошибка отправки в ТГ:", err.message));

        res.json({ success: true, message: 'Запрос отправлен администрации!' });
    } catch (err) {
        console.error("Ошибка при восстановлении пароля:", err);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ================= ОРИГИНАЛЬНЫЙ API (МУЗЫКА, АДМИНКА, ПРОМО) =================

app.post('/api/music', upload.fields([
    { name: 'cover', maxCount: 1 }, 
    { name: 'mp3', maxCount: 1 }, 
    { name: 'wav', maxCount: 1 }
]), async (req, res) => {
    try {
        const { password, title, yt_link, is_18, is_main, platforms } = req.body;
        if (password !== ADMIN_PASS) return res.status(403).json({ error: 'Неверный пароль' });

        const coverFile = req.files['cover'] ? req.files['cover'][0] : null;
        const mp3File = req.files['mp3'] ? req.files['mp3'][0] : null;
        const wavFile = req.files['wav'] ? req.files['wav'][0] : null;

        if (!coverFile || !mp3File || !wavFile) {
            return res.status(400).json({ error: 'Обложка, MP3 и WAV файлы обязательны для загрузки.' });
        }

        const cover_url = await uploadToSupabase(coverFile, 'covers');
        const mp3_url = await uploadToSupabase(mp3File, 'tracks');
        const wav_url = await uploadToSupabase(wavFile, 'tracks');

        const isMainRelease = is_main === 'true' || is_main === true;
        if (isMainRelease) {
            await supabase.from('music').update({ is_main: false }).eq('is_main', true);
        }

        let platformsData = {};
        try { if (platforms) platformsData = JSON.parse(platforms); } catch(e){}

        const { data, error } = await supabase
            .from('music')
            .insert([{
                title, cover_url, mp3_url, wav_url, yt_link,
                is_18: is_18 === 'true' || is_18 === true,
                is_main: isMainRelease, platforms: platformsData
            }]);

        if (error) throw error;
        res.json({ success: true, message: 'Трек успешно добавлен в каталог!' });
    } catch (err) {
        console.error('Ошибка загрузки музыки:', err);
        res.status(500).json({ error: 'Ошибка сервера при добавлении трека' });
    }
});

app.post('/api/music-list', async (req, res) => {
    const { password } = req.body;
    if (password !== ADMIN_PASS) return res.status(403).json({ error: 'Неверный пароль' });
    const { data, error } = await supabase.from('music').select('*').order('id', { ascending: false });
    if (error) return res.status(500).json({ error: 'Ошибка при получении списка' });
    res.json(data);
});

app.put('/api/music/:id', upload.fields([
    { name: 'cover', maxCount: 1 }, 
    { name: 'mp3', maxCount: 1 }, 
    { name: 'wav', maxCount: 1 }
]), async (req, res) => {
    try {
        const { password, title, yt_link, is_18, is_main, platforms } = req.body;
        if (password !== ADMIN_PASS) return res.status(403).json({ error: 'Неверный пароль' });

        const trackId = req.params.id;
        const { data: existingTrack, error: fetchError } = await supabase.from('music').select('*').eq('id', trackId).single();

        if (fetchError || !existingTrack) return res.status(404).json({ error: 'Трек не найден' });

        const isMainRelease = is_main === 'true' || is_main === true;
        if (isMainRelease) {
            await supabase.from('music').update({ is_main: false }).eq('is_main', true);
        }

        let platformsData = {};
        try { if (platforms) platformsData = JSON.parse(platforms); } catch(e){}

        let cover_url = existingTrack.cover_url;
        let mp3_url = existingTrack.mp3_url;
        let wav_url = existingTrack.wav_url;
        const filesToRemove = [];

        if (req.files['cover']) {
            if (existingTrack.cover_url) filesToRemove.push(existingTrack.cover_url.split('/music-content/')[1]);
            cover_url = await uploadToSupabase(req.files['cover'][0], 'covers');
        }
        if (req.files['mp3']) {
            if (existingTrack.mp3_url) filesToRemove.push(existingTrack.mp3_url.split('/music-content/')[1]);
            mp3_url = await uploadToSupabase(req.files['mp3'][0], 'tracks');
        }
        if (req.files['wav']) {
            if (existingTrack.wav_url) filesToRemove.push(existingTrack.wav_url.split('/music-content/')[1]);
            wav_url = await uploadToSupabase(req.files['wav'][0], 'tracks');
        }

        if (filesToRemove.length > 0) {
            await supabase.storage.from('music-content').remove(filesToRemove);
        }

        const { error: updateError } = await supabase.from('music').update({
            title, cover_url, mp3_url, wav_url, yt_link,
            is_18: is_18 === 'true' || is_18 === true,
            is_main: isMainRelease, platforms: platformsData
        }).eq('id', trackId);

        if (updateError) throw updateError;
        res.json({ success: true, message: 'Трек успешно обновлен' });
    } catch (err) {
        console.error('Ошибка редактирования музыки:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.delete('/api/music/:id', async (req, res) => {
    const { password } = req.body;
    if (password !== ADMIN_PASS) return res.status(403).json({ error: 'Неверный пароль' });

    try {
        const { data: track } = await supabase.from('music').select('*').eq('id', req.params.id).single();
        if (track) {
            const filesToRemove = [];
            if (track.cover_url) filesToRemove.push(track.cover_url.split('/music-content/')[1]);
            if (track.mp3_url) filesToRemove.push(track.mp3_url.split('/music-content/')[1]);
            if (track.wav_url) filesToRemove.push(track.wav_url.split('/music-content/')[1]);
            if (filesToRemove.length > 0) await supabase.storage.from('music-content').remove(filesToRemove);
        }

        const { error } = await supabase.from('music').delete().eq('id', req.params.id);
        if (error) throw error;
        res.json({ success: true, message: 'Удалено' });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ПРОФИЛИ АДМИНКА
app.post('/api/users-list', async (req, res) => {
    const { password } = req.body;
    if (password !== ADMIN_PASS) return res.status(403).json({ error: 'Неверный пароль' });
    try {
        const users = await User.find().sort({ _id: -1 });
        res.json(users);
    } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.delete('/api/user/:id', async (req, res) => {
    const { password } = req.body;
    if (password !== ADMIN_PASS) return res.status(403).json({ error: 'Неверный пароль' });
    try {
        const user = await User.findByIdAndDelete(req.params.id);
        if (!user) return res.status(404).json({ error: 'Не найдено' });
        await PendingMsg.deleteMany({ clientId: user.clientId });
        res.json({ success: true, message: 'Удалено' });
    } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.put('/api/user/:id', async (req, res) => {
    const { password, newClientId, newNickname } = req.body;
    if (password !== ADMIN_PASS) return res.status(403).json({ error: 'Неверный пароль' });
    try {
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
        if (newClientId && newClientId !== user.clientId) {
            const existing = await User.findOne({ clientId: newClientId });
            if (existing) return res.status(400).json({ error: 'Этот ID уже занят' });
            await PendingMsg.updateMany({ clientId: user.clientId }, { clientId: newClientId });
            await MessageMap.updateMany({ clientId: user.clientId }, { clientId: newClientId });
            await AdminBan.updateMany({ clientId: user.clientId }, { clientId: newClientId });
        }
        user.clientId = newClientId || user.clientId;
        user.nickname = newNickname.trim() === '' ? null : newNickname;
        await user.save();
        res.json({ success: true, message: 'Изменено' });
    } catch (err) { res.status(500).json({ error: 'Ошибка сервера при редактировании' }); }
});

// ПРОМОКОДЫ
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
    res.json({ title: promo.title, coverUrl: `/api/media/${promo.coverId}`, trackUrl: `/api/media/${promo.trackId}` });
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

    socket.on('anon_register_client', (data) => {
        if (data.anonId) {
            socket.join(data.anonId);
        }
    });

    socket.on('send_anon_message', async (data) => {
        if (!data.anonId || !data.text) return;
        
        const targetUser = data.targetUsername ? `\n👤 <b>Указанный аккаунт:</b> <code>${data.targetUsername}</code>` : '';
        const tgText = `🌐 <b>Запрос без регистрации (Восстановление/Связь)!</b>\n\n💬 <i>«${data.text}»</i>${targetUser}\n🆔 Сессия: <code>${data.anonId}</code>\n➖➖➖➖➖➖➖➖➖\n💡 <i>Ответь реплаем (или используй /cp "пароль"), либо выбери действие:</i>`;

        bot.sendMessage(adminId, tgText, {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [ { text: "✅ Закрыть чат", callback_data: `closechat_${data.anonId}` } ],
                    [ { text: "🔑 Сбросить пароль", callback_data: `resetpass_${data.anonId}` } ],
                    [ { text: "ℹ️ Сообщение о сбросе", callback_data: `resetinfo_${data.anonId}` } ]
                ]
            }
        }).then(async (msg) => {
            await MessageMap.create({
                tgMsgId: msg.message_id,
                clientId: data.anonId,
                linkedUser: data.targetUsername ? data.targetUsername.toLowerCase() : null,
                text: data.text
            });
        });
    });

    socket.on('check_admin_ban', async (data) => {
        if (!data.clientId) return;
        socket.join(`admin_${data.clientId}`); 
        
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

        const tgText = `🚨 <b>АВТОБАН: ПОПЫТКА ВЗЛОМА АДМИНКИ!</b>\n👤 <b>${nickStr}</b> (<code>${displayId}</code>)\n💬 <b>Причина:</b> <i>Многократные попытки подбора пароля</i>\n⏳ <b>Авторазбан через:</b> ${m} мин ${s} сек`;

        bot.sendMessage(adminId, tgText, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [ [{text: "🔓 Разблокировать доступ", callback_data: `alert_apunban_${ban._id}`}] ] }
        }).then(async (msg) => {
            await MessageMap.create({ tgMsgId: msg.message_id, clientId: displayId, text: "Автобан в админке" });
        });
    });

    socket.on('register_client', async (data) => {
        const token = typeof data === 'object' ? data.token : null;

        if (!token) {
            socket.emit('auth_required', { message: 'Войдите в аккаунт для использования чата' });
            return;
        }

        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            const user = await User.findOne({ clientId: decoded.clientId });

            if (!user) return socket.emit('auth_required', { message: 'Аккаунт не найден' });

            socket.join(user.clientId);

            if (user.isBanned) {
                if (user.banExpireAt !== 0 && user.banExpireAt < Date.now()) {
                    user.isBanned = false;
                    await user.save();
                    socket.emit('ban_status', { isBanned: false });
                    sendToUser(user.clientId, "Ограничение снято. Приятного пользования! И больше не нарушайте 🤫", 'success', null, null);
                } else {
                    socket.emit('ban_status', { isBanned: true });
                }
            } else {
                socket.emit('ban_status', { isBanned: false });
            }

            socket.emit('user_data', { nickname: user.nickname, avatarUrl: user.avatarUrl, isBanned: user.isBanned });

            const pending = await PendingMsg.find({ clientId: user.clientId });
            if (pending.length > 0) {
                const now = Date.now();
                let sentCount = 0;
                for (const m of pending) {
                    if (now - m.timestamp < EXPIRATION_TIME) {
                        socket.emit('receive_message', { text: m.text, isWarning: m.isWarning, isSuccess: m.isSuccess });
                        sentCount++;
                    }
                }
                await PendingMsg.deleteMany({ clientId: user.clientId });
                if (sentCount > 0) {
                    bot.sendMessage(adminId, `🔔 <b>Юзер вернулся!</b>\nПользователь <code>${user.clientId}</code> зашёл на сайт и получил ${sentCount} отложенных сообщений.`, { parse_mode: 'HTML' });
                }
            }
        } catch (err) {
            socket.emit('auth_required', { message: 'Сессия истекла. Войдите заново.' });
        }
    });

    socket.on('send_message', async (data) => {
        if (!data.token || !data.text) return;

        try {
            const decoded = jwt.verify(data.token, JWT_SECRET);
            const user = await User.findOne({ clientId: decoded.clientId });
            if (!user) return;

            if (user.isBanned) {
                if (user.banExpireAt === 0 || user.banExpireAt > Date.now()) return;
                else { user.isBanned = false; await user.save(); }
            }

            const nickStr = user.nickname ? ` (<b>${user.nickname}</b>)` : '';
            const tgText = `🌐 <b>Новый запрос с сайта!</b>\n\n💬 <i>«${data.text}»</i>\n\n👤 ID: <code>${user.clientId}</code>${nickStr}\n➖➖➖➖➖➖➖➖➖\n💡 <i>Ответь реплаем (или используй /nick для имени), либо выбери действие:</i>`;

            bot.sendMessage(adminId, tgText, {
                parse_mode: 'HTML',
                reply_markup: { 
                    inline_keyboard: [
                        [ { text: "✅ Закрыть чат", callback_data: `closechat_${user.clientId}` } ], 
                        [ { text: "Ban 1h ⏳", callback_data: `ban1h_${user.clientId}` }, { text: "Ban Perm 🚫", callback_data: `banperm_${user.clientId}` } ],
                        [ { text: "Spam ⚠️", callback_data: `spam_${user.clientId}` } ]
                    ] 
                }
            }).then(async (msg) => {
                await MessageMap.create({ tgMsgId: msg.message_id, clientId: user.clientId, text: data.text });
            });
        } catch (err) {
            console.error("Ошибка чата:", err.message);
        }
    });
});

// ================= TELEGRAM БОТ =================
bot.on('callback_query', async (query) => {
    if (query.from.id.toString() !== adminId.toString()) return;

    // ДОБАВЛЕНО: Удаление аватара
    if (query.data.startsWith('delavatar_')) {
        const clientId = query.data.replace('delavatar_', '');
        const user = await User.findOne({ clientId });
        
        if (!user) {
            return bot.answerCallbackQuery(query.id, { text: "Юзер не найден" });
        }

        if (user.avatarUrl && user.avatarUrl.includes('/music-content/')) {
            const oldPath = user.avatarUrl.split('/music-content/')[1];
            if (oldPath) await supabase.storage.from('music-content').remove([oldPath]);
        }

        user.avatarUrl = 'dslogo.png';
        await user.save();

        const warningMsg = `Ваш аватар был удалён. Аватар не должен содержать:\nКровь\nСцены насилия\n18+ контент\n\nВ случае если ваш аватар не попадает ни под одно из указанных нарушений, но всё равно был удалён вы можете обратиться к администрации через Тех. Поддержку.\n\nАдминистрация оставляет за собой право удалить ваш аватар без объяснения причины.`;
        
        await sendToUser(clientId, warningMsg, 'warning', query.message.message_id, "Удаление аватара");

        io.to(clientId).emit('user_data', { nickname: user.nickname, avatarUrl: user.avatarUrl, isBanned: user.isBanned });
        
        bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: adminId, message_id: query.message.message_id });
        bot.sendMessage(adminId, "✅ <b>Аватар пользователя успешно удален и отправлено предупреждение.</b>", { parse_mode: 'HTML', reply_to_message_id: query.message.message_id });
        bot.answerCallbackQuery(query.id, { text: "Аватар удален!" });
    }
    
    if (query.data.startsWith('closechat_')) {
        const clientId = query.data.replace('closechat_', '');
        io.to(clientId).emit('chat_closed_solved'); 
        bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: adminId, message_id: query.message.message_id });
        bot.answerCallbackQuery(query.id, { text: "Чат закрыт, юзер уведомлен." });
    }

    if (query.data.startsWith('resetinfo_')) {
        const clientId = query.data.replace('resetinfo_', '');
        const msgText = "Сбросить пароль можно двумя способами:\n1. Администрация устанавливает вам новый пароль который вы укажете в этом чате.\n2. Администрация сбросит ваш пароль полностью. Вам автоматически установится временный пароль который будет необходимо сменить вручную в профиле. Временным паролем является \"admin-reset\"";
        io.to(clientId).emit('receive_message', { text: msgText, isWarning: false, isSuccess: false });
        bot.answerCallbackQuery(query.id, { text: "Инструкция отправлена юзеру" });
    }

    if (query.data.startsWith('resetpass_')) {
        const clientId = query.data.replace('resetpass_', '');
        const mapped = await MessageMap.findOne({ tgMsgId: query.message.message_id });
        
        if (!mapped || !mapped.linkedUser) {
            return bot.answerCallbackQuery(query.id, { text: "Ошибка: не указан никнейм юзера для сброса", show_alert: true });
        }

        const user = await User.findOne({ username: mapped.linkedUser });
        if (!user) {
            return bot.answerCallbackQuery(query.id, { text: "Этот аккаунт не найден в базе данных!", show_alert: true });
        }

        user.password = await bcrypt.hash("admin-reset", 10);
        await user.save();

        io.to(clientId).emit('chat_closed_reset'); 
        bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: adminId, message_id: query.message.message_id });
        bot.sendMessage(adminId, `✅ Пароль для <b>${user.nickname}</b> сброшен на <code>admin-reset</code>`, { parse_mode: 'HTML', reply_to_message_id: query.message.message_id });
        bot.answerCallbackQuery(query.id, { text: "Пароль успешно сброшен!" });
    }

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

        await User.findOneAndUpdate({ clientId }, { 
            isBanned: true, banExpireAt: expireAt, banReason: reason, banDurationText: isPerm ? "Навсегда" : "1 час" 
        }, { new: true, upsert: true });
        
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
        await User.findOneAndUpdate({ clientId }, { isBanned: false }, { new: true });
        
        io.to(clientId).emit('ban_status', { isBanned: false });
        await sendToUser(clientId, "Ограничение снято. Администратор досрочно снял блокировку с вас. Приятного пользования! И больше не нарушайте 🤫", 'success', null, null);

        bot.answerCallbackQuery(query.id, {text: "Чат разблокирован!"});
        sendBannedMenu(adminId, query.message.message_id);
    }

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
        
        const text = `🔐 <b>${nick}</b> (<code>${displayId}</code>)\n\n💬 <b>Причина:</b> <i>Многократные попытки входа в админ-панель</i>\n⏳ <b>Осталось до разбана:</b> ${m} мин ${s} сек`;
        
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

    if (query.data.startsWith('apunban_')) {
        const banId = query.data.replace('apunban_', '');
        const ban = await AdminBan.findByIdAndDelete(banId);

        if (ban && ban.clientId) {
            io.to(`admin_${ban.clientId}`).emit('admin_unbanned');
        }

        bot.answerCallbackQuery(query.id, {text: "Доступ в админку открыт!"});
        sendApBannedMenu(adminId, query.message.message_id);
    }

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

        if (text.startsWith('/cp ')) {
            let newPass = text.replace('/cp ', '').trim();
            if (newPass.startsWith('"') && newPass.endsWith('"')) {
                newPass = newPass.slice(1, -1);
            }

            let targetUserStr = mapped.linkedUser;
            if (!targetUserStr) {
                const u = await User.findOne({ clientId: mapped.clientId });
                if (u) targetUserStr = u.username;
            }

            if (!targetUserStr) {
                return bot.sendMessage(adminId, "❌ Не удалось определить аккаунт для сброса.", { reply_to_message_id: msg.message_id });
            }

            const userToUpdate = await User.findOne({ username: targetUserStr });
            if (!userToUpdate) {
                 return bot.sendMessage(adminId, "❌ Аккаунт не найден в БД.", { reply_to_message_id: msg.message_id });
            }

            userToUpdate.password = await bcrypt.hash(newPass, 10);
            await userToUpdate.save();

            bot.sendMessage(adminId, `✅ Пароль для <b>${userToUpdate.nickname}</b> изменен на <code>${newPass}</code>`, { parse_mode: 'HTML', reply_to_message_id: msg.message_id });
            io.to(mapped.clientId).emit('receive_message', { text: `Ваш пароль был успешно изменен администратором. Вы можете войти в аккаунт.`, isSuccess: true, isWarning: false });
            return;
        }

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
            
            await User.findOneAndUpdate({ clientId }, { 
                isBanned: true, banExpireAt: expireAt, banReason: mapped.text, banDurationText: isPerm ? "Навсегда" : "1 час" 
            }, { new: true, upsert: true });

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

server.listen(process.env.PORT || 3000, () => {
    console.log("DXTR | SlizZe Server is ONLINE! JWT Auth & Admin Panel Active!");
});
