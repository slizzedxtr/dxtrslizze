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

// Храним: ID клиента -> массив объектов { text: 'сообщение', timestamp: время_создания }
const pendingMessages = new Map();

// Срок годности сообщения (например, 1 час = 3600000 миллисекунд)
const EXPIRATION_TIME = 60 * 60 * 1000; 

io.on('connection', (socket) => {
    
    socket.on('register_client', (clientId) => {
        socket.join(clientId);
        console.log(`User registered: ${clientId}`);

        // Проверяем, есть ли для этого юзера ожидающие сообщения
        if (pendingMessages.has(clientId)) {
            const userQueue = pendingMessages.get(clientId);
            const now = Date.now();
            
            const validMessages = [];
            let expiredCount = 0;

            // Сортируем сообщения на свежие и просроченные
            userQueue.forEach(msgObj => {
                if (now - msgObj.timestamp < EXPIRATION_TIME) {
                    validMessages.push(msgObj.text);
                } else {
                    expiredCount++;
                }
            });

            // Если есть свежие сообщения — отправляем
            if (validMessages.length > 0) {
                validMessages.forEach(text => {
                    socket.emit('receive_message', { text: text });
                });
                bot.sendMessage(adminId, `🔔 <b>Юзер вернулся!</b>\nПользователь <code>${clientId}</code> только что зашёл на сайт и получил твои отложенные ответы.`, { parse_mode: 'HTML' });
            } 
            // Если все сообщения протухли
            else if (expiredCount > 0) {
                bot.sendMessage(adminId, `⚠️ <b>Юзер вернулся, но поздно.</b>\nПользователь <code>${clientId}</code> зашёл на сайт, но время ожидания ответа истекло. Сообщения сгорели.`, { parse_mode: 'HTML' });
            }

            // Очищаем ящик юзера в любом случае
            pendingMessages.delete(clientId);
        }
    });

    socket.on('send_message', (data) => {
        const tgMessage = `
🌐 <b>Новый запрос с сайта!</b>

💬 <i>«${data.text}»</i>

👤 ID: <code>${data.clientId}</code>
➖➖➖➖➖➖➖➖➖
💡 <i>Сделай Reply (Ответить) на это сообщение.</i>`;

        bot.sendMessage(adminId, tgMessage, { parse_mode: 'HTML' })
        .then((msg) => {
            messageMap.set(msg.message_id, data.clientId);
        })
        .catch(err => console.error('Ошибка отправки в ТГ:', err));
    });
});

bot.on('message', (msg) => {
    if (msg.reply_to_message && messageMap.has(msg.reply_to_message.message_id)) {
        const clientId = messageMap.get(msg.reply_to_message.message_id);
        const room = io.sockets.adapter.rooms.get(clientId);
        
        // ЮЗЕР ОНЛАЙН
        if (room && room.size > 0) {
            io.to(clientId).emit('receive_message', { text: msg.text });
            bot.sendMessage(adminId, `✅ <b>Ответ доставлен!</b>\nПользователь прочитал сообщение прямо сейчас.`, { 
                parse_mode: 'HTML',
                reply_to_message_id: msg.message_id 
            });
        } 
        // ЮЗЕР ОФФЛАЙН -> КЛАДЕМ В ОЧЕРЕДЬ
        else {
            if (!pendingMessages.has(clientId)) {
                pendingMessages.set(clientId, []);
            }
            // Добавляем текст и текущее время
            pendingMessages.get(clientId).push({ text: msg.text, timestamp: Date.now() });

            bot.sendMessage(adminId, `⏳ <b>Пользователь оффлайн.</b>\nОтвет положен в очередь. Если он вернётся на сайт в течение 1 часа, бот ему всё передаст.\n\n<i>(Важно: если бесплатный сервер уснёт, очередь сотрётся раньше).</i>`, { 
                parse_mode: 'HTML',
                reply_to_message_id: msg.message_id 
            });
        }
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
