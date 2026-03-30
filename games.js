const bcrypt = require('bcryptjs');

module.exports = function(app, User, supabase) {

    // ==========================================
    // ВНУТРЕННИЙ ПОМОЩНИК: АВТОРИЗАЦИЯ
    // ==========================================
    const authenticate = async (req, res) => {
        try {
            const loginStr = req.body.username || req.body.nickname || req.body.login;
            const { password } = req.body;

            if (!loginStr || !password) {
                res.status(400).json({ error: 'Требуется логин и пароль' });
                return null;
            }

            const lowerUser = String(loginStr).toLowerCase();
            const user = await User.findOne({ username: lowerUser });
            
            if (!user) {
                res.status(401).json({ error: 'Пользователь не найден' });
                return null;
            }

            const isMatch = await bcrypt.compare(password, user.password);
            if (!isMatch) {
                res.status(401).json({ error: 'Неверный пароль' });
                return null;
            }

            return user;
        } catch (err) {
            console.error("Ошибка аутентификации в играх:", err);
            res.status(500).json({ error: 'Ошибка сервера' });
            return null;
        }
    };

    // ==========================================
    // 0. ИНФО-МАРШРУТЫ (ДЛЯ ФРОНТЕНДА)
    // ==========================================

    // Топ-5 богатых пользователей для Лидерборда
    app.get('/api/games/leaderboard', async (req, res) => {
        try {
            const leaders = await User.find({}, 'username dscoin_balance avatarUrl')
                .sort({ dscoin_balance: -1 })
                .limit(5);
            res.json({ success: true, leaders });
        } catch (err) {
            console.error("Ошибка Leaderboard:", err);
            res.status(500).json({ error: 'Ошибка получения топа' });
        }
    });

    // Получить пул обложек для предзагрузки анимации слотов
    app.get('/api/games/slots/covers', async (req, res) => {
        try {
            const { data, error } = await supabase
                .from('music')
                .select('cover_url')
                .limit(20);

            if (error || !data) return res.status(500).json({ error: 'Ошибка загрузки обложек' });
            res.json({ success: true, covers: data.map(t => t.cover_url) });
        } catch (err) {
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    });


    // ==========================================
    // 1. БАЗА (ФАРМ И ДЕЙЛИКИ)
    // ==========================================

    // Daily Loot (+100 NC раз в 6 часов)
    app.post('/api/games/daily', async (req, res) => {
        try {
            const user = await authenticate(req, res);
            if (!user) return;

            const now = Date.now();
            const lastDaily = user.lastDaily || 0;
            const timeDiff = now - lastDaily;
            const cooldown = 6 * 60 * 60 * 1000; // 6 часов в миллисекундах

            if (timeDiff < cooldown) {
                const hoursLeft = Math.ceil((cooldown - timeDiff) / (1000 * 60 * 60));
                return res.status(400).json({ error: `Следующая поставка через ${hoursLeft} ч.` });
            }

            user.dscoin_balance = (user.dscoin_balance || 0) + 100;
            user.lastDaily = now;
            await user.save();

            res.json({ success: true, reward: 100, newBalance: user.dscoin_balance, message: 'Поставка получена' });
        } catch (err) {
            console.error("Ошибка в Daily Loot:", err);
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    });

    // Малодоходный АФК Майнер (+1 NC) - Фронтенд вызывает после 20 кликов
    app.post('/api/games/mine', async (req, res) => {
        try {
            const user = await authenticate(req, res);
            if (!user) return;

            user.dscoin_balance = (user.dscoin_balance || 0) + 1;
            await user.save();

            res.json({ success: true, newBalance: user.dscoin_balance });
        } catch (err) {
            console.error("Ошибка в Miner:", err);
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    });


    // ==========================================
    // 2. МИНИ-ИГРЫ (АЗАРТ)
    // ==========================================

    // NEON SLOTS (Ровно 15% шанс на выигрыш)
    app.post('/api/games/slots', async (req, res) => {
        try {
            const { bet } = req.body;
            const betAmount = parseInt(bet);
            const user = await authenticate(req, res);
            if (!user) return;

            if (isNaN(betAmount) || betAmount <= 0) return res.status(400).json({ error: 'Некорректная ставка' });
            if (user.dscoin_balance < betAmount) return res.status(400).json({ error: 'Недостаточно Кредитов' });

            const { data: allTracks, error } = await supabase
                .from('music')
                .select('cover_url, is_main, title')
                .order('created_at', { ascending: false });

            if (error || !allTracks || allTracks.length === 0) {
                return res.status(500).json({ error: 'База данных музыки пуста' });
            }

            let slotPool = allTracks.slice(0, 10);
            allTracks.forEach(track => {
                if (track.is_main && !slotPool.some(t => t.cover_url === track.cover_url)) {
                    slotPool.push(track);
                }
            });

            // Шанс победы ровно 15%
            const WIN_CHANCE = 0.15; 
            const isWin = Math.random() < WIN_CHANCE; 

            let resultTracks = [];
            
            if (isWin) {
                let weightedPool = [];
                slotPool.forEach(track => {
                    const weight = track.is_main ? 1 : 4; 
                    for(let i=0; i<weight; i++) weightedPool.push(track);
                });
                const winTrack = weightedPool[Math.floor(Math.random() * weightedPool.length)];
                resultTracks = [winTrack, winTrack, winTrack];
            } else {
                while (true) {
                    const getRandomTrack = () => slotPool[Math.floor(Math.random() * slotPool.length)];
                    resultTracks = [getRandomTrack(), getRandomTrack(), getRandomTrack()];
                    if (!(resultTracks[0].cover_url === resultTracks[1].cover_url && resultTracks[1].cover_url === resultTracks[2].cover_url)) {
                        break; 
                    }
                }
            }

            let winTotal = 0;
            if (isWin) {
                winTotal = betAmount * (resultTracks[0].is_main ? 10 : 5);
            }

            user.dscoin_balance = user.dscoin_balance - betAmount + winTotal;
            await user.save();

            res.json({
                success: true,
                items: resultTracks.map(t => t.cover_url),
                win: winTotal,
                newBalance: user.dscoin_balance,
                isJackpot: isWin && resultTracks[0].is_main
            });
        } catch (err) {
            console.error("Ошибка в Slots:", err);
            res.status(500).json({ error: 'Сбой системы слотов' });
        }
    });

    // CYBER DICE (4 варианта)
    app.post('/api/games/dice', async (req, res) => {
        try {
            // guess ожидает числа 1, 2, 3 или 4
            const { bet, guess } = req.body; 
            const betAmount = parseInt(bet);
            const choice = parseInt(guess);
            const user = await authenticate(req, res);
            if (!user) return;

            if (![1, 2, 3, 4].includes(choice)) return res.status(400).json({ error: 'Неверный диапазон' });
            if (isNaN(betAmount) || betAmount <= 0 || user.dscoin_balance < betAmount) return res.status(400).json({ error: 'Ошибка ставки' });

            const roll = Math.floor(Math.random() * 100) + 1;
            let isWin = false;
            let mult = 0;

            if (choice === 1 && roll < 25) { isWin = true; mult = 3; }
            else if (choice === 2 && roll >= 25 && roll <= 50) { isWin = true; mult = 2; }
            else if (choice === 3 && roll > 51 && roll <= 75) { isWin = true; mult = 2; }
            else if (choice === 4 && roll > 75) { isWin = true; mult = 3; }

            const winTotal = isWin ? betAmount * mult : 0;
            user.dscoin_balance = user.dscoin_balance - betAmount + winTotal;
            await user.save();

            res.json({ success: true, roll, win: winTotal, newBalance: user.dscoin_balance });
        } catch (err) {
            console.error("Ошибка в Dice:", err);
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    });

    // CRASH (Авто-вывод)
    app.post('/api/games/crash', async (req, res) => {
        try {
            // Для игры фронтенд должен передавать targetMultiplier (например, 1.5, 2.0)
            const { bet, targetMultiplier } = req.body; 
            const betAmount = parseInt(bet);
            const target = parseFloat(targetMultiplier);
            const user = await authenticate(req, res);
            if (!user) return;

            if (isNaN(target) || target < 1.01) return res.status(400).json({ error: 'Укажите множитель для автовывода (минимум 1.01)' });
            if (isNaN(betAmount) || betAmount <= 0 || user.dscoin_balance < betAmount) return res.status(400).json({ error: 'Ошибка ставки' });

            // Алгоритм генерации краша. Чем больше число, тем меньше шанс до него дойти.
            // Это классическая формула генерации crash-точки.
            const e = 2 ** 32;
            const h = Math.floor(Math.random() * e);
            let crashPoint = Math.max(1.00, (e / (h + 1))); 
            
            // Ограничиваем максимальный краш для безопасности экономики
            if (crashPoint > 50) crashPoint = 50.00; 
            crashPoint = parseFloat(crashPoint.toFixed(2));

            const isWin = target <= crashPoint;
            const winTotal = isWin ? Math.floor(betAmount * target) : 0;

            user.dscoin_balance = user.dscoin_balance - betAmount + winTotal;
            await user.save();

            res.json({ success: true, crashPoint, target, win: winTotal, newBalance: user.dscoin_balance });
        } catch (err) {
            console.error("Ошибка в Crash:", err);
            res.status(500).json({ error: 'Сбой системы Crash' });
        }
    });

    // HACK (Взлом - 15% шанс победы)
    app.post('/api/games/hack', async (req, res) => {
        try {
            const { bet } = req.body; 
            const betAmount = parseInt(bet);
            const user = await authenticate(req, res);
            if (!user) return;

            if (isNaN(betAmount) || betAmount <= 0) return res.status(400).json({ error: 'Некорректная ставка' });
            if (user.dscoin_balance < betAmount) return res.status(400).json({ error: 'Недостаточно Кредитов' });

            // Как и в слотах, жесткий шанс на победу (имитирует шанс угадать 3 безопасных узла)
            const WIN_CHANCE = 0.15;
            const isWin = Math.random() < WIN_CHANCE;
            
            const winTotal = isWin ? betAmount * 5 : 0; 
            user.dscoin_balance = user.dscoin_balance - betAmount + winTotal;
            await user.save();

            res.json({ success: true, isWin, win: winTotal, newBalance: user.dscoin_balance });
        } catch (err) {
            console.error("Ошибка в Hack:", err);
            res.status(500).json({ error: 'Сбой протокола' });
        }
    });

    // ==========================================
    // 3. МАГАЗИН (Остался для совместимости, пока не перенесешь)
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
            if (user.dscoin_balance < item.price) return res.status(400).json({ error: 'Недостаточно коинов' });

            if (!user.inventory) user.inventory = { frames: [], titles: [], snippets: [] };
            const category = item.type + 's';
            if (!user.inventory[category]) user.inventory[category] = [];

            if (user.inventory[category].includes(itemId)) return res.status(400).json({ error: 'Уже куплено' });

            user.dscoin_balance -= item.price;
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
};
