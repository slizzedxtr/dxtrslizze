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

// Храним: ID сообщения в ТГ -> ID клиента
const messageMap = new Map();

// НОВАЯ ФИЧА: Очередь сообщений для тех, кто оффлайн
// Храним: ID клиента -> [Массив ожидающих текстов]
const pendingMessages = new Map(); 

io.on('connection', (socket) => {
    
    socket.on('register_client', (clientId) => {
        socket.join(clientId);
        console.log(`User registered: ${clientId}`);

        // ПРОВЕРЯЕМ ОЧЕРЕДЬ: Есть ли для него непрочитанные ответы?
        if (pendingMessages.has(clientId)) {
            const msgs = pendingMessages.get(clientId);
            
            // Отправляем юзеру все накопленные сообщения
            msgs.forEach(text => {
                socket.emit('receive_message', { text: text });
            });
            
            // Очищаем его ящик
            pendingMessages.delete(clientId);

            // Радуем админа в Телеге
            bot.sendMessage(adminId, `🔔 <b>Юзер вернулся!</b>\nПользователь <code>${clientId}</code> снова зашел на сайт и получил твои отложенные сообщения.`, { parse_mode: 'HTML' });
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
        
        if (room && room.size > 0) {
            // Юзер онлайн -> шлем мгновенно
            io.to(clientId).emit('receive_message', { text: msg.text });
            
            bot.sendMessage(adminId, `✅ <b>Ответ доставлен!</b>\nПользователь сейчас на сайте.`, { 
                parse_mode: 'HTML',
                reply_to_message_id: msg.message_id 
            });
        } else {
            // ЮЗЕР ОФФЛАЙН -> КЛАДЕМ В ОЧЕРЕДЬ
            if (!pendingMessages.has(clientId)) {
                pendingMessages.set(clientId, []);
            }
            pendingMessages.get(clientId).push(msg.text);

            bot.sendMessage(adminId, `⏳ <b>Пользователь оффлайн.</b>\nОтвет сохранен в очередь! Как только он зайдет на сайт, бот всё ему передаст.`, { 
                parse_mode: 'HTML',
                reply_to_message_id: msg.message_id 
            });
        }
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
