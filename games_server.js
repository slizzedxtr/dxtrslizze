const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

// Создаем HTTP сервер и привязываем к нему Socket.io (для чата)
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// ==========================================
// БАЗЫ ДАННЫХ
// ==========================================
const mongoClient = new MongoClient(process.env.MONGODB_URI);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
let usersCollection;

mongoClient.connect().then(() => {
    // Подключаемся к базе по умолчанию из твоего URI
    usersCollection = mongoClient.db().collection('users');
    console.log('✅ MongoDB успешно подключена');
}).catch(console.error);

app.get('/', (req, res) => res.send('DXTR | SlizZe Game & Chat Server Active'));

// ==========================================
// API ЭКОНОМИКИ И ИГР (DSCoin)
// ==========================================

// 1. Синхронизация баланса при входе
app.post('/api/game/sync', async (req, res) => {
    const { clientId } = req.body;
    if (!clientId) return res.status(400).json({ error: 'No clientId' });

    try {
        let user = await usersCollection.findOne({ clientId: String(clientId) });
        if (!user) {
            // Новый пользователь получает 100 DSCoin
            user = { clientId: String(clientId), dscoin_balance: 100, last_sync: Date.now() };
            await usersCollection.insertOne(user);
        }
        res.json({ balance: user.dscoin_balance || 0 });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 2. Синхронизация кликера (сохраняем накликаное)
app.post('/api/game/clicker-sync', async (req, res) => {
    const { clientId, clicks } = req.body;
    if (!clientId || !clicks) return res.status(400).json({ error: 'Invalid data' });

    try {
        const result = await usersCollection.findOneAndUpdate(
            { clientId: String(clientId) },
            { $inc: { dscoin_balance: Number(clicks) } },
            { returnDocument: 'after' }
        );
        res.json({ balance: result.value ? result.value.dscoin_balance : 0 });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 3. Выдача трека для игры "Угадай трек"
app.get('/api/game/guess-track', async (req, res) => {
    try {
        const { data: tracks, error } = await supabase.from('music').select('id, title, mp3_url, cover_url');
        if (error || !tracks || tracks.length < 3) throw new Error('Мало треков в БД');

        const correct = tracks[Math.floor(Math.random() * tracks.length)];
        let options = [correct.title];
        
        while (options.length < 3) {
            let rndTitle = tracks[Math.floor(Math.random() * tracks.length)].title;
            if (!options.includes(rndTitle)) options.push(rndTitle);
        }

        res.json({
            audioUrl: correct.mp3_url,
            options: options.sort(() => Math.random() - 0.5),
            answer: correct.title
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 4. Результат "Угадай трек" (+100 или -50 DSC)
app.post('/api/game/guess-result', async (req, res) => {
    const { clientId, isWin } = req.body;
    try {
        const user = await usersCollection.findOne({ clientId: String(clientId) });
        if (!user) return res.status(404).json({ error: 'User not found' });

        let newBalance = (user.dscoin_balance || 0) + (isWin ? 100 : -50);
        
        await usersCollection.updateOne(
            { clientId: String(clientId) },
            { $set: { dscoin_balance: newBalance } }
        );
        res.json({ newBalance });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 5. Мини-казино (Спины)
app.post('/api/game/casino-spin', async (req, res) => {
    const { clientId } = req.body;
    try {
        const user = await usersCollection.findOne({ clientId: String(clientId) });
        if (!user || (user.dscoin_balance || 0) < 25) {
            return res.status(400).json({ error: 'Недостаточно DSCoin (Нужно 25)' });
        }

        const prizes = [
            { type: 'Пусто', amount: 0, chance: 50 },
            { type: 'Утешительный', amount: 10, chance: 30 },
            { type: 'Победа', amount: 50, chance: 15 },
            { type: 'ДЖЕКПОТ', amount: 250, chance: 5 }
        ];

        // Рандомайзер с учетом шансов
        const rand = Math.random() * 100;
        let cumulative = 0;
        let wonPrize = prizes[0];

        for (let p of prizes) {
            cumulative += p.chance;
            if (rand <= cumulative) { wonPrize = p; break; }
        }

        // Вычитаем 25 за спин и прибавляем выигрыш
        let newBalance = user.dscoin_balance - 25 + wonPrize.amount;
        
        await usersCollection.updateOne(
            { clientId: String(clientId) },
            { $set: { dscoin_balance: newBalance } }
        );

        res.json({ prizeType: wonPrize.type, amount: wonPrize.amount, newBalance });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ==========================================
// SOCKET.IO (ТЕХПОДДЕРЖКА И ОНЛАЙН)
// ==========================================

io.on('connection', (socket) => {
    // При подключении обновляем всем счетчик онлайна
    io.emit('online_update', io.engine.clientsCount);

    // Регистрация клиента (как в твоей админке)
    socket.on('register_client', async (data) => {
        const { clientId, fpHash } = data;
        
        // Тут можно проверять бан пользователя через MongoDB
        // Для примера шлем статус, что не забанен
        socket.emit('ban_status', { isBanned: false });
        
        // Подтягиваем никнейм и аватар, если они есть в БД
        try {
            if (usersCollection) {
                const user = await usersCollection.findOne({ clientId: String(clientId) });
                if (user) {
                    socket.emit('user_data', { nickname: user.nickname, avatarUrl: user.avatarUrl });
                }
            }
        } catch (e) { console.error(e); }
    });

    // Обработка сообщений чата
    socket.on('send_message', (data) => {
        // Рассылаем сообщение (админам/поддержке)
        // В реальной ситуации тут можно сохранять лог в БД
        socket.broadcast.emit('receive_message', {
            text: data.text,
            clientId: data.clientId,
            isWarning: false,
            isSuccess: false
        });
    });

    socket.on('disconnect', () => {
        // При отключении обновляем счетчик
        io.emit('online_update', io.engine.clientsCount);
    });
});

// Запуск сервера (используем server.listen, чтобы работали сокеты)
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`DXTR Game & Chat Engine is running on port ${PORT}`);
});
