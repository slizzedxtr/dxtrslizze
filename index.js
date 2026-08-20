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

// ================= ПРОВЕРКА АДМИНИСТРАТОРА =================
app.get('/api/admin/check', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Нет токена авторизации' });

    const jwtToken = authHeader.split(' ')[1];
    
    const { data: { user }, error } = await supabase.auth.getUser(jwtToken);
    if (error || !user) return res.status(401).json({ error: 'Неверный токен' });

    if (user.email !== 'slizzedxtr@gmail.com') {
        return res.status(403).json({ error: 'Доступ запрещен: нет прав администратора.' });
    }

    res.json({ success: true, message: 'Доступ разрешен.' });
});

// ================= ПУБЛИЧНЫЕ ПРОМО-МАРШРУТЫ =================
app.get('/api/check/:code', async (req, res) => {
    const { data: promo, error } = await supabase.from('promos').select('*').eq('code', req.params.code).single();
    
    if (error || !promo) return res.status(404).json({ error: 'Неверный код' });
    
    if (promo.is_currency) {
        res.json({ title: promo.title, isCurrency: true, amount: promo.amount, usesLeft: promo.uses_left });
    } else {
        res.json({ title: promo.title, isCurrency: false, coverUrl: promo.cover_url, trackUrl: promo.track_url });
    }
});

// ================= СОКЕТЫ И ТЕХПОДДЕРЖКА =================
io.on('connection', (socket) => {
    io.emit('online_update', io.engine.clientsCount);
    socket.on('disconnect', () => { io.emit('online_update', io.engine.clientsCount); });

    // --- ЛОГИКА АДМИН-БАНОВ (АВТОБАНЫ) ---
    socket.on('check_admin_ban', async (data) => {
        if (!data.clientId) return;
        socket.join(`admin_${data.clientId}`); 
        
        const { data: ban } = await supabase.from('admin_bans').select('*').eq('client_id', data.clientId).single();
        if (ban) {
            if (ban.expires_at > Date.now()) {
                const timeLeft = Math.ceil((ban.expires_at - Date.now()) / 1000);
                socket.emit('admin_ban_status', { isBanned: true, timeRemaining: timeLeft });
            } else {
                await supabase.from('admin_bans').delete().eq('id', ban.id);
                socket.emit('admin_ban_status', { isBanned: false });
            }
        }
    });

    socket.on('trigger_admin_ban', async (data) => {
        if (!data.clientId || !data.duration) return;
        const expiresAt = Date.now() + data.duration * 1000;
        socket.join(`admin_${data.clientId}`);
        
        const fpToSave = (data.fpHash && data.fpHash !== 'blocked') ? data.fpHash : null;
        
        const { data: ban } = await supabase.from('admin_bans').insert([{ client_id: data.clientId, fp_hash: fpToSave, expires_at: expiresAt }]).select().single();

        const { data: user } = await supabase.from('g_users').select('*').eq('id', data.clientId).single();
        const nickStr = (user && user.nickname) ? user.nickname : "Без ника";
        
        const m = Math.floor(data.duration / 60);
        const s = data.duration % 60;

        const tgText = `🚨 <b>АВТОБАН: ПОПЫТКА ВЗЛОМА АДМИНКИ!</b>\n👤 <b>${nickStr}</b> (<code>${data.clientId}</code>)\n💬 <b>Причина:</b> <i>Многократные попытки подбора доступа</i>\n⏳ <b>Авторазбан через:</b> ${m} мин ${s} сек`;

        bot.sendMessage(adminId, tgText, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [ [{text: "🔓 Разблокировать доступ", callback_data: `alert_apunban_${ban.id}`}] ] }
        });
    });

    // --- ЛОГИКА ОБЫЧНОГО ЧАТА ---
    socket.on('register_client', async (data) => {
        if (!data || !data.token) return;

        const { data: { user }, error } = await supabase.auth.getUser(data.token);
        if (error || !user) return socket.emit('auth_required', { message: 'Сессия истекла' });

        const { data: dbUser } = await supabase.from('g_users').select('*').eq('id', user.id).single();
        if (!dbUser) return;

        socket.join(dbUser.id);

        if (dbUser.is_banned) {
            if (dbUser.ban_expire_at !== 0 && dbUser.ban_expire_at < Date.now()) {
                await supabase.from('g_users').update({ is_banned: false, ban_expire_at: 0 }).eq('id', dbUser.id);
                socket.emit('ban_status', { isBanned: false });
                sendToUser(dbUser.id, "Ограничение снято. Приятного пользования! И больше не нарушайте 🤫", 'success', null, null);
            } else {
                socket.emit('ban_status', { isBanned: true });
                return;
            }
        } else {
            socket.emit('ban_status', { isBanned: false });
        }

        socket.emit('user_data', { nickname: dbUser.nickname, avatarUrl: dbUser.avatar_url });

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
            
            if (dbUser.is_banned) {
                if (dbUser.ban_expire_at === 0 || dbUser.ban_expire_at > Date.now()) return;
                else await supabase.from('g_users').update({ is_banned: false }).eq('id', dbUser.id);
            }

            const nickStr = dbUser.nickname ? ` (<b>${dbUser.nickname}</b>)` : '';
            const tgText = `🌐 <b>Новый запрос с сайта!</b>\n\n💬 <i>«${data.text}»</i>\n\n👤 ID: <code>${dbUser.id}</code>${nickStr}\n➖➖➖➖➖➖➖➖➖\n💡 <i>Ответь реплаем (или используй /nick для имени), либо выбери действие:</i>`;

            bot.sendMessage(adminId, tgText, {
                parse_mode: 'HTML',
                reply_markup: { 
                    inline_keyboard: [
                        [ { text: "✅ Закрыть чат", callback_data: `closechat_${dbUser.id}` } ], 
                        [ { text: "Ban 1h ⏳", callback_data: `ban1h_${dbUser.id}` }, { text: "Ban Perm 🚫", callback_data: `banperm_${dbUser.id}` } ],
                        [ { text: "Spam ⚠️", callback_data: `spam_${dbUser.id}` }, { text: "🗑 Удалить Аватар", callback_data: `delavatar_${dbUser.id}` } ]
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

// ================= TELEGRAM БОТ (CALLBACKS) =================
bot.on('callback_query', async (query) => {
    if (query.from.id.toString() !== adminId.toString()) return;

    if (query.data.startsWith('delavatar_')) {
        const userId = query.data.replace('delavatar_', '');
        await supabase.from('g_users').update({ avatar_url: '/dslogo.png' }).eq('id', userId);
        
        const warningMsg = `Ваш аватар был удалён. Аватар не должен содержать:\nКровь\nСцены насилия\n18+ контент\n\nАдминистрация оставляет за собой право удалить ваш аватар без объяснения причины.`;
        await sendToUser(userId, warningMsg, 'warning', query.message.message_id, "Удаление аватара");
        
        io.to(userId).emit('user_data', { avatarUrl: '/dslogo.png' });
        bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: adminId, message_id: query.message.message_id });
        bot.sendMessage(adminId, "✅ <b>Аватар пользователя успешно удален.</b>", { parse_mode: 'HTML', reply_to_message_id: query.message.message_id });
        bot.answerCallbackQuery(query.id, { text: "Аватар удален!" });
    }
    
    if (query.data.startsWith('closechat_')) {
        const userId = query.data.replace('closechat_', '');
        io.to(userId).emit('chat_closed_solved'); 
        bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: adminId, message_id: query.message.message_id });
        bot.answerCallbackQuery(query.id, { text: "Чат закрыт, юзер уведомлен." });
    }

    if (query.data.startsWith('spam_')) {
        const userId = query.data.replace('spam_', '');
        await sendToUser(userId, "Пожалуйста, не присылайте сообщения, которые не имеют смысла или не связаны с темой сайта.", 'warning', query.message.message_id, "Spam-фильтр");
        bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: adminId, message_id: query.message.message_id });
        bot.answerCallbackQuery(query.id, { text: "Отправлено" });
    }

    if (query.data.startsWith('ban1h_') || query.data.startsWith('banperm_')) {
        const isPerm = query.data.startsWith('banperm_');
        const userId = query.data.replace(isPerm ? 'banperm_' : 'ban1h_', '');
        const expireAt = isPerm ? 0 : Date.now() + 3600000;
        const banMsg = isPerm ? "Вам НАВСЕГДА был перекрыт доступ к связи с тех. поддержкой." : "Вам был перекрыт доступ к связи с тех. поддержкой сроком на 1 час.";
        
        const { data: mapped } = await supabase.from('support_mappings').select('*').eq('tg_msg_id', query.message.message_id).single();
        const reason = mapped ? mapped.text : "Нарушение правил";

        await supabase.from('g_users').update({ 
            is_banned: true, ban_expire_at: expireAt, ban_reason: reason, ban_duration_text: isPerm ? "Навсегда" : "1 час" 
        }).eq('id', userId);
        
        io.to(userId).emit('ban_status', { isBanned: true });
        await sendToUser(userId, banMsg, 'warning', query.message.message_id, "Блокировка чата");
        
        bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: adminId, message_id: query.message.message_id });
        bot.answerCallbackQuery(query.id, { text: isPerm ? "Выдан перманентный бан чата" : "Выдан бан чата на 1 час" });
    }

    if (query.data.startsWith('baninfo_')) {
        const userId = query.data.replace('baninfo_', '');
        const { data: user } = await supabase.from('g_users').select('*').eq('id', userId).single();
        
        if (!user || !user.is_banned) return bot.answerCallbackQuery(query.id, {text: "Пользователь уже разбанен"});

        const nick = user.nickname || "Без ника";
        const text = `👤 <b>${nick}</b> (<code>${userId}</code>)\n\n💬 <b>Причина:</b> <i>"${user.ban_reason}"</i>\n⏳ <b>Срок:</b> ${user.ban_duration_text}`;
        const opts = {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [{text: "🔓 Разблокировать", callback_data: `unban_${userId}`}],
                    [{text: "🔙 Назад к списку", callback_data: `banlist`}]
                ]
            }
        };
        bot.editMessageText(text, {chat_id: adminId, message_id: query.message.message_id, ...opts});
    }

    if (query.data === 'banlist') { sendBannedMenu(adminId, query.message.message_id); }

    if (query.data.startsWith('unban_')) {
        const userId = query.data.replace('unban_', '');
        await supabase.from('g_users').update({ is_banned: false }).eq('id', userId);
        
        io.to(userId).emit('ban_status', { isBanned: false });
        await sendToUser(userId, "Ограничение снято. Администратор досрочно снял блокировку с вас. Приятного пользования! И больше не нарушайте 🤫", 'success', null, null);

        bot.answerCallbackQuery(query.id, {text: "Чат разблокирован!"});
        sendBannedMenu(adminId, query.message.message_id);
    }

    if (query.data === 'apbanlist') { sendApBannedMenu(adminId, query.message.message_id); }

    if (query.data.startsWith('apbaninfo_')) {
        const banId = query.data.replace('apbaninfo_', '');
        const { data: ban } = await supabase.from('admin_bans').select('*').eq('id', banId).single();
        
        if (!ban || ban.expires_at < Date.now()) {
            if (ban) await supabase.from('admin_bans').delete().eq('id', ban.id);
            return bot.answerCallbackQuery(query.id, {text: "Пользователь уже разбанен (срок истек)"});
        }

        const { data: user } = await supabase.from('g_users').select('*').eq('id', ban.client_id).single();
        const nick = (user && user.nickname) ? user.nickname : "Без ника";
        const displayId = ban.client_id;

        const timeLeft = Math.ceil((ban.expires_at - Date.now()) / 1000);
        const m = Math.floor(timeLeft / 60);
        const s = timeLeft % 60;
        
        const text = `🔐 <b>${nick}</b> (<code>${displayId}</code>)\n\n💬 <b>Причина:</b> <i>Многократные попытки входа в админ-панель</i>\n⏳ <b>Осталось до разбана:</b> ${m} мин ${s} сек`;
        
        const opts = {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [{text: "🔓 Разблокировать доступ", callback_data: `apunban_${ban.id}`}],
                    [{text: "🔙 Назад к списку", callback_data: `apbanlist`}]
                ]
            }
        };
        bot.editMessageText(text, {chat_id: adminId, message_id: query.message.message_id, ...opts});
    }

    if (query.data.startsWith('apunban_') || query.data.startsWith('alert_apunban_')) {
        const isAlert = query.data.startsWith('alert_apunban_');
        const banId = query.data.replace(isAlert ? 'alert_apunban_' : 'apunban_', '');
        
        const { data: ban } = await supabase.from('admin_bans').select('*').eq('id', banId).single();
        if (ban) {
            await supabase.from('admin_bans').delete().eq('id', ban.id);
            io.to(`admin_${ban.client_id}`).emit('admin_unbanned');
        }

        bot.answerCallbackQuery(query.id, {text: "Доступ в админку открыт!"});
        
        if (isAlert) {
            bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: adminId, message_id: query.message.message_id });
            bot.sendMessage(adminId, "✅ <b>Доступ восстановлен.</b>", { parse_mode: 'HTML', reply_to_message_id: query.message.message_id });
        } else {
            sendApBannedMenu(adminId, query.message.message_id);
        }
    }
});

// ================= TELEGRAM БОТ (MESSAGE) =================
bot.on('message', async (msg) => {
    if (msg.from.id.toString() !== adminId.toString()) return;
    const text = msg.text || '';

    if (text === '/bans') { sendBannedMenu(msg.chat.id); return; }
    if (text === '/apban') { sendApBannedMenu(msg.chat.id); return; }

    if (msg.reply_to_message) {
        const { data: mapped } = await supabase.from('support_mappings').select('*').eq('tg_msg_id', msg.reply_to_message.message_id).single();
        if (!mapped) return;

        const userId = mapped.user_id;

        if (text.startsWith('/nick ')) {
            const nick = text.replace('/nick ', '').trim();
            await supabase.from('g_users').update({ nickname: nick }).eq('id', userId);
            io.to(userId).emit('user_data', { nickname: nick });
            bot.sendMessage(adminId, `✅ Никнейм <b>${nick}</b> сохранен в базе для ${userId}!`, { parse_mode: 'HTML', reply_to_message_id: msg.message_id });
            return;
        }

        if (text === '/ban 1h' || text === '/ban perm') {
            const isPerm = text === '/ban perm';
            const expireAt = isPerm ? 0 : Date.now() + 3600000;
            const banMsg = isPerm ? "Вам НАВСЕГДА был перекрыт доступ к связи с тех. поддержкой." : "Вам был перекрыт доступ к связи с тех. поддержкой сроком на 1 час.";
            
            await supabase.from('g_users').update({ 
                is_banned: true, ban_expire_at: expireAt, ban_reason: mapped.text, ban_duration_text: isPerm ? "Навсегда" : "1 час" 
            }).eq('id', userId);

            io.to(userId).emit('ban_status', { isBanned: true });
            await sendToUser(userId, banMsg, 'warning', msg.message_id, "Блокировка чата");
            return;
        }

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

async function sendBannedMenu(chatId, messageId = null) {
    const { data: bannedUsers } = await supabase.from('g_users').select('*').eq('is_banned', true);
    const validBans = [];
    
    for (const u of (bannedUsers || [])) {
        if (u.ban_expire_at > 0 && u.ban_expire_at < Date.now()) {
            await supabase.from('g_users').update({ is_banned: false }).eq('id', u.id);
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
        keyboard.push([{ text: `${nick} ( ${u.id.substring(0,8)}... )`, callback_data: `baninfo_${u.id}` }]);
    }

    const opts = { reply_markup: { inline_keyboard: keyboard }, parse_mode: 'HTML' };
    const title = "🚫 <b>Заблокированные в техподдержке:</b>";
    
    if (messageId) bot.editMessageText(title, { chat_id: chatId, message_id: messageId, ...opts });
    else bot.sendMessage(chatId, title, opts);
}

async function sendApBannedMenu(chatId, messageId = null) {
    const { data: adminBans } = await supabase.from('admin_bans').select('*');
    const validBans = [];
    const now = Date.now();
    
    for (const ban of (adminBans || [])) {
        if (ban.expires_at < now) { await supabase.from('admin_bans').delete().eq('id', ban.id); } 
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
        const { data: user } = await supabase.from('g_users').select('*').eq('id', ban.client_id).single();
        const nick = (user && user.nickname) ? user.nickname : "Без ника";
        keyboard.push([{ text: `🔐 ${nick} ( ${ban.client_id.substring(0,8)}... )`, callback_data: `apbaninfo_${ban.id}` }]);
    }

    const opts = { reply_markup: { inline_keyboard: keyboard }, parse_mode: 'HTML' };
    const title = "🔐 <b>Заблокированные в Админ-панели:</b>";
    
    if (messageId) bot.editMessageText(title, { chat_id: chatId, message_id: messageId, ...opts });
    else bot.sendMessage(chatId, title, opts);
}

// ================= ПОДКЛЮЧЕНИЕ ИГР =================
require('./games')(app, null, supabase);

server.listen(process.env.PORT || 3000, () => {
    console.log("Whunx | l1beral Server is ONLINE! Connected to Supabase.");
});
