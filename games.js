const jwt = require('jsonwebtoken');

// Секретный ключ (ДОЛЖЕН СОВПАДАТЬ С ТЕМ, ЧТО В auth.js/index.js)
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_key';

// Константы для пассивного фарма
const FARM_TIME_MINUTES = [30, 25, 20, 15, 10, 5];
const FARM_TIME_COSTS = [750, 1500, 3000, 5000, 10000];

const FARM_INCOME_COINS = [2, 4, 6, 8, 10, 15, 20];
const FARM_INCOME_COSTS = [750, 1500, 3000, 5000, 10000, 17500];

// Кэш для каталога музыки
let musicCache = {
    data: [],
    lastFetch: 0
};

module.exports = function(app, User, supabase) {

    // ==========================================
    // ВНУТРЕННИЙ ПОМОЩНИК: АВТОРИЗАЦИЯ ПО ТОКЕНУ
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
            
            const clientId = decoded.clientId;
            
            if (!clientId) {
                res.status(401).json({ error: 'Неверный формат токена' });
                return null;
            }

            const user = await User.findOne({ clientId: clientId });
            if (!user) {
                res.status(401).json({ error: 'Пользователь не найден в базе' });
                return null;
            }

            // --- ЛЕНИВОЕ НАЧИСЛЕНИЕ ПАССИВНОГО ДОХОДА ---
            if (user.farm && user.farm.active) {
                const now = Date.now();
                const lastClaim = user.farm.lastClaim || now;
                
                const tLvl = user.farm.timeLevel || 0;
                const iLvl = user.farm.incomeLevel || 0;
                
                const intervalMs = FARM_TIME_MINUTES[tLvl] * 60 * 1000;
                const incomePerInterval = FARM_INCOME_COINS[iLvl];
                
                const timePassed = now - lastClaim;
                
                if (timePassed >= intervalMs) {
                    const intervalsPassed = Math.floor(timePassed / intervalMs);
                    const gainedCoins = intervalsPassed * incomePerInterval;
                    
                    // Жесткое приведение к числу для избежания багов с "визуальным" балансом
                    user.dscoin_balance = Math.floor(Number(user.dscoin_balance || 0) + gainedCoins);
                    user.farm.lastClaim = lastClaim + (intervalsPassed * intervalMs);
                    user.markModified('farm');
                    await user.save();
                }
            }

            return user;
        } catch (err) {
            res.status(401).json({ error: 'Недействительный токен или сессия истекла' });
            return null;
        }
    };

    // Вспомогательная функция для получения музыки с кэшированием (5 минут)
    const getMusicCatalog = async () => {
        const now = Date.now();
        if (musicCache.data.length > 0 && (now - musicCache.lastFetch < 5 * 60 * 1000)) {
            return musicCache.data;
        }

        // ИСПРАВЛЕНИЕ: Используем mp3_url вместо audio_url, как прописано в index.js
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

    // ==========================================
    // 0. ИНФО-МАРШРУТЫ
    // ==========================================

    app.get('/api/games/leaderboard', async (req, res) => {
        try {
            const leaders = await User.find({}, 'username nickname dscoin_balance avatarUrl')
                .sort({ dscoin_balance: -1 })
                .limit(5);

            const processedLeaders = leaders.map(l => ({
                username: l.username,
                nickname: l.nickname,
                dscoin_balance: l.dscoin_balance,
                avatarUrl: (l.avatarUrl && l.avatarUrl.trim() !== '') ? l.avatarUrl : '/dslogo.png' 
            }));

            res.json({ success: true, leaders: processedLeaders });
        } catch (err) {
            res.status(500).json({ error: 'Ошибка получения топа' });
        }
    });

    // ==========================================
    // 1. БАЗА (ФАРМ И ДЕЙЛИКИ)
    // ==========================================

    app.post('/api/games/daily', async (req, res) => {
        try {
            const user = await authenticate(req, res);
            if (!user) return;

            const now = Date.now();
            const lastDaily = user.lastDaily || 0;
            const cooldown = 6 * 60 * 60 * 1000;

            if (now - lastDaily < cooldown) {
                const hoursLeft = Math.ceil((cooldown - (now - lastDaily)) / (1000 * 60 * 60));
                return res.status(400).json({ error: `Следующая поставка через ${hoursLeft} ч.` });
            }

            user.dscoin_balance = Math.floor(Number(user.dscoin_balance || 0) + 100);
            user.lastDaily = now;
            await user.save();

            res.json({ success: true, reward: 100, newBalance: user.dscoin_balance, message: 'ПОСТАВКА ПОЛУЧЕНА' });
        } catch (err) {
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    });

    app.post('/api/games/farm/activate', async (req, res) => {
        try {
            const user = await authenticate(req, res);
            if (!user) return;

            if (user.farm && user.farm.active) return res.status(400).json({ error: 'СИСТЕМА УЖЕ АКТИВИРОВАНА' });
            if (Number(user.dscoin_balance || 0) < 1000) return res.status(400).json({ error: 'НЕДОСТАТОЧНО СРЕДСТВ' });

            user.dscoin_balance = Math.floor(Number(user.dscoin_balance) - 1000);
            user.farm = { active: true, timeLevel: 0, incomeLevel: 0, lastClaim: Date.now() };
            user.markModified('farm');
            await user.save();

            res.json({ success: true, newBalance: user.dscoin_balance, message: 'ФЕРМА АКТИВИРОВАНА' });
        } catch (err) {
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    });

    app.post('/api/games/farm/upgrade', async (req, res) => {
        try {
            const user = await authenticate(req, res);
            if (!user) return;

            if (!user.farm || !user.farm.active) return res.status(400).json({ error: 'СНАЧАЛА АКТИВИРУЙТЕ СИСТЕМУ' });

            const { type } = req.body;
            let cost;

            if (type === 'time') {
                if (user.farm.timeLevel >= FARM_TIME_COSTS.length) return res.status(400).json({ error: 'МАКСИМАЛЬНЫЙ УРОВЕНЬ ДОСТИГНУТ' });
                cost = FARM_TIME_COSTS[user.farm.timeLevel];
            } else if (type === 'income') {
                if (user.farm.incomeLevel >= FARM_INCOME_COSTS.length) return res.status(400).json({ error: 'МАКСИМАЛЬНЫЙ УРОВЕНЬ ДОСТИГНУТ' });
                cost = FARM_INCOME_COSTS[user.farm.incomeLevel];
            } else {
                return res.status(400).json({ error: 'НЕВЕРНЫЙ ПАРАМЕТР УЛУЧШЕНИЯ' });
            }

            if (Number(user.dscoin_balance) < cost) return res.status(400).json({ error: 'НЕДОСТАТОЧНО СРЕДСТВ' });

            user.dscoin_balance = Math.floor(Number(user.dscoin_balance) - cost);
            
            if (type === 'time') user.farm.timeLevel += 1;
            else user.farm.incomeLevel += 1;

            user.markModified('farm');
            await user.save();

            res.json({ success: true, newBalance: user.dscoin_balance });
        } catch (err) {
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    });


    // ==========================================
    // 2. МИНИ-ИГРЫ (АЗАРТ)
    // ==========================================

    app.post('/api/games/slots', async (req, res) => {
        try {
            const betAmount = parseInt(req.body.bet, 10);
            const user = await authenticate(req, res);
            if (!user) return;

            if (isNaN(betAmount) || betAmount <= 0) return res.status(400).json({ error: 'НЕКОРРЕКТНАЯ СТАВКА' });
            if (Number(user.dscoin_balance) < betAmount) return res.status(400).json({ error: 'НЕДОСТАТОЧНО СРЕДСТВ' });

            const allTracks = await getMusicCatalog();
            if (!allTracks || allTracks.length === 0) {
                return res.status(500).json({ error: 'Система слотов временно недоступна (каталог пуст)' });
            }

            let slotPool = allTracks.slice(0, 10);
            allTracks.forEach(track => {
                if (track.is_main && !slotPool.some(t => t.cover_url === track.cover_url)) {
                    slotPool.push(track);
                }
            });

            const WIN_CHANCE = 0.15; 
            const isWin = Math.random() < WIN_CHANCE; 

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
                
                // Безопасная проверка на луз
                if (resultTracks[0].cover_url === resultTracks[1].cover_url && resultTracks[1].cover_url === resultTracks[2].cover_url) {
                    const diffTrack = slotPool.find(t => t.cover_url !== resultTracks[0].cover_url) || slotPool[0];
                    resultTracks[2] = diffTrack; 
                }
            }

            let winTotal = 0;
            if (isWin) winTotal = betAmount * (resultTracks[0].is_main ? 10 : 5);

            // ИСПРАВЛЕНИЕ: Жесткая типизация для корректного сохранения баланса
            user.dscoin_balance = Math.floor(Number(user.dscoin_balance) - betAmount + winTotal);
            await user.save();

            res.json({
                success: true,
                items: resultTracks.map(t => ({
                    id: t.id,
                    title: t.title, // Передаем название (для игры "Бит")
                    cover_url: t.cover_url, // Передаем обложку
                    mp3_url: t.mp3_url, // ИСПРАВЛЕНИЕ: Передаем правильный линк на mp3
                    is_main: t.is_main
                })),
                win: winTotal,
                newBalance: user.dscoin_balance,
                isJackpot: isWin && resultTracks[0].is_main
            });
        } catch (err) {
            res.status(500).json({ error: 'Сбой системы слотов' });
        }
    });

    app.post('/api/games/dice', async (req, res) => {
        try {
            const betAmount = parseInt(req.body.bet, 10);
            const choice = parseInt(req.body.guess, 10);
            const user = await authenticate(req, res);
            if (!user) return;

            if (![1, 2, 3, 4].includes(choice)) return res.status(400).json({ error: 'НЕВЕРНЫЙ СЕКТОР' });
            if (isNaN(betAmount) || betAmount <= 0) return res.status(400).json({ error: 'ОШИБКА СТАВКИ' });
            if (Number(user.dscoin_balance) < betAmount) return res.status(400).json({ error: 'НЕДОСТАТОЧНО СРЕДСТВ' });

            const roll = Math.floor(Math.random() * 100) + 1;
            let isWin = false;
            let mult = 0;

            if (choice === 1 && roll <= 25) { isWin = true; mult = 3; }
            else if (choice === 2 && roll >= 26 && roll <= 50) { isWin = true; mult = 2; }
            else if (choice === 3 && roll >= 51 && roll <= 75) { isWin = true; mult = 2; }
            else if (choice === 4 && roll >= 76) { isWin = true; mult = 3; }

            const winTotal = isWin ? betAmount * mult : 0;
            user.dscoin_balance = Math.floor(Number(user.dscoin_balance) - betAmount + winTotal);
            await user.save();

            res.json({ success: true, roll, win: winTotal, newBalance: user.dscoin_balance });
        } catch (err) {
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    });

    app.post('/api/games/crash', async (req, res) => {
        try {
            const betAmount = parseInt(req.body.bet, 10);
            const target = parseFloat(req.body.targetMultiplier);
            const user = await authenticate(req, res);
            if (!user) return;

            if (isNaN(target) || target < 1.1) return res.status(400).json({ error: 'МИНИМУМ 1.1x' });
            if (isNaN(betAmount) || betAmount <= 0) return res.status(400).json({ error: 'ОШИБКА СТАВКИ' });
            if (Number(user.dscoin_balance) < betAmount) return res.status(400).json({ error: 'НЕДОСТАТОЧНО СРЕДСТВ' });

            const e = 2 ** 32;
            const h = Math.floor(Math.random() * e);
            let crashPoint = Math.max(1.00, (e / (h + 1))); 
            
            if (crashPoint > 50) crashPoint = 50.00; 
            crashPoint = parseFloat(crashPoint.toFixed(2));

            const isWin = target <= crashPoint;
            const winTotal = isWin ? Math.floor(betAmount * target) : 0;

            user.dscoin_balance = Math.floor(Number(user.dscoin_balance) - betAmount + winTotal);
            await user.save();

            res.json({ success: true, crashPoint, target, win: winTotal, newBalance: user.dscoin_balance });
        } catch (err) {
            res.status(500).json({ error: 'Сбой системы Crash' });
        }
    });

    app.post('/api/games/roulette', async (req, res) => {
        try {
            const betAmount = parseInt(req.body.bet, 10);
            const color = req.body.color; 
            const user = await authenticate(req, res);
            if (!user) return;

            if (!['purple', 'cyan', 'gold'].includes(color)) return res.status(400).json({ error: 'ВЫБЕРИТЕ ЦВЕТ' });
            if (isNaN(betAmount) || betAmount <= 0) return res.status(400).json({ error: 'ОШИБКА СТАВКИ' });
            if (Number(user.dscoin_balance) < betAmount) return res.status(400).json({ error: 'НЕДОСТАТОЧНО СРЕДСТВ' });

            const roll = Math.random() * 100;
            let resultColor = '';
            
            if (roll < 5) resultColor = 'gold';
            else if (roll < 52.5) resultColor = 'cyan';
            else resultColor = 'purple';

            const isWin = color === resultColor;
            const mult = resultColor === 'gold' ? 14 : 2;
            const winTotal = isWin ? betAmount * mult : 0;

            user.dscoin_balance = Math.floor(Number(user.dscoin_balance) - betAmount + winTotal);
            await user.save();

            res.json({ success: true, resultColor, isWin, win: winTotal, newBalance: user.dscoin_balance });
        } catch (err) {
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    });

    // ==========================================
    // 3. МАГАЗИН И КАСТОМИЗАЦИЯ
    // ==========================================
    
    app.post('/api/shop/buy', async (req, res) => {
        try {
            const { itemType, itemId } = req.body; 
            const user = await authenticate(req, res);
            if (!user) return;

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

            if (user.inventory[category].includes(itemId)) {
                return res.status(400).json({ error: 'Уже куплено' });
            }

            user.dscoin_balance = Math.floor(Number(user.dscoin_balance) - item.price);
            user.inventory[category].push(itemId);
            
            if (item.type === 'frame') user.activeFrame = itemId;
            if (item.type === 'title') user.activeTitle = item.name;

            user.markModified('inventory');
            await user.save();

            res.json({ success: true, newBalance: user.dscoin_balance, message: `Куплено: ${item.name}` });
        } catch (err) {
            res.status(500).json({ error: 'Ошибка магазина' });
        }
    });

    app.post('/api/shop/boost', async (req, res) => {
        try {
            const { trackId, amount } = req.body; 
            const burnAmount = parseInt(amount, 10);
            const user = await authenticate(req, res);
            if (!user) return;

            if (isNaN(burnAmount) || burnAmount <= 0) return res.status(400).json({ error: 'Укажите сумму буста' });
            if (Number(user.dscoin_balance) < burnAmount) return res.status(400).json({ error: 'Недостаточно средств' });

            user.dscoin_balance = Math.floor(Number(user.dscoin_balance) - burnAmount);
            await user.save();

            const { data: track, error } = await supabase.from('music').select('boosts').eq('id', trackId).single();
            if (!error && track) {
                await supabase.from('music').update({ boosts: (track.boosts || 0) + burnAmount }).eq('id', trackId);
            }

            res.json({ success: true, newBalance: user.dscoin_balance, message: `Трек забущен на ${burnAmount}!` });
        } catch (err) {
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    });
};
