require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Инициализация Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

console.log('⚡ Инициализация DXTR Game Engine...');

// Хранилище сессий для сложных игр (Мины, Блэкджек, Квиз)
const gameSessions = new Map(); 

// ==========================================
// MIDDLEWARE АВТОРИЗАЦИИ
// ==========================================
const authUser = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Нет токена' });
    
    const token = authHeader.split(' ')[1];
    const { data: { user }, error } = await supabase.auth.getUser(token);
    
    if (error || !user) return res.status(401).json({ error: 'Неверный токен' });
    req.user = user;
    next();
};

// ==========================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ==========================================
async function getBalance(userId) {
    const { data } = await supabase.from('g_users').select('dscoin_balance').eq('id', userId).single();
    return data ? data.dscoin_balance : 0;
}

async function updateBalance(userId, amount) {
    const current = await getBalance(userId);
    const newBal = current + amount;
    await supabase.from('g_users').update({ dscoin_balance: newBal }).eq('id', userId);
    return newBal;
}

app.get('/', (req, res) => res.send('DXTR | SlizZe V2 API Active'));

// ==========================================
// API: ОСНОВА И ЭКОНОМИКА
// ==========================================
app.get('/api/auth/me', authUser, async (req, res) => {
    const { data } = await supabase.from('g_users').select('*').eq('id', req.user.id).single();
    res.json({ success: true, user: data });
});

app.get('/api/games/leaderboard', async (req, res) => {
    const { data, error } = await supabase.from('g_users')
        .select('id, nickname, avatar_url, dscoin_balance')
        .order('dscoin_balance', { ascending: false })
        .limit(5);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, leaders: data });
});

app.post('/api/games/daily', authUser, async (req, res) => {
    const { data: userData } = await supabase.from('g_users').select('last_daily_claim').eq('id', req.user.id).single();
    const now = new Date();
    
    if (userData && userData.last_daily_claim) {
        const lastClaim = new Date(userData.last_daily_claim);
        const diffHours = Math.abs(now - lastClaim) / 36e5;
        if (diffHours < 6) return res.status(400).json({ error: 'Поставка еще не готова' });
    }

    const newBalance = await updateBalance(req.user.id, 100);
    await supabase.from('g_users').update({ last_daily_claim: now.toISOString() }).eq('id', req.user.id);
    
    res.json({ success: true, newBalance, message: 'ПОЛУЧЕНО 100 NC' });
});

// Сброс зависших сессий
app.post('/api/games/reset', authUser, (req, res) => {
    gameSessions.delete(req.user.id);
    res.json({ success: true });
});

// ==========================================
// API: ИГРЫ (ОДНОРАЗОВЫЕ ЗАПРОСЫ)
// ==========================================

// Слоты
app.post('/api/games/slots', authUser, async (req, res) => {
    const { bet } = req.body;
    const balance = await getBalance(req.user.id);
    if (bet > balance || bet <= 0) return res.status(400).json({ error: 'Неверная ставка' });

    await updateBalance(req.user.id, -bet);
    
    // Эмуляция шанса (15% на победу)
    const isWin = Math.random() < 0.15;
    const winAmount = isWin ? bet * 10 : 0;
    
    const newBalance = await updateBalance(req.user.id, winAmount);
    
    // В реальном проекте тут нужно подтягивать картинки из твоей базы
    res.json({ win: winAmount, newBalance, items: [{}, {}, {}] }); 
});

// Дайс
app.post('/api/games/dice', authUser, async (req, res) => {
    const { bet, guess } = req.body; // guess: 1(<25), 2(25-50), 3(51-75), 4(>75)
    const balance = await getBalance(req.user.id);
    if (bet > balance || bet <= 0) return res.status(400).json({ error: 'Неверная ставка' });

    const roll = Math.floor(Math.random() * 100) + 1;
    let isWin = false;
    let mult = 0;

    if (guess === 1 && roll < 25) { isWin = true; mult = 3; }
    else if (guess === 2 && roll >= 25 && roll <= 50) { isWin = true; mult = 2; }
    else if (guess === 3 && roll >= 51 && roll <= 75) { isWin = true; mult = 2; }
    else if (guess === 4 && roll > 75) { isWin = true; mult = 3; }

    await updateBalance(req.user.id, -bet);
    const winAmount = isWin ? bet * mult : 0;
    const newBalance = await updateBalance(req.user.id, winAmount);

    res.json({ roll, win: winAmount, newBalance });
});

// Краш
app.post('/api/games/crash', authUser, async (req, res) => {
    const { bet, targetMultiplier } = req.body;
    const balance = await getBalance(req.user.id);
    if (bet > balance || bet <= 0) return res.status(400).json({ error: 'Неверная ставка' });

    // Классическая математика краша
    const e = 2 ** 32;
    const h = Math.floor(Math.random() * e);
    let crashPoint = Math.max(1.00, Math.floor((100 * e - h) / (e - h)) / 100);
    
    await updateBalance(req.user.id, -bet);
    
    const isWin = targetMultiplier <= crashPoint;
    const winAmount = isWin ? Math.floor(bet * targetMultiplier) : 0;
    const newBalance = await updateBalance(req.user.id, winAmount);

    res.json({ crashPoint, target: targetMultiplier, win: winAmount, newBalance });
});

// Рулетка
app.post('/api/games/roulette', authUser, async (req, res) => {
    const { bet, color } = req.body;
    const balance = await getBalance(req.user.id);
    if (bet > balance || bet <= 0) return res.status(400).json({ error: 'Неверная ставка' });

    const r = Math.random() * 100;
    let resultColor = r < 5 ? 'gold' : (r < 52.5 ? 'cyan' : 'purple');
    
    await updateBalance(req.user.id, -bet);
    
    const isWin = color === resultColor;
    const mult = resultColor === 'gold' ? 14 : 2;
    const winAmount = isWin ? bet * mult : 0;
    const newBalance = await updateBalance(req.user.id, winAmount);

    res.json({ resultColor, isWin, win: winAmount, newBalance });
});

// ==========================================
// SOCKET.IO: ТЕХПОДДЕРЖКА
// ==========================================
io.on('connection', (socket) => {
    io.emit('online_update', io.engine.clientsCount);

    socket.on('register_client', async ({ token }) => {
        if (!token) return;
        try {
            const { data: { user } } = await supabase.auth.getUser(token);
            if (user) {
                const { data } = await supabase.from('g_users').select('nickname, avatar_url').eq('id', user.id).single();
                if (data) {
                    socket.emit('user_data', { nickname: data.nickname, avatarUrl: data.avatar_url });
                    socket.emit('ban_status', { isBanned: false }); // Логика банов
                }
            }
        } catch (e) { console.error("Socket Auth Error"); }
    });

    socket.on('send_message', async (data) => {
        // Здесь можно записывать логи чата в Supabase
        socket.broadcast.emit('receive_message', { 
            text: data.text, 
            isWarning: false, 
            isSuccess: false 
        });
    });

    socket.on('disconnect', () => {
        io.emit('online_update', io.engine.clientsCount);
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`🚀 DXTR Server Online on port ${PORT}`);
});
