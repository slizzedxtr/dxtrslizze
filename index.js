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

const messageMap = new Map();
const pendingMessages = new Map();
const EXPIRATION_TIME = 60 * 60 * 1000; // 1 час

io.on('connection', (socket) => {
    socket.on('register_client', (clientId) => {
        socket.join(clientId);
        if (pendingMessages.has(clientId)) {
            const userQueue = pendingMessages.get(clientId);
            const now = Date.now();
            const validMessages = [];
            let expiredCount = 0;

            userQueue.forEach(msgObj => {
                if (now - msgObj.timestamp < EXPIRATION_TIME) {
                    validMessages.push(msgObj.text);
                } else {
                    expiredCount++;
                }
            });

            if (validMessages.length > 0) {
                validMessages.forEach(text => {
                    socket.emit('receive_message', { text: text });
                });
                bot.sendMessage(adminId, `🔔 <b>Юзер вернулся!</b>\nID: <code>${clientId}</code> получил отложенные ответы.`, { parse_mode: 'HTML' });
            } else if (expiredCount > 0) {
                bot.sendMessage(adminId, `⚠️ <b>Юзер вернулся поздно.</b>\nВремя ожидания ответа для <code>${clientId}</code> истекло.`, { parse_mode: 'HTML' });
            }
            pendingMessages.delete(clientId);
        }
    });

    socket.on('send_message', (data) => {
        const tgMessage = `
🌐 <b>Новый запрос с сайта!</b>

💬 <i>«${data.text}»</i>

👤 ID: <code>${data.clientId}</code>
➖➖➖➖➖➖➖➖➖
💡 <i>Ответь реплаем или жми Spam:</i>`;

        // Кнопка, которая заменяет стандартный вид сообщения на интерактивный
        const options = {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [{ text: "Spam ⚠️", callback_data: `spam_${data.clientId}` }]
                ]
            }
        };

        bot.sendMessage(adminId, tgMessage, options)
        .then((msg) => {
            messageMap.set(msg.message_id, data.clientId);
        });
    });
});

// ОБРАБОТКА НАЖАТИЯ КНОПКИ (Callback Query)
bot.on('callback_query', (query) => {
    const userId = query.from.id.toString();
    
    // ПРОВЕРКА: Только админ может нажать
    if (userId !== adminId.toString()) {
        return bot.answerCallbackQuery(query.id, { 
            text: "⚠️ Доступ запрещен. Вы не администратор.", 
            show_alert: true 
        });
    }

    if (query.data.startsWith('spam_')) {
        const clientId = query.data.split('_')[1];
        const spamText = "Пожалуйста, не присылайте сообщения которые не имеют смысл или не связаны с темой сайта.";
        
        const room = io.sockets.adapter.rooms.get(clientId);
        
        if (room && room.size > 0) {
            io.to(clientId).emit('receive_message', { text: spamText });
            bot.sendMessage(adminId, `✅ <b>Spam-фильтр:</b> Сообщение отправлено пользователю <code>${clientId}</code>`, { parse_mode: 'HTML' });
        } else {
            if (!pendingMessages.has(clientId)) pendingMessages.set(clientId, []);
            pendingMessages.get(clientId).push({ text: spamText, timestamp: Date.now() });
            bot.sendMessage(adminId, `⏳ <b>Spam-фильтр:</b> Юзер оффлайн, сообщение добавлено в очередь.`, { parse_mode: 'HTML' });
        }

        // Убираем кнопку после нажатия, чтобы не спамить кнопкой спама :)
        bot.editMessageReplyMarkup({ inline_keyboard: [] }, { 
            chat_id: query.message.chat.id, 
            message_id: query.message.message_id 
        });

        bot.answerCallbackQuery(query.id, { text: "Отправлено!" });
    }
});

bot.on('message', (msg) => {
    if (msg.reply_to_message && messageMap.has(msg.reply_to_message.message_id)) {
        const clientId = messageMap.get(msg.reply_to_message.message_id);
        const room = io.sockets.adapter.rooms.get(clientId);
        
        if (room && room.size > 0) {
            io.to(clientId).emit('receive_message', { text: msg.text });
            bot.sendMessage(adminId, `✅ <b>Ответ доставлен!</b>`, { 
                reply_to_message_id: msg.message_id, 
                parse_mode: 'HTML' 
            });
        } else {
            if (!pendingMessages.has(clientId)) pendingMessages.set(clientId, []);
            pendingMessages.get(clientId).push({ text: msg.text, timestamp: Date.now() });
            bot.sendMessage(adminId, `⏳ <b>В очереди.</b>\nЮзер получит ответ, когда вернется.`, { 
                reply_to_message_id: msg.message_id, 
                parse_mode: 'HTML' 
            });
        }
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
