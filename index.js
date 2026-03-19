const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Данные из настроек Render
const token = process.env.BOT_TOKEN;
const adminId = process.env.ADMIN_CHAT_ID;
const bot = new TelegramBot(token, { polling: true });

// Храним: ID сообщения в ТГ -> Постоянный ID клиента
const messageMap = new Map();

io.on('connection', (socket) => {
    // Регистрация клиента
    socket.on('register_client', (clientId) => {
        socket.join(clientId); // Создаем персональную комнату связи
        console.log(`User registered: ${clientId}`);
    });

    // Прием сообщения с сайта
    socket.on('send_message', (data) => {
        // КРАСИВОЕ ОФОРМЛЕНИЕ СООБЩЕНИЯ В TELEGRAM
        const tgMessage = `
🌐 <b>Новый запрос с сайта!</b>

💬 <i>«${data.text}»</i>

👤 ID: <code>${data.clientId}</code>
➖➖➖➖➖➖➖➖➖
💡 <i>Сделай Reply (Ответить) на это сообщение.</i>
        `;

        bot.sendMessage(adminId, tgMessage, { parse_mode: 'HTML' })
        .then((msg) => {
            // Связываем это сообщение с ID юзера на сайте
            messageMap.set(msg.message_id, data.clientId);
        })
        .catch(err => console.error('Ошибка отправки в ТГ:', err));
    });
});

// Когда ты отвечаешь в Telegram
bot.on('message', (msg) => {
    // Проверяем, что это ответ (Reply) на сообщение от бота
    if (msg.reply_to_message && messageMap.has(msg.reply_to_message.message_id)) {
        const clientId = messageMap.get(msg.reply_to_message.message_id);
        
        // ПРОВЕРКА: ОНЛАЙН ЛИ ЮЗЕР?
        // Смотрим, есть ли активное подключение (сокет) с таким ID
        const room = io.sockets.adapter.rooms.get(clientId);
        
        if (room && room.size > 0) {
            // Юзер на сайте! Отправляем ответ
            io.to(clientId).emit('receive_message', { text: msg.text });
            
            // Отчет об успехе
            bot.sendMessage(adminId, `✅ <b>Ответ доставлен!</b>\nПользователь сейчас на сайте и прочитал сообщение.`, { 
                parse_mode: 'HTML',
                reply_to_message_id: msg.message_id 
            });
        } else {
            // Юзер закрыл вкладку
            bot.sendMessage(adminId, `⚠️ <b>Пользователь оффлайн!</b>\nОн уже ушел с сайта (закрыл вкладку). Ответ не доставлен.`, { 
                parse_mode: 'HTML',
                reply_to_message_id: msg.message_id 
            });
        }
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
