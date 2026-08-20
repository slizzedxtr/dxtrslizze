const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json()); 
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const token = process.env.BOT_TOKEN;
const adminId = process.env.ADMIN_CHAT_ID;
const bot = new TelegramBot(token, { polling: true });

// --- ИНИЦИАЛИЗАЦИЯ SUPABASE ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// ================= ПРОВЕРКА АДМИНИСТРАТОРА (НОВАЯ СИСТЕМА) =================
// Этот роут дергает фронтенд админки. Если почта не совпадает - выкидываем.
app.get('/api/admin/check', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Нет токена авторизации' });

    const jwtToken = authHeader.split(' ')[1];
    
    // 1. Проверяем токен на серверах Supabase
    const { data: { user }, error } = await supabase.auth.getUser(jwtToken);
    if (error || !user) return res.status(401).json({ error: 'Неверный или просроченный токен' });

    // 2. ЖЕЛЕЗОБЕТОННАЯ ПРОВЕРКА ПОЧТЫ
    if (user.email !== 'slizzedxtr@gmail.com') {
        return res.status(403).json({ error: 'Доступ запрещен: ваш аккаунт не является администратором.' });
    }

    res.json({ success: true, message: 'Доступ в Command Center разрешен.' });
});

// ================= ПУБЛИЧНЫЕ ПРОМО-МАРШРУТЫ (ПЕРЕВЕДЕНЫ НА SUPABASE) =================
app.get('/api/check/:code', async (req, res) => {
    const { data: promo, error } = await supabase.from('promos').select('*').eq('code', req.params.code).single();
    
    if (error || !promo) return res.status(404).json({ error: 'Неверный код' });
    
    if (promo.is_currency) {
        res.json({ 
            title: promo.title, 
            isCurrency: true, 
            amount: promo.amount, 
            usesLeft: promo.uses_left 
        });
    } else {
        res.json({ 
            title: promo.title, 
            isCurrency: false,
            coverUrl: promo.cover_url, 
            trackUrl: promo.track_url 
        });
    }
});

// ================= СОКЕТЫ И ТЕХПОДДЕРЖКА =================
io.on('connection', (socket) => {
    io.emit('online_update', io.engine.clientsCount);
    socket.on('disconnect', () => { io.emit('online_update', io.engine.clientsCount); });

    socket.on('register_client', async (data) => {
        if (!data || !data.token) return;

        // Валидация юзера через Supabase
        const { data: { user }, error } = await supabase.auth.getUser(data.token);
        if (error || !user) return socket.emit('auth_required', { message: 'Сессия истекла' });

        const { data: dbUser } = await supabase.from('g_users').select('*').eq('id', user.id).single();
        if (!dbUser) return;

        // Подключаем к персональной комнате
        socket.join(dbUser.id);

        // Проверка на бан
        if (dbUser.is_banned) {
            socket.emit('ban_status', { isBanned: true });
            return;
        } else {
            socket.emit('ban_status', { isBanned: false });
        }

        socket.emit('user_data', { nickname: dbUser.nickname, avatarUrl: dbUser.avatar_url });

        // Выгрузка отложенных сообщений
        const { data: pendingMsgs } = await supabase.from('pending_messages').select('*').eq('user_id', dbUser.id);
        if (pendingMsgs && pendingMsgs.length > 0) {
            for (const m of pendingMsgs) {
                socket.emit('receive_message', { text: m.text, isWarning: m.is_warning, isSuccess: m.is_success });
            }
            await supabase.from('pending_messages').delete().eq('user_id', dbUser.id);
            bot.sendMessage(adminId, `🔔 <b>Юзер вернулся!</b>\nПользователь <code>${dbUser.nickname}</code> получил ${pendingMsgs.length} отложенных сообщений.`, { parse_mode: 'HTML' });
        }
    });

    socket.on('send_message', async (data) => {
        if (!data.token || !data.text) return;

        try {
            const { data: { user }, error } = await supabase.auth.getUser(data.token);
            if (error || !user) return;

            const { data: dbUser } = await supabase.from('g_users').select('*').eq('id', user.id).single();
            if (!dbUser || dbUser.is_banned) return;

            const nickStr = dbUser.nickname ? ` (<b>${dbUser.nickname}</b>)` : '';
            const tgText = `🌐 <b>Новый запрос с сайта!</b>\n\n💬 <i>«${data.text}»</i>\n\n👤 ID: <code>${dbUser.id}</code>${nickStr}\n➖➖➖➖➖➖➖➖➖\n💡 <i>Ответь реплаем либо выбери действие:</i>`;

            bot.sendMessage(adminId, tgText, {
                parse_mode: 'HTML',
                reply_markup: { 
                    inline_keyboard: [
                        [ { text: "✅ Закрыть чат", callback_data: `closechat_${dbUser.id}` } ], 
                        [ { text: "Ban Perm 🚫", callback_data: `banperm_${dbUser.id}` }, { text: "Spam ⚠️", callback_data: `spam_${dbUser.id}` } ]
                    ] 
                }
            }).then(async (msg) => {
                await supabase.from('support_mappings').insert([{ tg_msg_id: msg.message_id, user_id: dbUser.id, text: data.text }]);
            });
        } catch (err) {
            console.error("Ошибка чата:", err.message);
        }
    });
});

// ================= TELEGRAM БОТ =================
bot.on('callback_query', async (query) => {
    if (query.from.id.toString() !== adminId.toString()) return;
    
    if (query.data.startsWith('closechat_')) {
        const userId = query.data.replace('closechat_', '');
        io.to(userId).emit('chat_closed_solved'); 
        bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: adminId, message_id: query.message.message_id });
        bot.answerCallbackQuery(query.id, { text: "Чат закрыт, юзер уведомлен." });
    }

    if (query.data.startsWith('spam_')) {
        const userId = query.data.replace('spam_', '');
        await sendToUser(userId, "Пожалуйста, не присылайте сообщения, не связанные с поддержкой.", 'warning', query.message.message_id, "Spam-фильтр");
        bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: adminId, message_id: query.message.message_id });
        bot.answerCallbackQuery(query.id, { text: "Отправлено предупреждение" });
    }

    if (query.data.startsWith('banperm_')) {
        const userId = query.data.replace('banperm_', '');
        
        await supabase.from('g_users').update({ is_banned: true }).eq('id', userId);
        
        io.to(userId).emit('ban_status', { isBanned: true });
        await sendToUser(userId, "Вам НАВСЕГДА перекрыт доступ к связи с тех. поддержкой.", 'warning', query.message.message_id, "Блокировка чата");
        
        bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: adminId, message_id: query.message.message_id });
        bot.answerCallbackQuery(query.id, { text: "Пользователь забанен" });
    }
});

bot.on('message', async (msg) => {
    if (msg.from.id.toString() !== adminId.toString()) return;
    const text = msg.text || '';

    if (msg.reply_to_message) {
        const { data: mapped } = await supabase.from('support_mappings').select('*').eq('tg_msg_id', msg.reply_to_message.message_id).single();
        if (!mapped) return;

        const userId = mapped.user_id;
        await sendToUser(userId, text, 'normal', msg.message_id, "Ответ");
    }
});

async function sendToUser(userId, text, type, msgId, action) {
    const isWarning = type === 'warning';
    const isSuccess = type === 'success';
    const room = io.sockets.adapter.rooms.get(userId);

    if (room && room.size > 0) {
        io.to(userId).emit('receive_message', { text, isWarning, isSuccess });
        if (msgId) bot.sendMessage(adminId, `✅ <b>${action} доставлен(о)!</b>`, { reply_to_message_id: msgId, parse_mode: 'HTML' });
    } else {
        await supabase.from('pending_messages').insert([{ user_id: userId, text, is_warning: isWarning, is_success: isSuccess }]);
        if (msgId) bot.sendMessage(adminId, `⏳ <b>${action}:</b> Юзер оффлайн. Сохранено в БД.`, { reply_to_message_id: msgId, parse_mode: 'HTML' });
    }
}

// ================= ПОДКЛЮЧЕНИЕ ИГР =================
// Передаем null вместо UserMongo, так как MongoDB вырезана
require('./games')(app, null, supabase);

server.listen(process.env.PORT || 3000, () => {
    console.log("Whunx | l1beral Server is ONLINE! Connected to Supabase.");
});
