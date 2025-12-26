const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEB_APP_URL = process.env.WEB_APP_URL || 'https://your-app.railway.app';
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const app = express();
app.use(cors());
app.use(express.json());

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        user_id BIGINT PRIMARY KEY,
        username VARCHAR(255),
        coins BIGINT DEFAULT 0,
        total_coins BIGINT DEFAULT 0,
        click_power INT DEFAULT 1,
        boost_level INT DEFAULT 1,
        energy INT DEFAULT 1000,
        last_daily TIMESTAMP,
        referrer_id BIGINT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS referrals (
        id SERIAL PRIMARY KEY,
        referrer_id BIGINT,
        referred_id BIGINT UNIQUE,
        bonus_claimed BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Database init error:', error);
  }
}

initDB();

bot.onText(/\/start(.*)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username || msg.from.first_name;
  const referralCode = match[1].trim().replace('ref', '');

  try {
    await pool.query(
      'INSERT INTO users (user_id, username) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING',
      [userId, username]
    );

    if (referralCode && referralCode !== userId.toString()) {
      await pool.query(
        'INSERT INTO referrals (referrer_id, referred_id) VALUES ($1, $2) ON CONFLICT (referred_id) DO NOTHING',
        [parseInt(referralCode), userId]
      );
      
      await pool.query(
        'UPDATE users SET coins = coins + 5000, total_coins = total_coins + 5000 WHERE user_id = $1',
        [parseInt(referralCode)]
      );
    }

    const keyboard = {
      inline_keyboard: [[
        { text: 'Играть BitTap', web_app: { url: WEB_APP_URL } }
      ], [
        { text: 'Мой профиль', callback_data: 'profile' },
        { text: 'Топ игроков', callback_data: 'leaderboard' }
      ], [
        { text: 'Пригласить друзей', callback_data: 'referral' }
      ]]
    };

    bot.sendMessage(chatId, 
      `Добро пожаловать в BitTap!\n\n` +
      `Майни криптовалюту будущего $BIT\n` +
      `Тапай, прокачивайся, зарабатывай\n` +
      `Скоро листинг на биржах\n\n` +
      `Начни майнить прямо сейчас`,
      { reply_markup: keyboard }
    );
  } catch (error) {
    console.error('Start command error:', error);
  }
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;

  try {
    if (data === 'profile') {
      const user = await pool.query('SELECT * FROM users WHERE user_id = $1', [userId]);
      if (user.rows.length > 0) {
        const u = user.rows[0];
        bot.sendMessage(chatId,
          `Твой профиль\n\n` +
          `Монет: ${u.coins.toLocaleString()} $BIT\n` +
          `Всего намайнено: ${u.total_coins.toLocaleString()}\n` +
          `Сила тапа: +${u.click_power}\n` +
          `Уровень буста: ${u.boost_level}`
        );
      }
    }

    if (data === 'leaderboard') {
      const leaders = await pool.query(
        'SELECT username, total_coins FROM users ORDER BY total_coins DESC LIMIT 10'
      );
      
      let message = 'Топ-10 майнеров\n\n';
      leaders.rows.forEach((user, index) => {
        message += `${index + 1}. ${user.username}: ${user.total_coins.toLocaleString()} $BIT\n`;
      });
      
      bot.sendMessage(chatId, message);
    }

    if (data === 'referral') {
      const botInfo = await bot.getMe();
      const refLink = `https://t.me/${botInfo.username}?start=ref${userId}`;
      const refCount = await pool.query(
        'SELECT COUNT(*) FROM referrals WHERE referrer_id = $1',
        [userId]
      );
      
      bot.sendMessage(chatId,
        `Реферальная программа\n\n` +
        `Получай 5000 $BIT за каждого друга\n` +
        `Твоих рефералов: ${refCount.rows[0].count}\n\n` +
        `Твоя ссылка:\n${refLink}`
      );
    }

    bot.answerCallbackQuery(query.id);
  } catch (error) {
    console.error('Callback error:', error);
  }
});

app.get('/api/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await pool.query('SELECT * FROM users WHERE user_id = $1', [userId]);
    res.json(user.rows[0] || { coins: 0, total_coins: 0, click_power: 1, boost_level: 1 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/user/:userId/tap', async (req, res) => {
  try {
    const { userId } = req.params;
    const { coins, energy, clickPower } = req.body;
    
    await pool.query(
      'UPDATE users SET coins = $1, total_coins = total_coins + $2, energy = $3 WHERE user_id = $4',
      [coins, clickPower, energy, userId]
    );
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/user/:userId/upgrade', async (req, res) => {
  try {
    const { userId } = req.params;
    const { coins, boostLevel, clickPower } = req.body;
    
    await pool.query(
      'UPDATE users SET coins = $1, boost_level = $2, click_power = $3 WHERE user_id = $4',
      [coins, boostLevel, clickPower, userId]
    );
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const leaders = await pool.query(
      'SELECT user_id, username, total_coins FROM users ORDER BY total_coins DESC LIMIT 100'
    );
    res.json(leaders.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/', (req, res) => {
  res.send('BitTap Bot is running!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`BitTap bot running on port ${PORT}`);
});
```

5. Нажмите **Commit changes** → **Commit changes**

---

После этого Railway автоматически пересоберёт проект (подождите 1-2 минуты).

Затем проверьте логи снова - ошибка должна исчезнуть, и вы увидите:
```
BitTap bot running on port 3000
Database initialized successfully
