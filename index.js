const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Данные из настроек Render (Environment Variables)
const token = process.env.BOT_TOKEN;
const adminId = process.env.ADMIN_CHAT_ID;
const bot = new TelegramBot(token, { polling: true });

// Храним соответствие: ID сообщения в ТГ <-> ID сокета на сайте
const messageMap = new Map();

io.on('connection', (socket) => {
    console.log('User connected to site');

    socket.on('send_message', (data) => {
        // Когда юзер пишет на сайте -> шлем админу в ТГ
        bot.sendMessage(adminId, `🌐 Сообщение с сайта:\n\n${data.text}\n\n(Чтобы ответить, просто нажми "Ответить" на это сообщение)` )
        .then((msg) => {
            // Запоминаем, что это сообщение относится к этому юзеру
            messageMap.set(msg.message_id, socket.id);
        });
    });
});

// Когда админ отвечает в Telegram
bot.on('message', (msg) => {
    if (msg.reply_to_message && messageMap.has(msg.reply_to_message.message_id)) {
        const socketId = messageMap.get(msg.reply_to_message.message_id);
        // Шлем ответ конкретному юзеру на сайт
        io.to(socketId).emit('receive_message', { text: msg.text });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));