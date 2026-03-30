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
    // 1. ПАССИВНЫЙ ФАРМ И ДЕЙЛИКИ
    // ==========================================

    // Daily Loot (+10 DS Coins раз в 24 часа)
    app.post('/api/games/daily', async (req, res) => {
        try {
            const user = await authenticate(req, res);
            if (!user) return;

            const now = Date.now();
            const lastDaily = user.lastDaily || 0;
            const timeDiff = now - lastDaily;

            if (timeDiff < 86400000) {
                const hoursLeft = Math.ceil((86400000 - timeDiff) / (1000 * 60 * 60));
                return res.status(400).json({ error: `Следующий лут через ${hoursLeft} ч.` });
            }

            user.dscoin_balance = (user.dscoin_balance || 0) + 10;
            user.lastDaily = now;
            await user.save();

            res.json({ success: true, reward: 10, newBalance: user.dscoin_balance, message: 'Свежий кэш загружен' });
        } catch (err) {
            console.error("Ошибка в Daily Loot:", err);
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    });

    // Пассивный фарм за прослушивание (+1 DS Coin раз в минуту)
    app.post('/api/games/farm', async (req, res) => {
        try {
            const user = await authenticate(req, res);
            if (!user) return;

            const now = Date.now();
            const lastFarm = user.lastFarm || 0;

            if (now - lastFarm < 55000) {
                return res.status(429).json({ error: 'Слишком частые запросы' });
            }

            user.dscoin_balance = (user.dscoin_balance || 0) + 1;
            user.lastFarm = now;
            await user.save();

            res.json({ success: true, newBalance: user.dscoin_balance });
        } catch (err) {
            console.error("Ошибка в Farm:", err);
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    });


    // ==========================================
    // 2. МИНИ-ИГРЫ (АЗАРТ)
    // ==========================================

    // NEON SLOTS (Логика с обложками из Supabase)
    app.post('/api/games/slots', async (req, res) => {
        try {
            const { bet } = req.body;
            const betAmount = parseInt(bet);
            const user = await authenticate(req, res);
            if (!user) return;

            if (isNaN(betAmount) || betAmount <= 0) return res.status(400).json({ error: 'Некорректная ставка' });
            if (user.dscoin_balance < betAmount) return res.status(400).json({ error: 'Недостаточно DS Coins' });

            const { data: allTracks, error } = await supabase
                .from('music')
                .select('cover_url, is_main, title')
                .order('created_at', { ascending: false });

            if (error || !allTracks || allTracks.length === 0) {
                return res.status(500).json({ error: 'Каталог пуст или недоступен' });
            }

            // Формируем пул: последние 10 треков + все главные релизы
            let slotPool = allTracks.slice(0, 10);
            allTracks.forEach(track => {
                if (track.is_main && !slotPool.some(t => t.cover_url === track.cover_url)) {
                    slotPool.push(track);
                }
            });

            // Весовой рандом: Главные (вес 5) выпадают в 2 раза реже Обычных (вес 10)
            let weightedPool = [];
            slotPool.forEach((track, index) => {
                const weight = track.is_main ? 5 : 10;
                for (let i = 0; i < weight; i++) weightedPool.push(index);
            });

            const spin = () => weightedPool[Math.floor(Math.random() * weightedPool.length)];
            const resultIndices = [spin(), spin(), spin()];
            const resultTracks = resultIndices.map(idx => slotPool[idx]);

            let winTotal = 0;
            const isWin = (resultTracks[0].cover_url === resultTracks[1].cover_url) && 
                          (resultTracks[1].cover_url === resultTracks[2].cover_url);

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
            res.status(500).json({ error: 'Системная ошибка слотов' });
        }
    });

    // CYBER DICE (Больше/Меньше 50)
    app.post('/api/games/dice', async (req, res) => {
        try {
            const { bet, guess } = req.body; // 'over' или 'under'
            const betAmount = parseInt(bet);
            const user = await authenticate(req, res);
            if (!user) return;

            if (!['over', 'under'].includes(guess)) return res.status(400).json({ error: 'Выберите over/under' });
            if (isNaN(betAmount) || betAmount <= 0 || user.dscoin_balance < betAmount) return res.status(400).json({ error: 'Ошибка ставки' });

            const roll = Math.floor(Math.random() * 100) + 1;
            let isWin = false;

            if (guess === 'over' && roll > 50) isWin = true;
            if (guess === 'under' && roll <= 50) isWin = true;

            const winTotal = isWin ? betAmount * 2 : 0;
            user.dscoin_balance = user.dscoin_balance - betAmount + winTotal;
            await user.save();

            res.json({ success: true, roll, win: winTotal, newBalance: user.dscoin_balance });
        } catch (err) {
            console.error("Ошибка в Dice:", err);
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    });

    // COIN FLIP (Орёл / Решка)
    app.post('/api/games/flip', async (req, res) => {
        try {
            const { bet, guess } = req.body; // 'heads' или 'tails'
            const betAmount = parseInt(bet);
            const user = await authenticate(req, res);
            if (!user) return;

            if (!['heads', 'tails'].includes(guess)) return res.status(400).json({ error: 'Выберите сторону' });
            if (isNaN(betAmount) || betAmount <= 0 || user.dscoin_balance < betAmount) return res.status(400).json({ error: 'Ошибка ставки' });

            const result = Math.random() < 0.5 ? 'heads' : 'tails';
            const isWin = result === guess;
            const winTotal = isWin ? betAmount * 2 : 0;

            user.dscoin_balance = user.dscoin_balance - betAmount + winTotal;
            await user.save();

            res.json({ success: true, result, win: winTotal, newBalance: user.dscoin_balance });
        } catch (err) {
            console.error("Ошибка в Flip:", err);
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    });

    // TERMINAL HACK (Взлом за 5 DS Coins)
    app.post('/api/games/hack', async (req, res) => {
        try {
            const cost = 5;
            const { guessCode } = req.body; // 4-значный код
            const user = await authenticate(req, res);
            if (!user) return;

            if (!guessCode || guessCode.length !== 4) return res.status(400).json({ error: 'Введите 4-значный код' });
            if (user.dscoin_balance < cost) return res.status(400).json({ error: 'Недостаточно DS Coins' });

            const serverCode = Math.floor(1000 + Math.random() * 9000).toString();
            const isWin = guessCode === serverCode;
            
            const winTotal = isWin ? 500 : 0; // Джекпот
            user.dscoin_balance = user.dscoin_balance - cost + winTotal;
            await user.save();

            res.json({ success: true, serverCode, win: winTotal, newBalance: user.dscoin_balance });
        } catch (err) {
            console.error("Ошибка в Hack:", err);
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    });

    // ==========================================
    // 3. МАГАЗИН И КАСТОМИЗАЦИЯ
    // ==========================================
    
    // Покупка товаров
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

            // Защита инициализации инвентаря
            if (!user.inventory) {
                user.inventory = { frames: [], titles: [], snippets: [] };
            }
            const category = item.type + 's';
            if (!user.inventory[category]) {
                user.inventory[category] = [];
            }

            if (user.inventory[category].includes(itemId)) {
                return res.status(400).json({ error: 'Уже куплено' });
            }

            user.dscoin_balance -= item.price;
            user.inventory[category].push(itemId);
            
            // Авто-экипировка
            if (item.type === 'frame') user.activeFrame = itemId;
            if (item.type === 'title') user.activeTitle = item.name;

            // Mongoose требует этого, чтобы увидеть изменения во вложенных объектах/массивах
            user.markModified('inventory');
            await user.save();

            res.json({ success: true, newBalance: user.dscoin_balance, message: `Куплено: ${item.name}` });
        } catch (err) {
            console.error("Ошибка в Shop Buy:", err);
            res.status(500).json({ error: 'Ошибка магазина' });
        }
    });

    // Буст трека
    app.post('/api/shop/boost', async (req, res) => {
        try {
            const { trackId, amount } = req.body; 
            const burnAmount = parseInt(amount);
            const user = await authenticate(req, res);
            if (!user) return;

            if (isNaN(burnAmount) || burnAmount <= 0) return res.status(400).json({ error: 'Укажите сумму буста' });
            if (user.dscoin_balance < burnAmount) return res.status(400).json({ error: 'Недостаточно средств' });

            user.dscoin_balance -= burnAmount;
            await user.save();

            // Если в таблице music в Supabase нет колонки boosts, этот кусок не крашнет сервер благодаря try-catch
            const { data: track, error } = await supabase.from('music').select('boosts').eq('id', trackId).single();
            if (!error && track) {
                await supabase.from('music').update({ boosts: (track.boosts || 0) + burnAmount }).eq('id', trackId);
            }

            res.json({ success: true, newBalance: user.dscoin_balance, message: `Трек забущен на ${burnAmount}!` });
        } catch (err) {
            console.error("Ошибка в Shop Boost:", err);
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    });
};
