const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_key';

const FARM_TIME_MINUTES  = [30, 25, 20, 15, 10, 5];
const FARM_TIME_COSTS    = [750, 1500, 3000, 5000, 10000];
const FARM_INCOME_COINS  = [2, 4, 6, 8, 10, 15, 20];
const FARM_INCOME_COSTS  = [750, 1500, 3000, 5000, 10000, 17500];

const MINES_TOTAL_CELLS = 25;
const BJ_SUITS  = ['♠', '♥', '♦', '♣'];
const BJ_RANKS  = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
const PLINKO_MULTS = [10, 3, 1.5, 1, 0.5, 1, 1.5, 3, 10];
const FALLBACK_TITLES = [
    'Night City Lights','Cyber Drop','Neon Rain',
    'Synthwave Overdrive','Netrunner','Digital Ghost','Neon Blood'
];

let musicCache = { data: [], lastFetch: 0 };

module.exports = function(app, User, supabase) {

    // ══════════════════════════════════════════════════════════════
    // БЕЗОПАСНОЕ СОХРАНЕНИЕ (Обход строгих схем Mongoose)
    // ══════════════════════════════════════════════════════════════
    async function saveUser(user, updates) {
        await User.updateOne(
            { _id: user._id },
            { $set: updates },
            { strict: false }
        );
        Object.assign(user, updates);
    }

    const getBody = (req) => req.body || {};
    const safeBalance = (user) => Number(user.dscoin_balance) || 0;

    // ══════════════════════════════════════════════════════════════
    // АУТЕНТИФИКАЦИЯ (С ФИКСОМ СЕССИЙ)
    // ══════════════════════════════════════════════════════════════
    const authenticate = async (req, res) => {
        try {
            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                res.status(401).json({ error: 'Отсутствует токен авторизации' });
                return null;
            }

            const token = authHeader.split(' ')[1];
            const decoded = jwt.verify(token, JWT_SECRET);

            // ФИКС: .lean() вытаскивает current_game из базы напрямую
            let user = await User.findOne({ clientId: decoded.clientId }).lean();

            if (!user) {
                res.status(401).json({ error: 'Пользователь не найден' });
                return null;
            }

            if (user.farm && user.farm.active) {
                const now = Date.now();
                const lastClaim = user.farm.lastClaim || now;
                const intervalMs = FARM_TIME_MINUTES[user.farm.timeLevel || 0] * 60 * 1000;
                const income = FARM_INCOME_COINS[user.farm.incomeLevel || 0];
                const timePassed = now - lastClaim;

                if (timePassed >= intervalMs) {
                    const intervals = Math.floor(timePassed / intervalMs);
                    const newBalance = Math.floor(safeBalance(user) + intervals * income);
                    const newLastClaim = lastClaim + intervals * intervalMs;

                    await saveUser(user, {
                        dscoin_balance: newBalance,
                        'farm.lastClaim': newLastClaim
                    });
                }
            }

            user = await User.findOne({ clientId: decoded.clientId }).lean();
            return user;
        } catch (err) {
            console.error('Auth error:', err);
            res.status(401).json({ error: 'Сессия истекла' });
            return null;
        }
    };

    // ══════════════════════════════════════════════════════════════
    // ЗАГРУЗКА МУЗЫКАЛЬНОГО КАТАЛОГА
    // ══════════════════════════════════════════════════════════════
    const getMusicCatalog = async () => {
        const now = Date.now();
        if (musicCache.data.length > 0 && now - musicCache.lastFetch < 5 * 60 * 1000) {
            return musicCache.data;
        }

        try {
            const { data, error } = await supabase
                .from('music')
                .select('id, cover_url, mp3_url, is_main, title')
                .order('created_at', { ascending: false });

            if (!error && data && data.length > 0) {
                musicCache = { data, lastFetch: now };
                return data;
            }
        } catch(e) {
            console.error("Supabase load error:", e);
        }

        return [
            { id: 1, title: 'Night City Lights', cover_url: '/dslogo.png', mp3_url: '', is_main: true }
        ];
    };

    app.get('/api/tracks', async (req, res) => {
        try {
            const tracks = await getMusicCatalog();
            res.json(tracks.map(t => ({
                id:        t.id,
                title:     t.title,
                cover_url: t.cover_url,
                mp3_url:   t.mp3_url,
                is_main:   t.is_main
            })));
        } catch (e) {
            res.status(500).json({ error: 'Ошибка загрузки треков' });
        }
    });

    // ══════════════════════════════════════════════════════════════
    // ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ИГР
    // ══════════════════════════════════════════════════════════════
    function getMinesMult(mines, opened) {
        if (opened === 0) return 1.0;
        let prob = 1.0;
        for (let i = 0; i < opened; i++) prob *= (MINES_TOTAL_CELLS - mines - i) / (MINES_TOTAL_CELLS - i);
        return parseFloat(((1 / prob) * 0.95).toFixed(2));
    }

    function getBJScore(hand) {
        let score = hand.reduce((a, c) => a + (c.r === 'A' ? 11 : ['J','Q','K'].includes(c.r) ? 10 : parseInt(c.r, 10)), 0);
        let aces = hand.filter(c => c.r === 'A').length;
        while (score > 21 && aces > 0) { score -= 10; aces--; }
        return score;
    }

    // ══════════════════════════════════════════════════════════════
    // ЛИДЕРБОРД
    // ══════════════════════════════════════════════════════════════
    app.get('/api/games/leaderboard', async (req, res) => {
        try {
            const leaders = await User.find({}, 'username nickname dscoin_balance avatarUrl').sort({ dscoin_balance: -1 }).limit(5);
            res.json({
                success: true,
                leaders: leaders.map(l => ({
                    username:        l.username,
                    nickname:        l.nickname,
                    dscoin_balance:  l.dscoin_balance,
                    avatarUrl:       l.avatarUrl && l.avatarUrl.trim() ? l.avatarUrl : '/dslogo.png'
                }))
            });
        } catch (err) {
            res.status(500).json({ error: 'Ошибка получения топа' });
        }
    });

    // ══════════════════════════════════════════════════════════════
    // ЕЖЕДНЕВНАЯ ПОСТАВКА
    // ══════════════════════════════════════════════════════════════
    app.post('/api/games/daily', async (req, res) => {
        const user = await authenticate(req, res);
        if (!user) return;

        const now = Date.now();
        const cooldown = 6 * 60 * 60 * 1000;

        if (now - (user.lastDaily || 0) < cooldown) {
            const hoursLeft = Math.ceil((cooldown - (now - (user.lastDaily || 0))) / 3600000);
            return res.status(400).json({ error: `Следующая поставка через ${hoursLeft} ч.` });
        }

        await saveUser(user, { dscoin_balance: Math.floor(safeBalance(user) + 100), lastDaily: now });
        res.json({ success: true, reward: 100, newBalance: user.dscoin_balance, message: 'ПОСТАВКА ПОЛУЧЕНА' });
    });

    // ══════════════════════════════════════════════════════════════
    // ФЕРМА
    // ══════════════════════════════════════════════════════════════
    app.post('/api/games/farm/activate', async (req, res) => {
        const user = await authenticate(req, res);
        if (!user) return;
        const balance = safeBalance(user);
        
        if (user.farm && user.farm.active) return res.status(400).json({ error: 'СИСТЕМА УЖЕ АКТИВИРОВАНА' });
        if (balance < 1000) return res.status(400).json({ error: 'НЕДОСТАТОЧНО СРЕДСТВ' });

        await saveUser(user, { dscoin_balance: Math.floor(balance - 1000), farm: { active: true, timeLevel: 0, incomeLevel: 0, lastClaim: Date.now() } });
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

        const { type } = getBody(req);
        const balance = safeBalance(user);
        let cost;

        if (type === 'time') {
            if (user.farm.timeLevel >= FARM_TIME_COSTS.length) return res.status(400).json({ error: 'МАКС. УРОВЕНЬ' });
            cost = FARM_TIME_COSTS[user.farm.timeLevel];
        } else if (type === 'income') {
            if (user.farm.incomeLevel >= FARM_INCOME_COSTS.length) return res.status(400).json({ error: 'МАКС. УРОВЕНЬ' });
            cost = FARM_INCOME_COSTS[user.farm.incomeLevel];
        } else return res.status(400).json({ error: 'НЕВЕРНЫЙ ПАРАМЕТР' });

        if (balance < cost) return res.status(400).json({ error: 'НЕДОСТАТОЧНО СРЕДСТВ' });

        const newFarm = { ...user.farm };
        if (type === 'time') newFarm.timeLevel += 1;
        else newFarm.incomeLevel += 1;

        await saveUser(user, { dscoin_balance: Math.floor(balance - cost), farm: newFarm });
        res.json({ success: true, newBalance: user.dscoin_balance });
    });

    // ══════════════════════════════════════════════════════════════
    // СБРОС ЗАВИСШЕЙ ИГРЫ
    // ══════════════════════════════════════════════════════════════
    app.post('/api/games/reset', async (req, res) => {
        const user = await authenticate(req, res);
        if (!user) return;
        await saveUser(user, { current_game: null });
        res.json({ success: true, message: 'ИГРОВАЯ СЕССИЯ СБРОШЕНА' });
    });

    // ══════════════════════════════════════════════════════════════
    // СЛОТЫ
    // ══════════════════════════════════════════════════════════════
    app.post('/api/games/slots', async (req, res) => {
        const user = await authenticate(req, res);
        if (!user) return;

        const bet = parseInt(getBody(req).bet, 10);
        const balance = safeBalance(user);

        if (isNaN(bet) || bet <= 0 || bet > balance) return res.status(400).json({ error: 'ОШИБКА СТАВКИ' });

        const allTracks = await getMusicCatalog();
        if (!allTracks || allTracks.length === 0) return res.status(500).json({ error: 'Каталог пуст' });

        let slotPool = allTracks.slice(0, 15);
        allTracks.forEach(track => { if (track.is_main && !slotPool.some(t => t.cover_url === track.cover_url)) slotPool.push(track); });

        const isWin = Math.random() < 0.15;
        let resultTracks = [];
        const getRand = () => slotPool[Math.floor(Math.random() * slotPool.length)];

        if (isWin) {
            let weighted = [];
            slotPool.forEach(t => { const w = t.is_main ? 1 : 4; for (let i = 0; i < w; i++) weighted.push(t); });
            const winTrack = weighted[Math.floor(Math.random() * weighted.length)];
            resultTracks = [winTrack, winTrack, winTrack];
        } else {
            resultTracks = [getRand(), getRand(), getRand()];
            if (resultTracks[0].cover_url === resultTracks[1].cover_url && resultTracks[1].cover_url === resultTracks[2].cover_url) {
                const diffTrack = slotPool.find(t => t.cover_url !== resultTracks[0].cover_url);
                resultTracks[2] = diffTrack || { id: 999, title: 'Lose', cover_url: '/valuta.png', is_main: false };
            }
        }

        const winTotal = isWin ? bet * (resultTracks[0].is_main ? 10 : 5) : 0;
        await saveUser(user, { dscoin_balance: Math.floor(balance - bet + winTotal) });

        res.json({
            success: true,
            items: resultTracks.map(t => ({ id: t.id, title: t.title, cover_url: t.cover_url, mp3_url: t.mp3_url, is_main: t.is_main })),
            win: winTotal,
            newBalance: user.dscoin_balance,
            isJackpot: isWin && resultTracks[0].is_main
        });
    });

    // ══════════════════════════════════════════════════════════════
    // ДАЙС
    // ══════════════════════════════════════════════════════════════
    app.post('/api/games/dice', async (req, res) => {
        const user = await authenticate(req, res);
        if (!user) return;

        const body = getBody(req);
        const bet = parseInt(body.bet, 10);
        const choice = parseInt(body.guess, 10);
        const balance = safeBalance(user);

        if (![1,2,3,4].includes(choice) || isNaN(bet) || bet <= 0 || bet > balance) return res.status(400).json({ error: 'ОШИБКА ДАННЫХ' });

        const roll = Math.floor(Math.random() * 100) + 1;
        let isWin = false, mult = 0;

        if      (choice === 1 && roll <= 25) { isWin = true; mult = 3; }
        else if (choice === 2 && roll >= 26 && roll <= 50) { isWin = true; mult = 2; }
        else if (choice === 3 && roll >= 51 && roll <= 75) { isWin = true; mult = 2; }
        else if (choice === 4 && roll >= 76) { isWin = true; mult = 3; }

        const winTotal = isWin ? bet * mult : 0;
        await saveUser(user, { dscoin_balance: Math.floor(balance - bet + winTotal) });
        res.json({ success: true, roll, win: winTotal, newBalance: user.dscoin_balance });
    });

    // ══════════════════════════════════════════════════════════════
    // КРАШ
    // ══════════════════════════════════════════════════════════════
    app.post('/api/games/crash', async (req, res) => {
        const user = await authenticate(req, res);
        if (!user) return;

        const body = getBody(req);
        const bet = parseInt(body.bet, 10);
        const target = parseFloat(body.targetMultiplier);
        const balance = safeBalance(user);

        if (isNaN(target) || target < 1.1 || isNaN(bet) || bet <= 0 || bet > balance) return res.status(400).json({ error: 'ОШИБКА ДАННЫХ' });

        const e = 2 ** 32;
        const h = Math.floor(Math.random() * e);
        let crashPoint = Math.max(1.00, e / (h + 1));
        if (crashPoint > 50) crashPoint = 50.00;
        crashPoint = parseFloat(crashPoint.toFixed(2));

        const isWin = target <= crashPoint;
        const winTotal = isWin ? Math.floor(bet * target) : 0;

        await saveUser(user, { dscoin_balance: Math.floor(balance - bet + winTotal) });
        res.json({ success: true, crashPoint, target, win: winTotal, newBalance: user.dscoin_balance });
    });

    // ══════════════════════════════════════════════════════════════
    // РУЛЕТКА
    // ══════════════════════════════════════════════════════════════
    app.post('/api/games/roulette', async (req, res) => {
        const user = await authenticate(req, res);
        if (!user) return;

        const body = getBody(req);
        const bet = parseInt(body.bet, 10);
        const color = body.color;
        const balance = safeBalance(user);

        if (!['purple','cyan','gold'].includes(color) || isNaN(bet) || bet <= 0 || bet > balance) return res.status(400).json({ error: 'ОШИБКА ДАННЫХ' });

        const roll = Math.random() * 100;
        const resultColor = roll < 5 ? 'gold' : roll < 52.5 ? 'cyan' : 'purple';
        const isWin = color === resultColor;
        const winTotal = isWin ? bet * (resultColor === 'gold' ? 14 : 2) : 0;

        await saveUser(user, { dscoin_balance: Math.floor(balance - bet + winTotal) });
        res.json({ success: true, resultColor, isWin, win: winTotal, newBalance: user.dscoin_balance });
    });

    // ══════════════════════════════════════════════════════════════
    // ПЛИНКО
    // ══════════════════════════════════════════════════════════════
    app.post('/api/games/plinko', async (req, res) => {
        const user  = await authenticate(req, res);
        if (!user) return;

        const body = getBody(req);
        const bet   = parseInt(body.bet, 10);
        const count = parseInt(body.count, 10);
        const balance = safeBalance(user);

        if (isNaN(bet) || bet <= 0 || isNaN(count) || count <= 0 || bet * count > balance) return res.status(400).json({ error: 'ОШИБКА СТАВКИ' });
        if (count > 50) return res.status(400).json({ error: 'МАКСИМУМ 50 ШАРОВ' });

        let results  = [];
        let totalWin = 0;

        for (let i = 0; i < count; i++) {
            const r = Math.random();
            let bucket;
            if      (r < 0.550) bucket = 4;
            else if (r < 0.850) bucket = Math.random() < 0.5 ? 3 : 5;
            else if (r < 0.950) bucket = Math.random() < 0.5 ? 2 : 6;
            else if (r < 0.995) bucket = Math.random() < 0.5 ? 1 : 7;
            else                bucket = Math.random() < 0.5 ? 0 : 8;

            const win = Math.floor(bet * PLINKO_MULTS[bucket]);
            totalWin += win;
            results.push({ bucket, win });
        }

        await saveUser(user, { dscoin_balance: Math.floor(balance - bet * count + totalWin) });
        res.json({ success: true, results, newBalance: user.dscoin_balance });
    });

    // ══════════════════════════════════════════════════════════════
    // МИНЫ
    // ══════════════════════════════════════════════════════════════
    app.post('/api/games/mines/start', async (req, res) => {
        const user = await authenticate(req, res);
        if (!user) return;

        const body = getBody(req);
        const bet   = parseInt(body.bet, 10);
        const mines = parseInt(body.minesCount, 10);
        const balance = safeBalance(user);

        if (isNaN(bet) || bet <= 0 || bet > balance) return res.status(400).json({ error: 'ОШИБКА СТАВКИ' });
        if (isNaN(mines) || mines < 3 || mines > 20) return res.status(400).json({ error: 'НЕВЕРНОЕ КОЛ-ВО МИН' });

        const bombs = [];
        while (bombs.length < mines) {
            const r = Math.floor(Math.random() * 25);
            if (!bombs.includes(r)) bombs.push(r);
        }

        await saveUser(user, {
            dscoin_balance: balance - bet,
            current_game: { type: 'mines', bet, mines, bombs, opened: [], active: true }
        });

        res.json({ success: true, newBalance: user.dscoin_balance });
    });

    app.post('/api/games/mines/step', async (req, res) => {
        const user = await authenticate(req, res);
        if (!user) return;

        const cellIndex = parseInt(getBody(req).cellIndex, 10);

        if (!user.current_game || user.current_game.type !== 'mines' || !user.current_game.active) {
            return res.status(400).json({ error: 'НЕТ АКТИВНОЙ ИГРЫ В МИНАХ' });
        }
        if (isNaN(cellIndex) || cellIndex < 0 || cellIndex > 24) return res.status(400).json({ error: 'НЕВЕРНАЯ ЯЧЕЙКА' });

        const game = user.current_game;

        if (game.bombs.includes(cellIndex)) {
            const bombs = [...game.bombs];
            await saveUser(user, { current_game: null });
            return res.json({ status: 'lose', bombs });
        }

        const opened = [...(game.opened || [])];
        if (!opened.includes(cellIndex)) opened.push(cellIndex);
        const currentMult = getMinesMult(game.mines, opened.length);

        await saveUser(user, { current_game: { ...game, opened } });
        res.json({ status: 'safe', multiplier: currentMult, openedCount: opened.length });
    });

    app.post('/api/games/mines/cashout', async (req, res) => {
        const user = await authenticate(req, res);
        if (!user) return;

        if (!user.current_game || user.current_game.type !== 'mines' || !user.current_game.active) {
            return res.status(400).json({ error: 'НЕЧЕГО ВЫВОДИТЬ' });
        }

        const game = user.current_game;
        const mult = getMinesMult(game.mines, (game.opened || []).length);
        const win  = Math.floor(game.bet * mult);

        await saveUser(user, {
            dscoin_balance: safeBalance(user) + win,
            current_game: null
        });

        res.json({ success: true, win, newBalance: user.dscoin_balance });
    });

    // ══════════════════════════════════════════════════════════════
    // БЛЭКДЖЕК
    // ══════════════════════════════════════════════════════════════
    app.post('/api/games/bj/start', async (req, res) => {
        const user = await authenticate(req, res);
        if (!user) return;

        const bet = parseInt(getBody(req).bet, 10);
        const balance = safeBalance(user);

        if (isNaN(bet) || bet <= 0 || bet > balance) return res.status(400).json({ error: 'ОШИБКА СТАВКИ' });

        const deck = [];
        BJ_SUITS.forEach(s => BJ_RANKS.forEach(r => deck.push({ r, s })));
        deck.sort(() => 0.5 - Math.random());

        const playerHand = [deck.pop(), deck.pop()];
        const dealerHand = [deck.pop(), deck.pop()];

        await saveUser(user, {
            dscoin_balance: balance - bet,
            current_game: { type: 'bj', bet: bet, deck: deck, playerHand: playerHand, dealerHand: dealerHand, active: true }
        });

        res.json({ success: true, playerHand, dealerCard: dealerHand[0], newBalance: user.dscoin_balance });
    });

    app.post('/api/games/bj/hit', async (req, res) => {
        const user = await authenticate(req, res);
        if (!user) return;

        if (!user.current_game || user.current_game.type !== 'bj' || !user.current_game.active) {
            return res.status(400).json({ error: 'НЕТ АКТИВНОЙ ИГРЫ В БЛЭКДЖЕКЕ' });
        }

        const game = user.current_game;
        const deck = [...(game.deck || [])];
        const card = deck.pop();
        const playerHand = [...(game.playerHand || []), card];
        const score = getBJScore(playerHand);

        if (score > 21) {
            await saveUser(user, { current_game: null });
            return res.json({ status: 'bust', card, score });
        }

        await saveUser(user, { current_game: { ...game, deck, playerHand } });
        res.json({ status: 'continue', card, score });
    });

    app.post('/api/games/bj/stand', async (req, res) => {
        const user = await authenticate(req, res);
        if (!user) return;

        if (!user.current_game || user.current_game.type !== 'bj' || !user.current_game.active) {
            return res.status(400).json({ error: 'НЕТ АКТИВНОЙ ИГРЫ В БЛЭКДЖЕКЕ' });
        }

        const game = user.current_game;
        let deck = [...(game.deck || [])];
        let dealerHand = [...(game.dealerHand || [])];
        let dScore = getBJScore(dealerHand);

        while (dScore < 17 && deck.length > 0) {
            dealerHand.push(deck.pop());
            dScore = getBJScore(dealerHand);
        }

        const pScore = getBJScore(game.playerHand || []);
        let win = 0;

        if      (pScore === 21 && (game.playerHand || []).length === 2 && dScore !== 21) win = Math.floor(game.bet * 2.5);
        else if (dScore > 21 || pScore > dScore) win = Math.floor(game.bet * 2);
        else if (pScore === dScore) win = game.bet;

        await saveUser(user, { dscoin_balance: safeBalance(user) + win, current_game: null });
        res.json({ win, pScore, dScore, dealerHand, newBalance: user.dscoin_balance });
    });

    // ══════════════════════════════════════════════════════════════
    // КВИЗ (Neuro-Quiz)
    // ══════════════════════════════════════════════════════════════
    app.post('/api/games/quiz/start', async (req, res) => {
        const user = await authenticate(req, res);
        if (!user) return;

        const body = getBody(req);
        const bet = parseInt(body.bet, 10);
        const balance = safeBalance(user);

        if (isNaN(bet) || bet <= 0 || bet > balance) return res.status(400).json({ error: 'ОШИБКА СТАВКИ' });

        const catalog = await getMusicCatalog();
        const validTracks = catalog.filter(t => t.cover_url && t.title);
        if (validTracks.length === 0) return res.status(500).json({ error: 'База пуста' });

        const correctTrack = validTracks[Math.floor(Math.random() * validTracks.length)];

        let uniqueTitles = new Set(validTracks.map(t => t.title));
        FALLBACK_TITLES.forEach(t => uniqueTitles.add(t));
        uniqueTitles.delete(correctTrack.title);

        const optionsArray = Array.from(uniqueTitles).sort(() => 0.5 - Math.random());
        const options = [correctTrack.title, optionsArray[0], optionsArray[1], optionsArray[2]].sort(() => 0.5 - Math.random());

        await saveUser(user, {
            dscoin_balance: balance - bet,
            current_game: { type: 'quiz', bet: bet, correctTitle: correctTrack.title.trim(), streak: parseInt(body.streak, 10) || 0, active: true }
        });

        res.json({ success: true, coverUrl: correctTrack.cover_url, options, newBalance: user.dscoin_balance });
    });

    app.post('/api/games/quiz/answer', async (req, res) => {
        const user = await authenticate(req, res);
        if (!user) return;

        if (!user.current_game || user.current_game.type !== 'quiz' || !user.current_game.active) {
            return res.status(400).json({ error: 'НЕТ АКТИВНОЙ ИГРЫ В КВИЗЕ' });
        }

        const answer = getBody(req).answer;
        const game = user.current_game;
        const cleanAnswer = String(answer || '').trim().toLowerCase();
        const cleanCorrect = String(game.correctTitle || '').trim().toLowerCase();
        const isCorrect = cleanAnswer === cleanCorrect;

        let win = 0, newStreak = 0;

        if (isCorrect) {
            newStreak = (game.streak || 0) + 1;
            win = Math.floor(game.bet * (1 + newStreak * 0.5));
        }

        await saveUser(user, { dscoin_balance: safeBalance(user) + win, current_game: null });

        res.json({ success: true, isCorrect, win, newStreak, newBalance: user.dscoin_balance, correctTitle: game.correctTitle });
    });

    // ══════════════════════════════════════════════════════════════
    // БИТ (Predict The Beat)
    // ══════════════════════════════════════════════════════════════
    app.post('/api/games/ptb/start', async (req, res) => {
        const user = await authenticate(req, res);
        if (!user) return;

        const bet = parseInt(getBody(req).bet, 10);
        if (isNaN(bet) || bet <= 0 || bet > safeBalance(user)) return res.status(400).json({ error: 'ОШИБКА СТАВКИ' });

        await saveUser(user, {
            dscoin_balance: safeBalance(user) - bet,
            current_game: { type: 'ptb', bet: bet, round: 0, correctAnswers: 0, active: true, currentCorrectTitle: null }
        });

        res.json({ success: true, newBalance: user.dscoin_balance });
    });

    app.post('/api/games/ptb/round', async (req, res) => {
        const user = await authenticate(req, res);
        if (!user) return;

        if (!user.current_game || user.current_game.type !== 'ptb' || !user.current_game.active) {
            return res.status(400).json({ error: 'НЕТ АКТИВНОЙ ИГРЫ В БИТЕ' });
        }

        const catalog = await getMusicCatalog();
        const validAudio = catalog.filter(t => t.mp3_url && t.title);
        if (validAudio.length === 0) return res.status(500).json({ error: 'База пуста' });

        const correctTrack = validAudio[Math.floor(Math.random() * validAudio.length)];

        let uniqueTitles = new Set(validAudio.map(t => t.title));
        FALLBACK_TITLES.forEach(t => uniqueTitles.add(t));
        uniqueTitles.delete(correctTrack.title);

        const optionsArray = Array.from(uniqueTitles).sort(() => 0.5 - Math.random());
        const options = [correctTrack.title, optionsArray[0], optionsArray[1], optionsArray[2]].sort(() => 0.5 - Math.random());
        const newRound = (user.current_game.round || 0) + 1;

        await saveUser(user, {
            current_game: { ...user.current_game, round: newRound, currentCorrectTitle: correctTrack.title.trim() }
        });

        res.json({ success: true, mp3Url: correctTrack.mp3_url, options, round: newRound });
    });

    app.post('/api/games/ptb/answer', async (req, res) => {
        const user = await authenticate(req, res);
        if (!user) return;

        if (!user.current_game || user.current_game.type !== 'ptb' || !user.current_game.active) {
            return res.status(400).json({ error: 'НЕТ АКТИВНОЙ ИГРЫ В БИТЕ' });
        }

        const answer = getBody(req).answer;
        const game = user.current_game;
        const cleanAnswer = String(answer || '').trim().toLowerCase();
        const cleanCorrect = String(game.currentCorrectTitle || '').trim().toLowerCase();
        const isCorrect = cleanAnswer === cleanCorrect;

        const correctAnswers = (game.correctAnswers || 0) + (isCorrect ? 1 : 0);
        const isFinished = game.round >= 5;

        let win = 0;
        if (isFinished) {
            const ratio = correctAnswers / 5;
            const mult = ratio >= 0.8 ? 3 : ratio >= 0.6 ? 2 : ratio >= 0.4 ? 1.5 : ratio >= 0.2 ? 1 : 0;
            win = Math.floor(game.bet * mult);
            await saveUser(user, { dscoin_balance: safeBalance(user) + win, current_game: null });
        } else {
            await saveUser(user, { current_game: { ...game, correctAnswers: correctAnswers } });
        }

        res.json({ success: true, isCorrect, isFinished, correctAnswers, win, newBalance: user.dscoin_balance });
    });

};
