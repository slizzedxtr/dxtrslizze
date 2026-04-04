const jwt = require('jsonwebtoken');

// Секретный ключ (должен совпадать с auth.js)
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_key';

// Константы для пассивного фарма
const FARM_TIME_MINUTES = [30, 25, 20, 15, 10, 5];
const FARM_TIME_COSTS = [750, 1500, 3000, 5000, 10000];
const FARM_INCOME_COINS = [2, 4, 6, 8, 10, 15, 20];
const FARM_INCOME_COSTS = [750, 1500, 3000, 5000, 10000, 17500];

// Константы для игр
const MINES_TOTAL_CELLS = 25;
const BJ_SUITS = ['♠', '♥', '♦', '♣'];
const BJ_RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const PLINKO_MULTS = [10, 3, 1.5, 1, 0.5, 1, 1.5, 3, 10];
const FALLBACK_TITLES = ['Night City Lights', 'Cyber Drop', 'Neon Rain', 'Synthwave Overdrive', 'Netrunner', 'Digital Ghost', 'Neon Blood'];

let musicCache = { data: [], lastFetch: 0 };

module.exports = function(app, User, supabase) {

    // ==========================================
    // ВНУТРЕННИЙ ПОМОЩНИК: АВТОРИЗАЦИЯ
    // ==========================================
    const authenticate = async (req, res) => {
        try {
            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                res.status(401).json({ error: 'Отсутствует токен авторизации' });
                return null;
            }
            const token = authHeader.split(' ')[1];
            const decoded = jwt.verify(token, JWT_SECRET);
            const user = await User.findOne({ clientId: decoded.clientId });
            
            if (!user) {
                res.status(401).json({ error: 'Пользователь не найден' });
                return null;
            }

            // ПАССИВНЫЙ ФАРМ
            if (user.farm && user.farm.active) {
                const now = Date.now();
                const lastClaim = user.farm.lastClaim || now;
                const intervalMs = FARM_TIME_MINUTES[user.farm.timeLevel || 0] * 60 * 1000;
                const income = FARM_INCOME_COINS[user.farm.incomeLevel || 0];
                const timePassed = now - lastClaim;

                if (timePassed >= intervalMs) {
                    const intervals = Math.floor(timePassed / intervalMs);
                    user.dscoin_balance = Math.floor(Number(user.dscoin_balance || 0) + (intervals * income));
                    user.farm.lastClaim = lastClaim + (intervals * intervalMs);
                    user.markModified('farm');
                    await user.save();
                }
            }
            return user;
        } catch (err) {
            res.status(401).json({ error: 'Сессия истекла' });
            return null;
        }
    };

    const getMusicCatalog = async () => {
        const now = Date.now();
        if (musicCache.data.length > 0 && (now - musicCache.lastFetch < 5 * 60 * 1000)) {
            return musicCache.data;
        }
        const { data, error } = await supabase
            .from('music')
            .select('id, cover_url, mp3_url, is_main, title')
            .order('created_at', { ascending: false });

        if (!error && data && data.length > 0) {
            musicCache = { data, lastFetch: now };
            return data;
        }
        return musicCache.data;
    };

    function getMinesMult(mines, opened) {
        if (opened === 0) return 1.0;
        let prob = 1.0;
        for (let i = 0; i < opened; i++) prob *= (MINES_TOTAL_CELLS - mines - i) / (MINES_TOTAL_CELLS - i);
        return parseFloat(((1 / prob) * 0.95).toFixed(2));
    }

    function getBJScore(hand) {
        let score = hand.reduce((a, c) => a + (c.r === 'A' ? 11 : ['J','Q','K'].includes(c.r) ? 10 : parseInt(c.r)), 0);
        let aces = hand.filter(c => c.r === 'A').length;
        while (score > 21 && aces > 0) { score -= 10; aces--; }
        return score;
    }

    // ==========================================
    // 0. ИНФО И ФАРМ
    // ==========================================
    app.get('/api/games/leaderboard', async (req, res) => {
        try {
            const leaders = await User.find({}, 'username nickname dscoin_balance avatarUrl')
                .sort({ dscoin_balance: -1 }).limit(5);
            const processed = leaders.map(l => ({
                username: l.username, nickname: l.nickname, dscoin_balance: l.dscoin_balance,
                avatarUrl: (l.avatarUrl && l.avatarUrl.trim() !== '') ? l.avatarUrl : '/dslogo.png'
            }));
            res.json({ success: true, leaders: processed });
        } catch (err) {
            res.status(500).json({ error: 'Ошибка получения топа' });
        }
    });

    app.post('/api/games/daily', async (req, res) => {
        const user = await authenticate(req, res);
        if (!user) return;
        const now = Date.now();
        const cooldown = 6 * 60 * 60 * 1000;

        if (now - (user.lastDaily || 0) < cooldown) {
            const hoursLeft = Math.ceil((cooldown - (now - (user.lastDaily || 0))) / 3600000);
            return res.status(400).json({ error: `Следующая поставка через ${hoursLeft} ч.` });
        }

        user.dscoin_balance = Math.floor(Number(user.dscoin_balance || 0) + 100);
        user.lastDaily = now;
        await user.save();
        res.json({ success: true, reward: 100, newBalance: user.dscoin_balance, message: 'ПОСТАВКА ПОЛУЧЕНА' });
    });

    app.post('/api/games/farm/activate', async (req, res) => {
        const user = await authenticate(req, res);
        if (!user) return;
        if (user.farm && user.farm.active) return res.status(400).json({ error: 'СИСТЕМА УЖЕ АКТИВИРОВАНА' });
        if (Number(user.dscoin_balance || 0) < 1000) return res.status(400).json({ error: 'НЕДОСТАТОЧНО СРЕДСТВ' });

        user.dscoin_balance = Math.floor(Number(user.dscoin_balance) - 1000);
        user.farm = { active: true, timeLevel: 0, incomeLevel: 0, lastClaim: Date.now() };
        user.markModified('farm');
        await user.save();
        res.json({ success: true, newBalance: user.dscoin_balance, message: 'ФЕРМА АКТИВИРОВАНА' });
    });

    app.get('/api/games/farm/status', async (req, res) => {
        const user = await authenticate(req, res);
        if (!user) return;
        res.json({ success: true, farm: user.farm || { active: false, timeLevel: 0, incomeLevel: 0 } });
    });
    
    app.post('/api/games/farm/upgrade', async (req, res) => {
        const user = await authenticate(req, res);
        if (!user) return;
        if (!user.farm || !user.farm.active) return res.status(400).json({ error: 'СНАЧАЛА АКТИВИРУЙТЕ СИСТЕМУ' });

        const { type } = req.body;
        let cost;

        if (type === 'time') {
            if (user.farm.timeLevel >= FARM_TIME_COSTS.length) return res.status(400).json({ error: 'МАКС. УРОВЕНЬ' });
            cost = FARM_TIME_COSTS[user.farm.timeLevel];
        } else if (type === 'income') {
            if (user.farm.incomeLevel >= FARM_INCOME_COSTS.length) return res.status(400).json({ error: 'МАКС. УРОВЕНЬ' });
            cost = FARM_INCOME_COSTS[user.farm.incomeLevel];
        } else return res.status(400).json({ error: 'НЕВЕРНЫЙ ПАРАМЕТР' });

        if (Number(user.dscoin_balance) < cost) return res.status(400).json({ error: 'НЕДОСТАТОЧНО СРЕДСТВ' });

        user.dscoin_balance = Math.floor(Number(user.dscoin_balance) - cost);
        if (type === 'time') user.farm.timeLevel += 1;
        else user.farm.incomeLevel += 1;

        user.markModified('farm');
        await user.save();
        res.json({ success: true, newBalance: user.dscoin_balance });
    });

    // ==========================================
    // 2. БЕЗГРЕШНЫЕ ИГРЫ (STATELESS)
    // ==========================================
    app.post('/api/games/slots', async (req, res) => {
        const user = await authenticate(req, res);
        if (!user) return;
        const bet = parseInt(req.body.bet, 10);
        if (isNaN(bet) || bet <= 0 || bet > user.dscoin_balance) return res.status(400).json({ error: 'ОШИБКА СТАВКИ' });

        const allTracks = await getMusicCatalog();
        if (!allTracks || allTracks.length === 0) return res.status(500).json({ error: 'Каталог пуст' });

        let slotPool = allTracks.slice(0, 15);
        allTracks.forEach(track => {
            if (track.is_main && !slotPool.some(t => t.cover_url === track.cover_url)) slotPool.push(track);
        });

        const isWin = Math.random() < 0.15;
        let resultTracks = [];
        const getRandomTrack = () => slotPool[Math.floor(Math.random() * slotPool.length)];
        
        if (isWin) {
            let weightedPool = [];
            slotPool.forEach(track => {
                const weight = track.is_main ? 1 : 4;
                for(let i=0; i<weight; i++) weightedPool.push(track);
            });
            const winTrack = weightedPool[Math.floor(Math.random() * weightedPool.length)];
            resultTracks = [winTrack, winTrack, winTrack];
        } else {
            resultTracks = [getRandomTrack(), getRandomTrack(), getRandomTrack()];
            if (resultTracks[0].cover_url === resultTracks[1].cover_url && resultTracks[1].cover_url === resultTracks[2].cover_url) {
                resultTracks[2] = slotPool.find(t => t.cover_url !== resultTracks[0].cover_url) || { id: 999, title: 'Lose', cover_url: '/valuta.png', is_main: false };
            }
        }

        const winTotal = isWin ? bet * (resultTracks[0].is_main ? 10 : 5) : 0;
        user.dscoin_balance = Math.floor(Number(user.dscoin_balance) - bet + winTotal);
        await user.save();

        res.json({
            success: true,
            items: resultTracks.map(t => ({ id: t.id, title: t.title, cover_url: t.cover_url, mp3_url: t.mp3_url, is_main: t.is_main })),
            win: winTotal,
            newBalance: user.dscoin_balance,
            isJackpot: isWin && resultTracks[0].is_main
        });
    });

    app.post('/api/shop/buy', async (req, res) => {
        const user = await authenticate(req, res);
        if (!user) return;
        const { itemType, itemId } = req.body;
        const SHOP_ITEMS = {
            snippet_nightcity: { price: 500, type: 'snippet', name: 'Night City Lights' },
            frame_neon_green: { price: 300, type: 'frame', name: 'Toxic Glow' },
            frame_cyber_pulse: { price: 600, type: 'frame', name: 'Cyber Pulse (Anim)' },
            title_netrunner: { price: 1000, type: 'title', name: 'Netrunner' },
            title_legend: { price: 5000, type: 'title', name: 'Cyber Legend' }
        };

        const item = SHOP_ITEMS[itemId];
        if (!item) return res.status(404).json({ error: 'Товар не найден' });
        if (Number(user.dscoin_balance) < item.price) return res.status(400).json({ error: 'Недостаточно коинов' });

        if (!user.inventory) user.inventory = { frames: [], titles: [], snippets: [] };
        const category = item.type + 's';
        if (!user.inventory[category]) user.inventory[category] = [];

        if (user.inventory[category].includes(itemId)) return res.status(400).json({ error: 'Уже куплено' });

        user.dscoin_balance = Math.floor(Number(user.dscoin_balance) - item.price);
        user.inventory[category].push(itemId);
        
        if (item.type === 'frame') user.activeFrame = itemId;
        if (item.type === 'title') user.activeTitle = item.name;

        user.markModified('inventory');
        await user.save();
        res.json({ success: true, newBalance: user.dscoin_balance, message: `Куплено: ${item.name}` });
    });

    app.post('/api/shop/boost', async (req, res) => {
        const user = await authenticate(req, res);
        if (!user) return;
        const { trackId, amount } = req.body;
        const burnAmount = parseInt(amount, 10);

        if (isNaN(burnAmount) || burnAmount <= 0) return res.status(400).json({ error: 'Укажите сумму буста' });
        if (Number(user.dscoin_balance) < burnAmount) return res.status(400).json({ error: 'Недостаточно средств' });

        user.dscoin_balance = Math.floor(Number(user.dscoin_balance) - burnAmount);
        await user.save();

        const { data: track, error } = await supabase.from('music').select('boosts').eq('id', trackId).single();
        if (!error && track) {
            await supabase.from('music').update({ boosts: (track.boosts || 0) + burnAmount }).eq('id', trackId);
        }
        res.json({ success: true, newBalance: user.dscoin_balance, message: `Трек забущен на ${burnAmount}!` });
    });

    app.post('/api/games/dice', async (req, res) => {
        const user = await authenticate(req, res);
        if (!user) return;
        const bet = parseInt(req.body.bet, 10);
        const choice = parseInt(req.body.guess, 10);
        if (![1, 2, 3, 4].includes(choice) || isNaN(bet) || bet <= 0 || bet > user.dscoin_balance) return res.status(400).json({ error: 'ОШИБКА ДАННЫХ' });

        const roll = Math.floor(Math.random() * 100) + 1;
        let isWin = false, mult = 0;

        if (choice === 1 && roll <= 25) { isWin = true; mult = 3; }
        else if (choice === 2 && roll >= 26 && roll <= 50) { isWin = true; mult = 2; }
        else if (choice === 3 && roll >= 51 && roll <= 75) { isWin = true; mult = 2; }
        else if (choice === 4 && roll >= 76) { isWin = true; mult = 3; }

        const winTotal = isWin ? bet * mult : 0;
        user.dscoin_balance = Math.floor(Number(user.dscoin_balance) - bet + winTotal);
        await user.save();

        res.json({ success: true, roll, win: winTotal, newBalance: user.dscoin_balance });
    });

    app.post('/api/games/crash', async (req, res) => {
        const user = await authenticate(req, res);
        if (!user) return;
        const bet = parseInt(req.body.bet, 10);
        const target = parseFloat(req.body.targetMultiplier);
        if (isNaN(target) || target < 1.1 || isNaN(bet) || bet <= 0 || bet > user.dscoin_balance) return res.status(400).json({ error: 'ОШИБКА ДАННЫХ' });

        const e = 2 ** 32;
        const h = Math.floor(Math.random() * e);
        let crashPoint = Math.max(1.00, (e / (h + 1))); 
        if (crashPoint > 50) crashPoint = 50.00; 
        crashPoint = parseFloat(crashPoint.toFixed(2));

        const isWin = target <= crashPoint;
        const winTotal = isWin ? Math.floor(bet * target) : 0;

        user.dscoin_balance = Math.floor(Number(user.dscoin_balance) - bet + winTotal);
        await user.save();

        res.json({ success: true, crashPoint, target, win: winTotal, newBalance: user.dscoin_balance });
    });

    app.post('/api/games/roulette', async (req, res) => {
        const user = await authenticate(req, res);
        if (!user) return;
        const bet = parseInt(req.body.bet, 10);
        const color = req.body.color; 
        if (!['purple', 'cyan', 'gold'].includes(color) || isNaN(bet) || bet <= 0 || bet > user.dscoin_balance) return res.status(400).json({ error: 'ОШИБКА ДАННЫХ' });

        const roll = Math.random() * 100;
        let resultColor = roll < 5 ? 'gold' : roll < 52.5 ? 'cyan' : 'purple';
        const isWin = color === resultColor;
        const winTotal = isWin ? bet * (resultColor === 'gold' ? 14 : 2) : 0;

        user.dscoin_balance = Math.floor(Number(user.dscoin_balance) - bet + winTotal);
        await user.save();

        res.json({ success: true, resultColor, isWin, win: winTotal, newBalance: user.dscoin_balance });
    });

    app.post('/api/games/plinko', async (req, res) => {
        const user = await authenticate(req, res);
        if (!user) return;
        const bet = parseInt(req.body.bet, 10);
        const count = parseInt(req.body.count, 10);
        if (isNaN(bet) || bet <= 0 || isNaN(count) || count <= 0 || (bet * count) > user.dscoin_balance) return res.status(400).json({ error: 'ОШИБКА СТАВКИ' });

        let results = [];
        let totalWin = 0;

        for(let i=0; i<count; i++) {
            const r = Math.random();
            let bucket;
            if (r < 0.195) bucket = 4;
            else if (r < 0.795) bucket = Math.random() < 0.5 ? 3 : 5;
            else if (r < 0.945) bucket = Math.random() < 0.5 ? 2 : 6;
            else if (r < 0.995) bucket = Math.random() < 0.5 ? 1 : 7;
            else bucket = Math.random() < 0.5 ? 0 : 8;

            const win = Math.floor(bet * PLINKO_MULTS[bucket]);
            totalWin += win;
            results.push({ bucket, win });
        }

        user.dscoin_balance = Math.floor(Number(user.dscoin_balance) - (bet * count) + totalWin);
        await user.save();

        res.json({ success: true, results, newBalance: user.dscoin_balance });
    });
    
    // ==========================================
    // 3. ИГРЫ С СОСТОЯНИЕМ (STATEFUL) - [ФИКСЫ ЗДЕСЬ]
    // ==========================================

    // --- МИНЫ ---
    app.post('/api/games/mines/start', async (req, res) => {
        const user = await authenticate(req, res);
        if (!user) return;
        
        const bet = parseInt(req.body.bet, 10);
        const mines = parseInt(req.body.minesCount, 10);

        if (isNaN(bet) || bet <= 0 || bet > user.dscoin_balance) return res.status(400).json({ error: 'ОШИБКА СТАВКИ' });
        if (isNaN(mines) || mines < 3 || mines > 20) return res.status(400).json({ error: 'НЕВЕРНОЕ КОЛ-ВО МИН' });

        const bombs = [];
        while(bombs.length < mines) {
            const r = Math.floor(Math.random() * 25);
            if(!bombs.includes(r)) bombs.push(r);
        }

        user.dscoin_balance -= bet;
        user.current_game = { type: 'mines', bet, mines, bombs, opened: [], active: true };
        user.markModified('current_game');
        await user.save();

        res.json({ success: true, newBalance: user.dscoin_balance });
    });

    app.post('/api/games/mines/step', async (req, res) => {
        const user = await authenticate(req, res);
        if (!user || !user.current_game || user.current_game.type !== 'mines') return res.status(400).json({ error: 'НЕТ АКТИВНОЙ ИГРЫ' });

        const cellIndex = parseInt(req.body.cellIndex, 10);
        if (isNaN(cellIndex) || cellIndex < 0 || cellIndex > 24) return res.status(400).json({ error: 'Неверная ячейка' });

        const game = user.current_game;

        if (game.bombs.includes(cellIndex)) {
            const bombs = game.bombs;
            user.current_game = null; 
            user.markModified('current_game'); 
            await user.save();
            return res.json({ status: 'lose', bombs });
        }

        if (!game.opened.includes(cellIndex)) game.opened.push(cellIndex);
        const currentMult = getMinesMult(game.mines, game.opened.length);
        user.markModified('current_game');
        await user.save();

        res.json({ status: 'safe', multiplier: currentMult, openedCount: game.opened.length });
    });

    app.post('/api/games/mines/cashout', async (req, res) => {
        const user = await authenticate(req, res);
        if (!user || !user.current_game || user.current_game.type !== 'mines') return res.status(400).json({ error: 'НЕЧЕГО ВЫВОДИТЬ' });

        const game = user.current_game;
        const mult = getMinesMult(game.mines, game.opened.length);
        const win = Math.floor(game.bet * mult);

        user.dscoin_balance += win;
        user.current_game = null;
        user.markModified('current_game');
        await user.save();

        res.json({ success: true, win, newBalance: user.dscoin_balance });
    });

    // --- БЛЭКДЖЕК ---
    app.post('/api/games/bj/start', async (req, res) => {
        const user = await authenticate(req, res);
        if (!user) return;
        
        const bet = parseInt(req.body.bet, 10);
        if (isNaN(bet) || bet <= 0 || bet > user.dscoin_balance) return res.status(400).json({ error: 'ОШИБКА СТАВКИ' });

        const deck = [];
        BJ_SUITS.forEach(s => BJ_RANKS.forEach(r => deck.push({ r, s })));
        deck.sort(() => 0.5 - Math.random());

        const playerHand = [deck.pop(), deck.pop()];
        const dealerHand = [deck.pop(), deck.pop()];

        user.dscoin_balance -= bet;
        user.current_game = { type: 'bj', bet, deck, playerHand, dealerHand, active: true };
        user.markModified('current_game');
        await user.save();

        res.json({ success: true, playerHand, dealerCard: dealerHand[0], newBalance: user.dscoin_balance });
    });

    app.post('/api/games/bj/hit', async (req, res) => {
        const user = await authenticate(req, res);
        if (!user || !user.current_game || user.current_game.type !== 'bj') return res.status(400).json({ error: 'Нет игры' });
        
        const card = user.current_game.deck.pop();
        user.current_game.playerHand.push(card);
        const score = getBJScore(user.current_game.playerHand);

        if (score > 21) {
            user.current_game = null;
            user.markModified('current_game');
            await user.save();
            return res.json({ status: 'bust', card, score });
        }

        user.markModified('current_game');
        await user.save();
        res.json({ status: 'continue', card, score });
    });

    app.post('/api/games/bj/stand', async (req, res) => {
        const user = await authenticate(req, res);
        if (!user || !user.current_game || user.current_game.type !== 'bj') return res.status(400).json({ error: 'Ошибка' });

        const game = user.current_game;
        let dScore = getBJScore(game.dealerHand);
        
        while(dScore < 17 && game.deck.length > 0) {
            game.dealerHand.push(game.deck.pop());
            dScore = getBJScore(game.dealerHand);
        }

        const pScore = getBJScore(game.playerHand);
        let win = 0;
        
        if (pScore === 21 && game.playerHand.length === 2 && dScore !== 21) win = Math.floor(game.bet * 2.5);
        else if (dScore > 21 || pScore > dScore) win = Math.floor(game.bet * 2);
        else if (pScore === dScore) win = game.bet;

        user.dscoin_balance += win;
        user.current_game = null;
        user.markModified('current_game');
        await user.save();

        res.json({ win, pScore, dScore, dealerHand: game.dealerHand, newBalance: user.dscoin_balance });
    });

    // --- КВИЗ (Neuro-Quiz) ---
    app.post('/api/games/quiz/start', async (req, res) => {
        const user = await authenticate(req, res);
        if (!user) return;
        const bet = parseInt(req.body.bet, 10);
        if (isNaN(bet) || bet <= 0 || bet > user.dscoin_balance) return res.status(400).json({ error: 'ОШИБКА СТАВКИ' });

        const catalog = await getMusicCatalog();
        const validTracks = catalog.filter(t => t.cover_url && t.title);
        if (validTracks.length === 0) return res.status(500).json({ error: 'База треков пуста' });

        const correctTrack = validTracks[Math.floor(Math.random() * validTracks.length)];
        
        let uniqueTitles = new Set(validTracks.map(t => t.title));
        FALLBACK_TITLES.forEach(t => uniqueTitles.add(t)); 
        uniqueTitles.delete(correctTrack.title); 

        let optionsArray = Array.from(uniqueTitles).sort(() => 0.5 - Math.random());
        let options = [correctTrack.title, optionsArray[0], optionsArray[1], optionsArray[2]];
        options.sort(() => 0.5 - Math.random()); 

        user.dscoin_balance -= bet;
        user.current_game = { type: 'quiz', bet, correctTitle: correctTrack.title, streak: req.body.streak || 0, active: true };
        user.markModified('current_game');
        await user.save();

        res.json({ success: true, coverUrl: correctTrack.cover_url, options, newBalance: user.dscoin_balance });
    });

    app.post('/api/games/quiz/answer', async (req, res) => {
        const user = await authenticate(req, res);
        if (!user || !user.current_game || user.current_game.type !== 'quiz') return res.status(400).json({ error: 'ИГРА НЕ НАЙДЕНА' });

        const { answer } = req.body;
        const game = user.current_game;
        let win = 0;
        let newStreak = 0;

        const cleanAnswer = String(answer).trim().toLowerCase();
        const cleanCorrect = String(game.correctTitle).trim().toLowerCase();
        const isCorrect = (cleanAnswer === cleanCorrect);

        if (isCorrect) {
            newStreak = game.streak + 1;
            const mult = 1 + (newStreak * 0.5);
            win = Math.floor(game.bet * mult);
            user.dscoin_balance += win;
        }

        user.current_game = null;
        user.markModified('current_game');
        await user.save();

        res.json({ success: true, isCorrect: isCorrect, win, newStreak, newBalance: user.dscoin_balance, correctTitle: game.correctTitle });
    });

    // --- БИТ (Predict The Beat) ---
    app.post('/api/games/ptb/start', async (req, res) => {
        const user = await authenticate(req, res);
        if (!user) return;
        const bet = parseInt(req.body.bet, 10);
        if (isNaN(bet) || bet <= 0 || bet > user.dscoin_balance) return res.status(400).json({ error: 'ОШИБКА СТАВКИ' });

        user.dscoin_balance -= bet;
        user.current_game = { type: 'ptb', bet, round: 0, correctAnswers: 0, active: true };
        user.markModified('current_game');
        await user.save();

        res.json({ success: true, newBalance: user.dscoin_balance });
    });

    app.post('/api/games/ptb/round', async (req, res) => {
        const user = await authenticate(req, res);
        if (!user || !user.current_game || user.current_game.type !== 'ptb') return res.status(400).json({ error: 'Нет активной игры' });

        const catalog = await getMusicCatalog();
        const validAudio = catalog.filter(t => t.mp3_url && t.title);
        
        if (validAudio.length === 0) return res.status(500).json({ error: 'База аудио пуста' });

        const correctTrack = validAudio[Math.floor(Math.random() * validAudio.length)];

        let uniqueTitles = new Set(validAudio.map(t => t.title));
        FALLBACK_TITLES.forEach(t => uniqueTitles.add(t));
        uniqueTitles.delete(correctTrack.title);

        let optionsArray = Array.from(uniqueTitles).sort(() => 0.5 - Math.random());
        let options = [correctTrack.title, optionsArray[0], optionsArray[1], optionsArray[2]];
        options.sort(() => 0.5 - Math.random());

        user.current_game.round += 1;
        user.current_game.currentCorrectTitle = correctTrack.title;
        user.markModified('current_game');
        await user.save();

        res.json({ success: true, mp3Url: correctTrack.mp3_url, options, round: user.current_game.round });
    });

    app.post('/api/games/ptb/answer', async (req, res) => {
        const user = await authenticate(req, res);
        if (!user || !user.current_game || user.current_game.type !== 'ptb') return res.status(400).json({ error: 'Нет игры' });

        const { answer } = req.body;
        const game = user.current_game;
        
        const cleanAnswer = String(answer).trim().toLowerCase();
        const cleanCorrect = String(game.currentCorrectTitle).trim().toLowerCase();
        const isCorrect = (cleanAnswer === cleanCorrect);

        if (isCorrect) game.correctAnswers++;

        let win = 0;
        let isFinished = false;

        if (game.round >= 5) {
            isFinished = true;
            const ratio = game.correctAnswers / 5;
            const mult = ratio >= 0.8 ? 3 : ratio >= 0.6 ? 2 : ratio >= 0.4 ? 1.5 : ratio >= 0.2 ? 1 : 0;
            win = Math.floor(game.bet * mult);
            user.dscoin_balance += win;
            user.current_game = null; 
        }

        user.markModified('current_game');
        await user.save();

        res.json({ success: true, isCorrect, isFinished, correctAnswers: game ? game.correctAnswers : 0, win, newBalance: user.dscoin_balance });
    });

}; // <--- ВОТ ТЕПЕРЬ ОНА НА СВОЕМ ЗАКОННОМ МЕСТЕ В САМОМ КОНЦЕ
