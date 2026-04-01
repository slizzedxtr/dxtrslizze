Ты абсолютно прав. Чтобы фронтенд и бэкенд работали как единый механизм без рассинхронов, games.js нужно немного подтюнить.
Вот что именно я скорректировал в коде сервера:
 * Лидерборд (Аватарки): Добавлена жесткая проверка на пустую аватарку. Если avatarUrl в базе нет, бэкенд сам отдаст dslogo.png. Это двойная защита (и на фронте, и на бэке).
 * Рулетка (Шансы): Выровнял проценты с тем, как генерируется лента на фронтенде. Теперь вероятности точные: Gold — 5%, Cyan — 47.5%, Purple — 47.5%. Ранее на бэке золото падало с шансом 7%, что могло вызывать визуальные нестыковки.
 * Дайс (Фикс багов): В старом коде была "дыра" в логике дайса (число 51 вообще не засчитывалось ни в один сектор из-за строгого неравенства > 51). Я выровнял сектора на идеально ровные четверти (1-25, 26-50, 51-75, 76-100).
Вот полностью обновленный и готовый к работе games.js:
const jwt = require('jsonwebtoken');

// Секретный ключ (ДОЛЖЕН СОВПАДАТЬ С ТЕМ, ЧТО В auth.js/index.js)
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_key';

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
            
            // Берем ИМЕННО clientId, так как он зашивается в index.js
            const clientId = decoded.clientId;
            
            if (!clientId) {
                console.error("В токене нет clientId! Расшифрованный токен:", decoded);
                res.status(401).json({ error: 'Неверный формат токена' });
                return null;
            }

            // Ищем юзера по clientId, а не через findById!
            const user = await User.findOne({ clientId: clientId });
            if (!user) {
                res.status(401).json({ error: 'Пользователь не найден в базе' });
                return null;
            }

            return user;
        } catch (err) {
            console.error("Ошибка авторизации в играх:", err.message);
            res.status(401).json({ error: 'Недействительный токен или сессия истекла' });
            return null;
        }
    };

    // ==========================================
    // 0. ИНФО-МАРШРУТЫ (ДЛЯ ФРОНТЕНДА)
    // ==========================================

    // Лидерборд: Топ-5 богатых пользователей
    app.get('/api/games/leaderboard', async (req, res) => {
        try {
            const leaders = await User.find({}, 'username nickname dscoin_balance avatarUrl')
                .sort({ dscoin_balance: -1 })
                .limit(5);
            
            // Бэкенд-защита: если аватарки нет, жестко отдаем дефолтную
            const processedLeaders = leaders.map(l => ({
                username: l.username,
                nickname: l.nickname,
                dscoin_balance: l.dscoin_balance,
                avatarUrl: (l.avatarUrl && l.avatarUrl.trim() !== '') ? l.avatarUrl : 'dslogo.png'
            }));

            res.json({ success: true, leaders: processedLeaders });
        } catch (err) {
            console.error("Ошибка Leaderboard:", err);
            res.status(500).json({ error: 'Ошибка получения топа' });
        }
    });

    // Получить пул обложек для анимации слотов
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
            const cooldown = 6 * 60 * 60 * 1000; // 6 часов

            if (now - lastDaily < cooldown) {
                const hoursLeft = Math.ceil((cooldown - (now - lastDaily)) / (1000 * 60 * 60));
                return res.status(400).json({ error: `Следующая поставка через ${hoursLeft} ч.` });
            }

            user.dscoin_balance = (user.dscoin_balance || 0) + 100;
            user.lastDaily = now;
            await user.save();

            res.json({ success: true, reward: 100, newBalance: user.dscoin_balance, message: 'ПОСТАВКА ПОЛУЧЕНА' });
        } catch (err) {
            console.error("Ошибка в Daily Loot:", err);
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    });

    // Майнер (Вызывает фронтенд после заполнения шкалы - каждые 20 кликов)
    app.post('/api/games/mine', async (req, res) => {
        try {
            const user = await authenticate(req, res);
            if (!user) return;

            // Уровень майнера = количество добываемых монет за 1 заполнение шкалы
            const power = user.minerLevel || 1; 
            
            user.dscoin_balance = (user.dscoin_balance || 0) + power;
            await user.save();

            res.json({ success: true, newBalance: user.dscoin_balance, earned: power });
        } catch (err) {
            console.error("Ошибка в Miner:", err);
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    });

    // Прокачка Майнера
    app.post('/api/games/miner/upgrade', async (req, res) => {
        try {
            const user = await authenticate(req, res);
            if (!user) return;

            const currentLevel = user.minerLevel || 1;
            const MAX_LEVEL = 10;

            if (currentLevel >= MAX_LEVEL) {
                return res.status(400).json({ error: 'ДОСТИГНУТ МАКСИМАЛЬНЫЙ УРОВЕНЬ ЯДРА' });
            }

            // Математика цены: 50 * (1.75 ^ (level - 1))
            const cost = Math.floor(50 * Math.pow(1.75, currentLevel - 1));

            if (user.dscoin_balance < cost) {
                return res.status(400).json({ error: `НЕДОСТАТОЧНО NC (${cost})` });
            }

            user.dscoin_balance -= cost;
            user.minerLevel = currentLevel + 1;
            await user.save();

            res.json({ success: true, newBalance: user.dscoin_balance, newLevel: user.minerLevel });
        } catch (err) {
            console.error("Ошибка в Miner Upgrade:", err);
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    });

    // ==========================================
    // 2. МИНИ-ИГРЫ (АЗАРТ)
    // ==========================================

    // NEON SLOTS (Ровно 15% шанс на выигрыш)
    app.post('/api/games/slots', async (req, res) => {
        try {
            const betAmount = parseFloat(req.body.bet);
            const user = await authenticate(req, res);
            if (!user) return;

            if (isNaN(betAmount) || betAmount <= 0 || !Number.isInteger(betAmount)) return res.status(400).json({ error: 'НЕКОРРЕКТНАЯ СТАВКА' });
            if (user.dscoin_balance < betAmount) return res.status(400).json({ error: 'НЕДОСТАТОЧНО СРЕДСТВ' });

            const { data: allTracks, error } = await supabase
                .from('music')
                .select('cover_url, is_main, title')
                .order('created_at', { ascending: false });

            if (error || !allTracks || allTracks.length === 0) {
                return res.status(500).json({ error: 'Каталог пуст или недоступен' });
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
                    // Гарантируем, что при лузе не выпадет 3 одинаковых
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

    // CYBER DICE
    app.post('/api/games/dice', async (req, res) => {
        try {
            const betAmount = parseFloat(req.body.bet);
            const choice = parseInt(req.body.guess);
            const user = await authenticate(req, res);
            if (!user) return;

            if (![1, 2, 3, 4].includes(choice)) return res.status(400).json({ error: 'НЕВЕРНЫЙ СЕКТОР' });
            if (isNaN(betAmount) || betAmount <= 0 || !Number.isInteger(betAmount)) return res.status(400).json({ error: 'ОШИБКА СТАВКИ' });
            if (user.dscoin_balance < betAmount) return res.status(400).json({ error: 'НЕДОСТАТОЧНО СРЕДСТВ' });

            const roll = Math.floor(Math.random() * 100) + 1;
            let isWin = false;
            let mult = 0;

            // Выравниваем сектора для точного покрытия от 1 до 100
            if (choice === 1 && roll <= 25) { isWin = true; mult = 3; }
            else if (choice === 2 && roll >= 26 && roll <= 50) { isWin = true; mult = 2; }
            else if (choice === 3 && roll >= 51 && roll <= 75) { isWin = true; mult = 2; }
            else if (choice === 4 && roll >= 76) { isWin = true; mult = 3; }

            const winTotal = isWin ? betAmount * mult : 0;
            user.dscoin_balance = user.dscoin_balance - betAmount + winTotal;
            await user.save();

            res.json({ success: true, roll, win: winTotal, newBalance: user.dscoin_balance });
        } catch (err) {
            console.error("Ошибка в Dice:", err);
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    });

    // CRASH (Автовывод)
    app.post('/api/games/crash', async (req, res) => {
        try {
            const betAmount = parseFloat(req.body.bet);
            const target = parseFloat(req.body.targetMultiplier);
            const user = await authenticate(req, res);
            if (!user) return;

            if (isNaN(target) || target < 1.1) return res.status(400).json({ error: 'МИНИМУМ 1.1x' });
            if (isNaN(betAmount) || betAmount <= 0 || !Number.isInteger(betAmount)) return res.status(400).json({ error: 'ОШИБКА СТАВКИ' });
            if (user.dscoin_balance < betAmount) return res.status(400).json({ error: 'НЕДОСТАТОЧНО СРЕДСТВ' });

            const e = 2 ** 32;
            const h = Math.floor(Math.random() * e);
            let crashPoint = Math.max(1.00, (e / (h + 1))); 
            
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

    // NEON ROULETTE
    app.post('/api/games/roulette', async (req, res) => {
        try {
            const betAmount = parseFloat(req.body.bet);
            const color = req.body.color; 
            const user = await authenticate(req, res);
            if (!user) return;

            if (!['purple', 'cyan', 'gold'].includes(color)) return res.status(400).json({ error: 'ВЫБЕРИТЕ ЦВЕТ' });
            if (isNaN(betAmount) || betAmount <= 0 || !Number.isInteger(betAmount)) return res.status(400).json({ error: 'ОШИБКА СТАВКИ' });
            if (user.dscoin_balance < betAmount) return res.status(400).json({ error: 'НЕДОСТАТОЧНО СРЕДСТВ' });

            const roll = Math.random() * 100;
            let resultColor = '';
            
            // Выровнено с фронтендом: Gold 5%, Cyan 47.5%, Purple 47.5%
            if (roll < 5) {
                resultColor = 'gold';
            } else if (roll < 52.5) {
                resultColor = 'cyan';
            } else {
                resultColor = 'purple';
            }

            const isWin = color === resultColor;
            const mult = resultColor === 'gold' ? 14 : 2;
            const winTotal = isWin ? betAmount * mult : 0;

            user.dscoin_balance = user.dscoin_balance - betAmount + winTotal;
            await user.save();

            res.json({ success: true, resultColor, isWin, win: winTotal, newBalance: user.dscoin_balance });
        } catch (err) {
            console.error("Ошибка в Roulette:", err);
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
            
            if (item.type === 'frame') user.activeFrame = itemId;
            if (item.type === 'title') user.activeTitle = item.name;

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
