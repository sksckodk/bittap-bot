const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEB_APP_URL = process.env.WEB_APP_URL || 'https://your-app.railway.app';
const ADMIN_ID = 1101048962;

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
        max_energy INT DEFAULT 1000,
        energy_level INT DEFAULT 1,
        last_energy_update TIMESTAMP DEFAULT NOW(),
        auto_mining_level INT DEFAULT 0,
        auto_mining_start TIMESTAMP,
        auto_mining_end TIMESTAMP,
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

// Обновление энергии
async function updateEnergy(userId) {
  try {
    const result = await pool.query(
      'SELECT energy, max_energy, last_energy_update FROM users WHERE user_id = $1',
      [userId]
    );
    
    if (result.rows.length > 0) {
      const user = result.rows[0];
      const now = new Date();
      const lastUpdate = new Date(user.last_energy_update);
      const secondsPassed = Math.floor((now - lastUpdate) / 1000);
      const energyToAdd = Math.min(secondsPassed, user.max_energy - user.energy);
      
      if (energyToAdd > 0) {
        const newEnergy = Math.min(user.energy + energyToAdd, user.max_energy);
        await pool.query(
          'UPDATE users SET energy = $1, last_energy_update = NOW() WHERE user_id = $2',
          [newEnergy, userId]
        );
        return newEnergy;
      }
      return user.energy;
    }
  } catch (error) {
    console.error('Energy update error:', error);
  }
  return 1000;
}

// Проверка и начисление авто-майнинга
async function processAutoMining(userId) {
  try {
    const result = await pool.query(
      'SELECT auto_mining_level, auto_mining_start, auto_mining_end, coins, total_coins FROM users WHERE user_id = $1',
      [userId]
    );
    
    if (result.rows.length > 0) {
      const user = result.rows[0];
      if (user.auto_mining_level > 0 && user.auto_mining_end) {
        const now = new Date();
        const endTime = new Date(user.auto_mining_end);
        
        if (now >= endTime) {
          const hoursElapsed = 8;
          const coinsEarned = user.auto_mining_level * hoursElapsed;
          
          await pool.query(
            'UPDATE users SET coins = coins + $1, total_coins = total_coins + $1, auto_mining_start = NULL, auto_mining_end = NULL WHERE user_id = $2',
            [coinsEarned, userId]
          );
          
          return { completed: true, earned: coinsEarned };
        }
      }
    }
  } catch (error) {
    console.error('Auto mining error:', error);
  }
  return { completed: false };
}

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
      const refResult = await pool.query(
        'INSERT INTO referrals (referrer_id, referred_id) VALUES ($1, $2) ON CONFLICT (referred_id) DO NOTHING RETURNING *',
        [parseInt(referralCode), userId]
      );
      
      if (refResult.rows.length > 0) {
        await pool.query(
          'UPDATE users SET coins = coins + 5000, total_coins = total_coins + 5000 WHERE user_id = $1',
          [parseInt(referralCode)]
        );
      }
    }

    const keyboard = {
      inline_keyboard: [[
        { text: 'Играть BitTap', web_app: { url: WEB_APP_URL } }
      ], [
        { text: 'Мой профиль', callback_data: 'profile' }
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

// Админ команды
bot.onText(/\/admin/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (userId !== ADMIN_ID) {
    return bot.sendMessage(chatId, 'У вас нет доступа к этой команде');
  }

  const keyboard = {
    inline_keyboard: [[
      { text: 'Статистика', callback_data: 'admin_stats' }
    ], [
      { text: 'Список пользователей', callback_data: 'admin_users' }
    ]]
  };

  bot.sendMessage(chatId, 'Админ панель:', { reply_markup: keyboard });
});

bot.onText(/\/reset (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const targetUserId = match[1];

  if (userId !== ADMIN_ID) {
    return bot.sendMessage(chatId, 'У вас нет доступа к этой команде');
  }

  try {
    await pool.query(
      'UPDATE users SET coins = 0, total_coins = 0, click_power = 1, boost_level = 1, energy = 1000, max_energy = 1000, energy_level = 1, auto_mining_level = 0, auto_mining_start = NULL, auto_mining_end = NULL WHERE user_id = $1',
      [targetUserId]
    );
    bot.sendMessage(chatId, `Аккаунт пользователя ${targetUserId} обнулён`);
  } catch (error) {
    bot.sendMessage(chatId, `Ошибка: ${error.message}`);
  }
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;

  try {
    if (data === 'profile') {
      await updateEnergy(userId);
      const user = await pool.query('SELECT * FROM users WHERE user_id = $1', [userId]);
      if (user.rows.length > 0) {
        const u = user.rows[0];
        bot.sendMessage(chatId,
          `Твой профиль\n\n` +
          `Монет: ${u.coins.toLocaleString()} $BIT\n` +
          `Всего намайнено: ${u.total_coins.toLocaleString()}\n` +
          `Сила тапа: +${u.click_power}\n` +
          `Уровень буста: ${u.boost_level}\n` +
          `Энергия: ${u.energy}/${u.max_energy}`
        );
      }
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

    if (data === 'admin_stats') {
      if (userId !== ADMIN_ID) return;
      
      const stats = await pool.query('SELECT COUNT(*) as total, SUM(total_coins) as coins FROM users');
      bot.sendMessage(chatId,
        `Статистика:\n\n` +
        `Всего пользователей: ${stats.rows[0].total}\n` +
        `Всего монет: ${stats.rows[0].coins || 0}`
      );
    }

    if (data === 'admin_users') {
      if (userId !== ADMIN_ID) return;
      
      const users = await pool.query('SELECT user_id, username, total_coins FROM users ORDER BY total_coins DESC LIMIT 10');
      let message = 'Топ пользователей:\n\n';
      users.rows.forEach(u => {
        message += `${u.username} (${u.user_id}): ${u.total_coins}\n`;
      });
      bot.sendMessage(chatId, message);
    }

    bot.answerCallbackQuery(query.id);
  } catch (error) {
    console.error('Callback error:', error);
  }
});

// API endpoints
app.get('/api/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    await updateEnergy(userId);
    const autoMining = await processAutoMining(userId);
    
    const user = await pool.query('SELECT * FROM users WHERE user_id = $1', [userId]);
    const response = user.rows[0] || { 
      coins: 0, 
      total_coins: 0, 
      click_power: 1, 
      boost_level: 1,
      energy: 1000,
      max_energy: 1000,
      energy_level: 1,
      auto_mining_level: 0
    };
    
    response.auto_mining_completed = autoMining.completed;
    response.auto_mining_earned = autoMining.earned || 0;
    
    res.json(response);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/user/:userId/tap', async (req, res) => {
  try {
    const { userId } = req.params;
    const { coins, energy, clickPower } = req.body;
    
    await pool.query(
      'UPDATE users SET coins = $1, total_coins = total_coins + $2, energy = $3, last_energy_update = NOW() WHERE user_id = $4',
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

app.post('/api/user/:userId/upgrade-energy', async (req, res) => {
  try {
    const { userId } = req.params;
    const { coins, energyLevel, maxEnergy } = req.body;
    
    await pool.query(
      'UPDATE users SET coins = $1, energy_level = $2, max_energy = $3 WHERE user_id = $4',
      [coins, energyLevel, maxEnergy, userId]
    );
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/user/:userId/buy-auto-mining', async (req, res) => {
  try {
    const { userId } = req.params;
    const { coins, autoMiningLevel } = req.body;
    
    await pool.query(
      'UPDATE users SET coins = $1, auto_mining_level = $2 WHERE user_id = $3',
      [coins, autoMiningLevel, userId]
    );
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/user/:userId/start-auto-mining', async (req, res) => {
  try {
    const { userId } = req.params;
    const { autoMiningLevel } = req.body;
    
    const startTime = new Date();
    const endTime = new Date(startTime.getTime() + 8 * 60 * 60 * 1000);
    
    await pool.query(
      'UPDATE users SET auto_mining_start = $1, auto_mining_end = $2 WHERE user_id = $3',
      [startTime, endTime, userId]
    );
    
    res.json({ success: true, endTime: endTime });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/user/:userId/claim-auto-mining', async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await processAutoMining(userId);
    
    if (result.completed) {
      const user = await pool.query('SELECT coins, total_coins FROM users WHERE user_id = $1', [userId]);
      res.json({ 
        success: true, 
        earned: result.earned,
        coins: user.rows[0].coins,
        total_coins: user.rows[0].total_coins
      });
    } else {
      res.json({ success: false, message: 'Авто-майнинг ещё не завершён' });
    }
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
