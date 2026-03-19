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

// Теперь храним: ID сообщения в ТГ -> Постоянный ID клиента
const messageMap = new Map();

io.on('connection', (socket) => {
    // 1. Юзер заходит (или обновляет страницу) и говорит свой постоянный ID
    socket.on('register_client', (clientId) => {
        socket.join(clientId); // Добавляем сокет в персональную комнату
        console.log(`User registered: ${clientId}`);
    });

    socket.on('send_message', (data) => {
        // Шлем в ТГ с пометкой
        bot.sendMessage(adminId, `🌐 Сообщение с сайта:\n\n${data.text}\n\n(Ответь на это сообщение)`)
        .then((msg) => {
            // Запоминаем, какому Client ID принадлежит сообщение
            messageMap.set(msg.message_id, data.clientId);
        });
    });
});

// Когда админ (ты) отвечает в Telegram
bot.on('message', (msg) => {
    if (msg.reply_to_message && messageMap.has(msg.reply_to_message.message_id)) {
        const clientId = messageMap.get(msg.reply_to_message.message_id);
        // Отправляем ответ конкретно в "комнату" этого Client ID
        io.to(clientId).emit('receive_message', { text: msg.text });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
