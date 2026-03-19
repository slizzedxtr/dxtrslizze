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

// 1. ХРАНИЛИЩА ДАННЫХ
const messageMap = new Map(); // ТГ Message ID -> Client ID сайта
const pendingMessages = new Map(); // Client ID -> [{text, timestamp}] (Очередь)
const EXPIRATION_TIME = 60 * 60 * 1000; // Срок жизни очереди: 1 час

// 2. РАБОТА С ВЕБ-СОКЕТАМИ (САЙТ)
io.on('connection', (socket) => {
    
    // Регистрация клиента (при заходе или обновлении страницы)
    socket.on('register_client', (clientId) => {
        socket.join(clientId);
        console.log(`User connected: ${clientId}`);

        // ПРОВЕРКА ОЧЕРЕДИ ПРИ ВОЗВРАТЕ
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
                bot.sendMessage(adminId, `🔔 <b>Юзер вернулся!</b>\nПользователь <code>${clientId}</code> зашёл на сайт и получил твои ответы из очереди.`, { parse_mode: 'HTML' });
            } else if (expiredCount > 0) {
                bot.sendMessage(adminId, `⚠️ <b>Юзер вернулся слишком поздно.</b>\nПользователь <code>${clientId}</code> зашёл на сайт, но срок ожидания ответов (1ч) истёк.`, { parse_mode: 'HTML' });
            }
            pendingMessages.delete(clientId);
        }
    });

    // Получение сообщения от юзера с сайта
    socket.on('send_message', (data) => {
        const tgMessage = `
🌐 <b>Новый запрос с сайта!</b>

💬 <i>«${data.text}»</i>

👤 ID: <code>${data.clientId}</code>
➖➖➖➖➖➖➖➖➖
💡 <i>Ответь реплаем или используй кнопку:</i>`;

        const options = {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [[{ text: "Spam ⚠️", callback_data: `spam_${data.clientId}` }]]
            }
        };

        bot.sendMessage(adminId, tgMessage, options)
        .then((msg) => {
            messageMap.set(msg.message_id, data.clientId);
        });
    });
});

// 3. ОБРАБОТКА КНОПКИ "SPAM" (CALLBACK QUERY)
bot.on('callback_query', (query) => {
    const userId = query.from.id.toString();
    
    // Только админ может нажать
    if (userId !== adminId.toString()) {
        return bot.answerCallbackQuery(query.id, { text: "Доступ запрещён!", show_alert: true });
    }

    if (query.data.startsWith('spam_')) {
        const clientId = query.data.replace('spam_', ''); // Берем полный ID
        const spamText = "Пожалуйста, не присылайте сообщения которые не имеют смысл или не связаны с темой сайта.";
        
        const room = io.sockets.adapter.rooms.get(clientId);
        
        if (room && room.size > 0) {
            io.to(clientId).emit('receive_message', { text: spamText });
            bot.sendMessage(adminId, `✅ <b>Spam-фильтр:</b> Сообщение доставлено юзеру <code>${clientId}</code>`, { parse_mode: 'HTML' });
        } else {
            if (!pendingMessages.has(clientId)) pendingMessages.set(clientId, []);
            pendingMessages.get(clientId).push({ text: spamText, timestamp: Date.now() });
            bot.sendMessage(adminId, `⏳ <b>Spam-фильтр:</b> Юзер оффлайн. Добавлено в очередь.`, { parse_mode: 'HTML' });
        }

        // Удаляем кнопку из сообщения
        bot.editMessageReplyMarkup({ inline_keyboard: [] }, { 
            chat_id: query.message.chat.id, 
            message_id: query.message.message_id 
        });
        bot.answerCallbackQuery(query.id, { text: "Отправлено" });
    }
});

// 4. ОБРАБОТКА ОБЫЧНОГО ОТВЕТА (REPLY)
bot.on('message', (msg) => {
    // Проверяем, что это ответ на сообщение от бота
    if (msg.reply_to_message && messageMap.has(msg.reply_to_message.message_id)) {
        const clientId = messageMap.get(msg.reply_to_message.message_id);
        const room = io.sockets.adapter.rooms.get(clientId);
        
        if (room && room.size > 0) {
            // ОНЛАЙН: Отправляем сразу
            io.to(clientId).emit('receive_message', { text: msg.text });
            bot.sendMessage(adminId, `✅ <b>Доставлено!</b>`, { 
                reply_to_message_id: msg.message_id, 
                parse_mode: 'HTML' 
            });
        } else {
            // ОФФЛАЙН: В очередь
            if (!pendingMessages.has(clientId)) pendingMessages.set(clientId, []);
            pendingMessages.get(clientId).push({ text: msg.text, timestamp: Date.now() });
            
            bot.sendMessage(adminId, `⏳ <b>Юзер оффлайн.</b>\nСообщение сохранено в очередь (1 час).`, { 
                reply_to_message_id: msg.message_id, 
                parse_mode: 'HTML' 
            });
        }
    }
});

// ЗАПУСК
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
