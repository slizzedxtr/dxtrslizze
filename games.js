// ==========================================
// ЯДРО СИСТЕМЫ И ЭКОНОМИКИ (DXTR | SlizZe)
// ==========================================

const API_URL = "https://dxtr-games-api.onrender.com/api/game";
const clientId = localStorage.getItem('dxtrNumericId') || "1";

// Глобальный объект для управления экономикой
const DXTR_Economy = {
    balance: 0,
    
    async sync() {
        try {
            const res = await fetch(`${API_URL}/sync`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ clientId })
            });
            const data = await res.json();
            this.balance = data.balance || 0;
            this.updateUI();
            return data;
        } catch (e) {
            console.error("Ошибка синхронизации экономики:", e);
        }
    },

    updateUI() {
        // Ищет все элементы с классом .dsc-balance и обновляет в них текст
        document.querySelectorAll('.dsc-balance').forEach(el => {
            el.innerText = Math.floor(this.balance);
        });
    }
};


// ==========================================
// 1. УГАДАЙ ТРЕК (Guess The Track)
// ==========================================

const GuessGame = {
    currentAudio: null,
    timerInterval: null,
    correctAnswer: "",
    isPlaying: false,

    async start() {
        if (DXTR_Economy.balance < 50) return alert("Недостаточно DSCoin! Нужно минимум 50.");
        
        try {
            const res = await fetch(`${API_URL}/guess-track`);
            if (!res.ok) throw new Error("Ошибка загрузки трека");
            const data = await res.json();

            this.correctAnswer = data.answer;
            this.setupPlayer(data.audioUrl, data.options);
        } catch (e) {
            console.error(e);
            alert("Не удалось запустить игру.");
        }
    },

    setupPlayer(audioUrl, options) {
        if (this.currentAudio) this.currentAudio.pause();
        
        this.currentAudio = new Audio(audioUrl);
        this.currentAudio.currentTime = 15; // Начинаем с 15-й секунды
        this.currentAudio.play();
        this.isPlaying = true;

        this.renderOptions(options);
        this.startTimer(15);
    },

    startTimer(seconds) {
        let timeLeft = seconds;
        clearInterval(this.timerInterval);
        
        // Ожидается, что на HTML есть элемент с ID 'guessTimer'
        const timerUI = document.getElementById('guessTimer'); 

        this.timerInterval = setInterval(() => {
            timeLeft--;
            if (timerUI) timerUI.style.width = `${(timeLeft / 15) * 100}%`;
            
            if (timeLeft <= 0) {
                this.endGame(false); // Время вышло = проигрыш
            }
        }, 1000);
    },

    async endGame(isWin, selectedBtn = null) {
        clearInterval(this.timerInterval);
        this.isPlaying = false;
        if (this.currentAudio) {
            // Плавное затухание звука
            let vol = 1;
            let fadeOut = setInterval(() => {
                if (vol > 0.1) { vol -= 0.1; this.currentAudio.volume = vol; } 
                else { clearInterval(fadeOut); this.currentAudio.pause(); }
            }, 100);
        }

        // Отправляем результат на сервер
        try {
            const res = await fetch(`${API_URL}/guess-result`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ clientId, isWin })
            });
            const data = await res.json();
            DXTR_Economy.balance = data.newBalance;
            DXTR_Economy.updateUI();
        } catch (e) {
            console.error("Ошибка отправки результата", e);
        }

        if (isWin) alert("Верно! +100 DSCoin чистой прибыли.");
        else alert("Неверно (или время вышло). -50 DSCoin.");
    },

    renderOptions(options) {
        const container = document.getElementById('guessOptions'); // Ожидается контейнер в HTML
        if (!container) return;
        container.innerHTML = '';

        options.forEach(opt => {
            const btn = document.createElement('button');
            btn.innerText = opt;
            btn.onclick = () => {
                if (!this.isPlaying) return;
                const isCorrect = (opt === this.correctAnswer);
                btn.style.backgroundColor = isCorrect ? 'green' : 'red';
                this.endGame(isCorrect, btn);
            };
            container.appendChild(btn);
        });
    }
};


// ==========================================
// 2. КЛИКЕР (Beat Clicker)
// ==========================================

const ClickerGame = {
    unsyncedClicks: 0,
    clickPower: 1, // Можно потом подтягивать с бэкенда (прокачка)
    syncInterval: null,

    init() {
        // Синхронизируем клики с сервером каждые 10 секунд, чтобы не спамить запросами
        this.syncInterval = setInterval(() => this.syncWithServer(), 10000);
    },

    click() {
        this.unsyncedClicks += this.clickPower;
        
        // Визуально сразу прибавляем баланс, чтобы юзер видел реакцию
        DXTR_Economy.balance += this.clickPower;
        DXTR_Economy.updateUI();
        
        this.spawnFloatingNumber(event); // Анимация вылетающей циферки (нужна реализация в HTML/CSS)
    },

    async syncWithServer() {
        if (this.unsyncedClicks === 0) return;
        
        const clicksToSend = this.unsyncedClicks;
        this.unsyncedClicks = 0; // Обнуляем локальный счетчик до отправки

        try {
            const res = await fetch(`${API_URL}/clicker-sync`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ clientId, clicks: clicksToSend })
            });
            const data = await res.json();
            // Актуализируем баланс с сервером на случай рассинхрона
            DXTR_Economy.balance = data.balance; 
            DXTR_Economy.updateUI();
        } catch (e) {
            console.error("Ошибка синхронизации кликера", e);
            this.unsyncedClicks += clicksToSend; // Возвращаем клики при ошибке
        }
    },

    spawnFloatingNumber(e) {
        // Простая логика создания визуального '+1' на экране в месте клика
        if(!e) return;
        const num = document.createElement('div');
        num.innerText = `+${this.clickPower}`;
        num.className = 'floating-number';
        num.style.left = `${e.clientX}px`;
        num.style.top = `${e.clientY}px`;
        num.style.position = 'absolute';
        num.style.color = '#00c6ff';
        num.style.pointerEvents = 'none';
        document.body.appendChild(num);
        
        setTimeout(() => num.remove(), 1000); // Удаляем через секунду
    }
};


// ==========================================
// 3. МИНИ КАЗИНО (Neon Slots)
// ==========================================

const CasinoGame = {
    isSpinning: false,

    async spin() {
        if (this.isSpinning) return;
        this.isSpinning = true;

        // Ожидается анимация на фронте
        const slotUI = document.getElementById('slotMachine'); 
        if (slotUI) slotUI.classList.add('spinning');

        try {
            const res = await fetch(`${API_URL}/casino-spin`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ clientId })
            });
            
            if (!res.ok) {
                const errData = await res.json();
                throw new Error(errData.error || "Ошибка казино");
            }
            
            const data = await res.json();
            
            // Имитация времени прокрутки рулетки (2 секунды)
            setTimeout(() => {
                if (slotUI) slotUI.classList.remove('spinning');
                this.isSpinning = false;
                
                DXTR_Economy.balance = data.newBalance;
                DXTR_Economy.updateUI();
                
                alert(`Результат: ${data.prizeType}! Выиграно: ${data.amount}`);
            }, 2000);

        } catch (e) {
            this.isSpinning = false;
            if (slotUI) slotUI.classList.remove('spinning');
            alert(e.message); // Например: "Лимит в 5 прокрутов исчерпан"
        }
    }
};


// ==========================================
// 4. РИТМ ИГРА (Rhythm Master) - Базовый движок
// ==========================================

const RhythmGame = {
    isPlaying: false,
    audio: null,
    score: 0,
    beatMap: [], // Массив таймингов: [1.2, 1.8, 2.4...]
    hitWindow: 0.2, // Окно попадания (секунды)

    start(audioUrl, beatMapArray) {
        this.beatMap = beatMapArray;
        this.score = 0;
        this.isPlaying = true;
        
        this.audio = new Audio(audioUrl);
        this.audio.play();

        this.gameLoop();
    },

    hit() {
        if (!this.isPlaying) return;
        
        const currentTime = this.audio.currentTime;
        let hitSuccess = false;

        // Ищем ноту, которая находится в пределах hitWindow
        for (let i = 0; i < this.beatMap.length; i++) {
            const noteTime = this.beatMap[i];
            if (Math.abs(currentTime - noteTime) <= this.hitWindow) {
                hitSuccess = true;
                this.score += 10;
                this.beatMap.splice(i, 1); // Удаляем сыгранную ноту
                console.log("ПОПАДАНИЕ! Скор:", this.score);
                break;
            }
        }

        if (!hitSuccess) {
            console.log("ПРОМАХ!"); // Можно вычитать очки или прерывать комбо
        }
    },

    gameLoop() {
        if (!this.isPlaying) return;
        
        // Тут в будущем будет логика отрисовки падающих нот на Canvas
        // ...

        if (!this.audio.ended) {
            requestAnimationFrame(() => this.gameLoop());
        } else {
            this.endGame();
        }
    },

    async endGame() {
        this.isPlaying = false;
        alert(`Трек окончен! Твой счет: ${this.score}`);
        
        // Отправка результатов на сервер для конвертации очков в DSCoin
        try {
            await fetch(`${API_URL}/rhythm-result`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ clientId, score: this.score })
            });
            DXTR_Economy.sync(); // Обновляем баланс
        } catch (e) {
            console.error("Ошибка сохранения результата ритм-игры", e);
        }
    }
};

// Запуск синхронизации при загрузке скрипта
window.onload = () => {
    DXTR_Economy.sync();
    ClickerGame.init();
};
