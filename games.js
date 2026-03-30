module.exports = function(app, User, supabase) {

    // ==========================================
    // ВНУТРЕННИЙ ПОМОЩНИК: АВТОРИЗАЦИЯ
    // ==========================================
    // Проверяет юзера строго по никнейму и паролю для каждого игрового запроса
    const authenticate = async (req, res) => {
        const { nickname, password } = req.body;
        if (!nickname || !password) {
            res.status(400).json({ error: 'Требуется авторизация' });
            return null;
        }
        const user = await User.findOne({ nickname, password });
        if (!user) {
            res.status(401).json({ error: 'Доступ запрещен' });
            return null;
        }
        return user;
    };

    // ==========================================
    // 1. ПАССИВНЫЙ ФАРМ И ДЕЙЛИКИ
    // ==========================================

    // Daily Loot (+10 NC раз в 24 часа)
    app.post('/api/games/daily', async (req, res) => {
        const user = await authenticate(req, res);
        if (!user) return;

        const now = Date.now();
        const lastDaily = user.lastDaily || 0;
        const timeDiff = now - lastDaily;

        // 24 часа = 86400000 мс
        if (timeDiff < 86400000) {
            const hoursLeft = Math.ceil((86400000 - timeDiff) / (1000 * 60 * 60));
            return res.status(400).json({ error: `Следующий лут через ${hoursLeft} ч.` });
        }

        user.balance = (user.balance || 0) + 10;
        user.lastDaily = now;
        await user.save();

        res.json({ success: true, reward: 10, newBalance: user.balance, message: 'Свежий кэш загружен' });
    });

    // Пассивный фарм за прослушивание (+1 NC раз в минуту)
    app.post('/api/games/farm', async (req, res) => {
        const user = await authenticate(req, res);
        if (!user) return;

        const now = Date.now();
        const lastFarm = user.lastFarm || 0;

        // Защита от накрутки: запрос можно делать не чаще, чем раз в 55 секунд
        if (now - lastFarm < 55000) {
            return res.status(429).json({ error: 'Слишком частые запросы синхронизации' });
        }

        user.balance = (user.balance || 0) + 1;
        user.lastFarm = now;
        await user.save();

        res.json({ success: true, newBalance: user.balance });
    });


    // ==========================================
    // 2. МИНИ-ИГРЫ (АЗАРТ)
    // ==========================================

    // NEON SLOTS (Логика с обложками из Supabase: Топ 10 + Главные)
    app.post('/api/games/slots', async (req, res) => {
        const { bet } = req.body;
        const betAmount = parseInt(bet);
        const user = await authenticate(req, res);
        if (!user) return;

        if (!betAmount || betAmount <= 0) return res.status(400).json({ error: 'Некорректная ставка' });
        if (user.balance < betAmount) return res.status(400).json({ error: 'Недостаточно NC' });

        const { data: allTracks, error } = await supabase
            .from('music')
            .select('cover_url, is_main, title')
            .order('created_at', { ascending: false });

        if (error || !allTracks.length) return res.status(500).json({ error: 'Сбой подключения к каталогу' });

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

        user.balance = user.balance - betAmount + winTotal;
        await user.save();

        res.json({
            success: true,
            items: resultTracks.map(t => t.cover_url),
            win: winTotal,
            newBalance: user.balance,
            isJackpot: isWin && resultTracks[0].is_main
        });
    });

    // CYBER DICE (Больше/Меньше 50)
    app.post('/api/games/dice', async (req, res) => {
        const { bet, guess } = req.body; // guess: 'over' или 'under'
        const betAmount = parseInt(bet);
        const user = await authenticate(req, res);
        if (!user) return;

        if (!['over', 'under'].includes(guess)) return res.status(400).json({ error: 'Ошибка терминала. Выберите over/under' });
        if (isNaN(betAmount) || betAmount <= 0 || user.balance < betAmount) return res.status(400).json({ error: 'Ошибка ставки' });

        const roll = Math.floor(Math.random() * 100) + 1; // 1-100
        let isWin = false;

        if (guess === 'over' && roll > 50) isWin = true;
        if (guess === 'under' && roll <= 50) isWin = true;

        const winTotal = isWin ? betAmount * 2 : 0;
        user.balance = user.balance - betAmount + winTotal;
        await user.save();

        res.json({ success: true, roll, win: winTotal, newBalance: user.balance });
    });

    // COIN FLIP (Орёл / Решка)
    app.post('/api/games/flip', async (req, res) => {
        const { bet, guess } = req.body; // guess: 'heads' или 'tails'
        const betAmount = parseInt(bet);
        const user = await authenticate(req, res);
        if (!user) return;

        if (!['heads', 'tails'].includes(guess)) return res.status(400).json({ error: 'Выберите сторону монеты' });
        if (isNaN(betAmount) || betAmount <= 0 || user.balance < betAmount) return res.status(400).json({ error: 'Ошибка ставки' });

        const result = Math.random() < 0.5 ? 'heads' : 'tails';
        const isWin = result === guess;
        const winTotal = isWin ? betAmount * 2 : 0;

        user.balance = user.balance - betAmount + winTotal;
        await user.save();

        res.json({ success: true, result, win: winTotal, newBalance: user.balance });
    });

    // TERMINAL HACK (Взлом за 5 NC)
    app.post('/api/games/hack', async (req, res) => {
        const cost = 5;
        const { guessCode } = req.body; // Юзер присылает 4-значный код (строка)
        const user = await authenticate(req, res);
        if (!user) return;

        if (!guessCode || guessCode.length !== 4) return res.status(400).json({ error: 'Введите 4-значный код' });
        if (user.balance < cost) return res.status(400).json({ error: 'Недостаточно NC для запуска дешифратора' });

        // Сервер генерирует случайный код сессии взлома
        const serverCode = Math.floor(1000 + Math.random() * 9000).toString();
        const isWin = guessCode === serverCode;
        
        // Джекпот: фиксированные 500 NC
        const winTotal = isWin ? 500 : 0;
        user.balance = user.balance - cost + winTotal;
        await user.save();

        res.json({ success: true, serverCode, win: winTotal, newBalance: user.balance });
    });


    // ==========================================
    // 3. МАГАЗИН (ТРАТЫ БАЛАНСА)
    // ==========================================
    
    // Покупка товаров (Сниппеты, Аватарки, Титулы)
    app.post('/api/shop/buy', async (req, res) => {
        const { itemType, itemId } = req.body; 
        const user = await authenticate(req, res);
        if (!user) return;

        // Конфиг товаров в магазине
        const SHOP_ITEMS = {
            snippet_nightcity: { price: 500, type: 'snippet' },
            frame_neon_green: { price: 300, type: 'frame', name: 'Toxic Glow' },
            frame_cyber_pulse: { price: 600, type: 'frame', name: 'Cyber Pulse (Anim)' },
            title_netrunner: { price: 1000, type: 'title', name: 'Netrunner' },
            title_legend: { price: 5000, type: 'title', name: 'Cyber Legend' }
        };

        const item = SHOP_ITEMS[itemId];
        if (!item) return res.status(404).json({ error: 'Товар не найден в базе' });
        if (user.balance < item.price) return res.status(400).json({ error: 'Недостаточно кредитов' });

        // Убедимся, что у юзера есть массивы для инвентаря (если нет - создаем)
        if (!user.inventory) user.inventory = { frames: [], titles: [], snippets: [] };

        // Проверка, куплен ли уже товар
        const inventoryCategory = user.inventory[item.type + 's'];
        if (inventoryCategory && inventoryCategory.includes(itemId)) {
            return res.status(400).json({ error: 'Этот апгрейд уже установлен' });
        }

        // Списываем баланс и добавляем в инвентарь
        user.balance -= item.price;
        if (!user.inventory[item.type + 's']) user.inventory[item.type + 's'] = [];
        user.inventory[item.type + 's'].push(itemId);
        
        // Автоматически применяем экипировку
        if (item.type === 'frame') user.activeFrame = itemId;
        if (item.type === 'title') user.activeTitle = item.name;

        await user.save();

        res.json({ 
            success: true, 
            newBalance: user.balance, 
            message: `Транзакция успешна. ${item.name || 'Сниппет'} активирован.` 
        });
    });

    // Буст трека (Голосование балансом)
    app.post('/api/shop/boost', async (req, res) => {
        const { trackId, amount } = req.body; // Сколько NC юзер хочет "сжечь"
        const burnAmount = parseInt(amount);
        const user = await authenticate(req, res);
        if (!user) return;

        if (isNaN(burnAmount) || burnAmount <= 0) return res.status(400).json({ error: 'Укажите сумму буста' });
        if (user.balance < burnAmount) return res.status(400).json({ error: 'Недостаточно NC' });

        // Списываем баланс
        user.balance -= burnAmount;
        await user.save();

        // Добавляем буст-поинты треку в Supabase
        const { data: track, error } = await supabase.from('music').select('boosts').eq('id', trackId).single();
        if (!error && track) {
            await supabase.from('music').update({ boosts: (track.boosts || 0) + burnAmount }).eq('id', trackId);
        }

        res.json({ success: true, newBalance: user.balance, message: `Трек усилен на ${burnAmount} NC` });
    });

};
