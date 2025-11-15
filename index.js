// ========================================
// 隙音 LINE Bot - Render (V3.3 - 正式版)
// ========================================
const express = require('express');
const line = require('@line/bot-sdk');
const cron = require('node-cron');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const OpenAI = require('openai');

// --- 1. 初始化設定 ---

const lineConfig = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

// 安全地處理 Google Private Key（避免 undefined 錯誤）
const googlePrivateKey = process.env.GOOGLE_PRIVATE_KEY;
if (!googlePrivateKey) {
  console.error('WARNING: GOOGLE_PRIVATE_KEY environment variable is not set');
}

const serviceAccountAuth = new JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: googlePrivateKey ? googlePrivateKey.replace(/\\n/g, '\n') : '',
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const SPREADSHEET_ID = '1TMyXHW2BaYJ3l8p1EdCQfb9Vhx_fJUrAZAEVOSBiom0';
const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);

// 安全的 loadInfo 包裝函數，帶重試機制和詳細錯誤處理
async function safeLoadInfo(maxRetries = 3, timeout = 10000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[safeLoadInfo] Attempt ${attempt}/${maxRetries} to load spreadsheet info`);
      await Promise.race([
        doc.loadInfo(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error(`Spreadsheet load timeout after ${timeout}ms`)), timeout)
        )
      ]);
      console.log(`[safeLoadInfo] Successfully loaded spreadsheet: ${doc.title}`);
      return true;
    } catch (error) {
      console.error(`[safeLoadInfo] Attempt ${attempt} failed:`, error.message);
      if (error.response) {
        console.error(`[safeLoadInfo] API Response Status: ${error.response.status}`);
        console.error(`[safeLoadInfo] API Response Data:`, JSON.stringify(error.response.data, null, 2));
      }
      
      // 如果是最後一次嘗試，拋出錯誤
      if (attempt === maxRetries) {
        console.error(`[safeLoadInfo] All ${maxRetries} attempts failed`);
        throw error;
      }
      
      // 等待後重試（指數退避）
      const waitTime = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
      console.log(`[safeLoadInfo] Waiting ${waitTime}ms before retry...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }
}

const client = new line.Client(lineConfig);
const app = express();

// Express 中間件
app.use(express.json());

// 請求超時處理（30秒）
app.use((req, res, next) => {
  req.setTimeout(30000, () => {
    console.error(`Request timeout: ${req.method} ${req.path}`);
    if (!res.headersSent) {
      res.status(504).json({ error: 'Request timeout' });
    }
  });
  next();
});

// 全局錯誤處理
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 處理未捕獲的異常
process.on('uncaughtException', (err) => {
  console.error('========================================');
  console.error('CRITICAL: Uncaught Exception detected!');
  console.error('Time:', new Date().toISOString());
  console.error('Error:', err);
  console.error('Stack:', err.stack);
  console.error('========================================');
  // 不要立即退出，讓服務繼續運行，但記錄詳細錯誤
  // 如果錯誤太嚴重，Render 會自動重啟服務
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('========================================');
  console.error('CRITICAL: Unhandled Rejection detected!');
  console.error('Time:', new Date().toISOString());
  console.error('Promise:', promise);
  console.error('Reason:', reason);
  if (reason instanceof Error) {
    console.error('Stack:', reason.stack);
  }
  console.error('========================================');
  // 不要立即退出，讓服務繼續運行，但記錄詳細錯誤
});

// 監聽進程退出事件（用於診斷）
process.on('exit', (code) => {
  console.error('========================================');
  console.error('Process exiting with code:', code);
  console.error('Time:', new Date().toISOString());
  console.error('========================================');
});

// 監聽警告
process.on('warning', (warning) => {
  console.warn('Process warning:', warning);
  console.warn('Stack:', warning.stack);
});

// --- 2. Webhook & 測試路徑 ---

app.get('/', (req, res) => {
  // 這個路徑主要用於 Uptime Robot 保持服務喚醒
  const now = new Date();
  console.log(`[${now.toISOString()}] Health check ping from Uptime Robot`);
  res.status(200).send('OK');
});

// 健康檢查端點 - 快速響應，避免超時
// 注意：Render 健康檢查只等待 5 秒，所以這個端點必須快速響應
app.get('/health', async (req, res) => {
  const startTime = Date.now();
  const now = new Date();
  
  // 快速響應基本狀態（不執行耗時的 API 調用）
  // 如果已經載入過 spreadsheet，顯示標題；否則只顯示基本狀態
  const basicHealth = {
    status: 'healthy',
    timestamp: now.toISOString(),
    localTime: now.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }),
    serverTime: now.toLocaleString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    tzOffset: now.getTimezoneOffset(),
    uptime: process.uptime(),
    responseTime: `${Date.now() - startTime}ms`,
    spreadsheet: doc.title || 'not loaded yet'
  };

  // 如果請求包含 ?full=true，才執行完整的健康檢查（包括 API 調用）
  if (req.query.full === 'true') {
    try {
      const apiStartTime = Date.now();
      await safeLoadInfo(1, 3000); // 健康檢查只嘗試一次，3秒超時
      const apiLoadTime = Date.now() - apiStartTime;
      
      res.status(200).json({
        ...basicHealth,
        spreadsheet: doc.title || 'connected',
        apiLoadTime: `${apiLoadTime}ms`,
        fullCheck: true
      });
    } catch (err) {
      // 即使 API 調用失敗，也返回基本健康狀態（服務本身是健康的）
      console.error('Health check API call failed:', err.message);
      res.status(200).json({
        ...basicHealth,
        apiError: err.message,
        fullCheck: true
      });
    }
  } else {
    // 快速響應，不執行 API 調用
    res.status(200).json(basicHealth);
  }
});

// --- 2.1 CRON Endpoints（給外部 CRON 服務呼叫）---

// 安全驗證中介軟體
function verifyCronSecret(req, res, next) {
  const secret = req.query.secret || req.headers['x-cron-secret'];
  const expectedSecret = process.env.CRON_SECRET;

  if (!expectedSecret) {
    console.warn('CRON_SECRET not set in environment variables');
    return res.status(500).json({ error: 'CRON_SECRET not configured' });
  }

  if (secret !== expectedSecret) {
    console.warn('Invalid CRON secret attempt');
    return res.status(403).json({ error: 'Forbidden' });
  }

  next();
}

// 週一 9:00 - 發送主題選擇
app.get('/cron/monday-theme', verifyCronSecret, async (req, res) => {
  console.log('CRON endpoint triggered: /cron/monday-theme');
  try {
    await safeLoadInfo();
    const summary = await sendMondayThemeSelection();
    // 從 summary 中解構，將詳細的 results 陣列排除，只保留統計數字
    const { results, ...responseSummary } = summary;
    res.status(200).json({
      success: true,
      message: 'Monday theme selection completed',
      summary: responseSummary
    });
  } catch (err) {
    console.error('Error in /cron/monday-theme:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 週二至週五 9:00 - 發送每日問題
app.get('/cron/daily-question', verifyCronSecret, async (req, res) => {
  const startTime = Date.now();
  console.log('CRON endpoint triggered: /cron/daily-question');

  try {
    // 確保 Spreadsheet 已載入
    if (!doc.title) {
      console.log('Loading spreadsheet for the first time...');
      await safeLoadInfo();
    }

    const result = await sendDailyQuestion();
    const executionTime = Date.now() - startTime;

    console.log('Daily question execution completed:', result);
    console.log(`Execution time: ${executionTime}ms`);

    // 從 result 中解構，將詳細的 skippedReasons 陣列排除，只保留統計數字
    const { skippedReasons, ...responseResult } = result;
    res.status(200).json({
      success: true,
      message: 'Daily questions sent',
      executionTime: `${executionTime}ms`,
      ...responseResult
    });
  } catch (err) {
    const executionTime = Date.now() - startTime;
    console.error('Error in /cron/daily-question:', err);
    console.error(`Failed after ${executionTime}ms`);
    res.status(500).json({
      success: false,
      error: err.message,
      executionTime: `${executionTime}ms`
    });
  }
});

// 週六 20:00 - 發送週末回顧
app.get('/cron/saturday-review', verifyCronSecret, async (req, res) => {
  console.log('CRON endpoint triggered: /cron/saturday-review');
  try {
    await safeLoadInfo();
    await sendSaturdayReview();
    res.status(200).json({ success: true, message: 'Saturday review sent' });
  } catch (err) {
    console.error('Error in /cron/saturday-review:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 每月最後一天 22:00 - 發送月度總結
app.get('/cron/monthly-review', verifyCronSecret, async (req, res) => {
  console.log('CRON endpoint triggered: /cron/monthly-review');
  try {
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    // 檢查明天是否為該月第一天
    if (tomorrow.getDate() === 1) {
      await safeLoadInfo();
      // 不等待，讓它在背景執行，但必須捕獲錯誤避免未處理的 Promise rejection
      sendMonthlyReview().catch(err => {
        console.error('Error in background sendMonthlyReview:', err);
      });
      res.status(200).json({ success: true, message: 'Monthly review process started' });
    } else {
      res.status(200).json({ success: true, message: 'Not last day of month, skipped' });
    }
  } catch (err) {
    console.error('Error in /cron/monthly-review:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 測試用 - 強制執行月度總結（忽略日期檢查）
app.get('/cron/monthly-review-test', verifyCronSecret, async (req, res) => {
  console.log('TEST endpoint triggered: /cron/monthly-review-test');
  try {
    await safeLoadInfo();
    // 不等待，讓它在背景執行，但必須捕獲錯誤避免未處理的 Promise rejection
    sendMonthlyReview().catch(err => {
      console.error('Error in background sendMonthlyReview (test):', err);
    });
    res.status(200).json({ success: true, message: 'Monthly review test process started' });
  } catch (err) {
    console.error('Error in /cron/monthly-review-test:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 標準的 Webhook 處理器
app.post('/webhook', line.middleware(lineConfig), (req, res) => {
  if (!req.body.events || req.body.events.length === 0) {
    return res.json({});
  }
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

async function handleEvent(event) {
  // 我們只處理文字訊息和 postback 事件
  // 排除掉 LINE Verify Webhook 時發送的空事件
  if (event.type !== 'message' && event.type !== 'postback') {
    return Promise.resolve(null);
  }
  
  try {
    await safeLoadInfo();
    if (event.type === 'message' && event.message.type === 'text') {
      await handleTextMessage(event);
    } else if (event.type === 'postback') {
      await handlePostback(event);
    }
  } catch (err) {
    console.error('Error in handleEvent:', err);
    // 即使 loadInfo 失敗，也嘗試處理事件（可能已經載入過）
    if (doc.title) {
      try {
        if (event.type === 'message' && event.message.type === 'text') {
          await handleTextMessage(event);
        } else if (event.type === 'postback') {
          await handlePostback(event);
        }
      } catch (retryErr) {
        console.error('Error retrying handleEvent:', retryErr);
      }
    }
  }
  return Promise.resolve(null);
}

// --- 3. 定時任務排程 ---
// 注意：已停用內建 node-cron，改用外部 cron-job.org 服務
// 原因：避免與外部 CRON 重複執行，且 Render 免費方案會休眠導致內建 cron 不可靠

// cron.schedule('0 9 * * 1', async () => {
//   console.log('Running: sendMondayThemeSelection @ 9:00 AM Taipei Time');
//   try {
//     await doc.loadInfo();
//     await sendMondayThemeSelection();
//   } catch (err) {
//     console.error('Error in sendMondayThemeSelection cron job:', err);
//   }
// }, { timezone: "Asia/Taipei" });

// cron.schedule('0 9 * * 2-5', async () => {
//   console.log('Running: sendDailyQuestion @ 9:00 AM Taipei Time');
//   try {
//     await doc.loadInfo();
//     await sendDailyQuestion();
//   } catch (err) {
//     console.error('Error in sendDailyQuestion cron job:', err);
//   }
// }, { timezone: "Asia/Taipei" });

// cron.schedule('0 20 * * 6', async () => {
//   console.log('Running: sendSaturdayReview @ 8:00 PM Taipei Time');
//   try {
//     await doc.loadInfo();
//     await sendSaturdayReview();
//   } catch (err) {
//     console.error('Error in sendSaturdayReview cron job:', err);
//   }
// }, { timezone: "Asia/Taipei" });

// cron.schedule('0 22 * * *', async () => {
//   const today = new Date();
//   const tomorrow = new Date(today);
//   tomorrow.setDate(today.getDate() + 1);
//   if (tomorrow.getDate() === 1) {
//     console.log('Running: sendMonthlyReview @ 10:00 PM on Last Day of Month');
//     try {
//       await doc.loadInfo();
//       await sendMonthlyReview();
//     } catch (err) {
//       console.error('Error in sendMonthlyReview cron job:', err);
//     }
//   }
// }, { timezone: "Asia/Taipei" });


// --- 4. 核心程式碼邏輯 ---

const THEME_MAP = { 'SELF': '自己', 'CREATION': '創作', 'FAMILY': '家庭' };

async function replyWithText(replyToken, messageId, fallbackId = 'GENERIC_ERROR') {
  try {
    let msg = await getMessage(messageId);
    if (!msg) {
      msg = await getMessage(fallbackId);
    }
    await client.replyMessage(replyToken, { type: 'text', text: msg ? msg.message : '系統發生錯誤' });
  } catch (error) {
    console.error(`Error in replyWithText (messageId: ${messageId}):`, error);
    // 嘗試發送一個簡單的錯誤訊息
    try {
      await client.replyMessage(replyToken, { type: 'text', text: '系統暫時無法處理您的請求，請稍後再試。' });
    } catch (replyError) {
      console.error('Failed to send error message:', replyError);
    }
  }
}

function createMessageObject(text, buttons) {
  let message = { type: 'text', text: text };
  if (buttons && buttons.length > 0) {
    message = {
      type: 'template',
      altText: text.substring(0, 400),
      template: {
        type: 'buttons',
        text: text.substring(0, 160),
        actions: buttons.map(btn => ({ type: 'postback', label: btn.label.substring(0, 20), data: btn.data }))
      }
    };
  }
  return message;
}

async function handleTextMessage(event) {
  const userId = event.source.userId;
  const replyToken = event.replyToken;
  const userSheet = doc.sheetsByTitle['Users'];
  let user = await getOrCreateUser(userId, userSheet);

  if (!user.status || user.status === 'new' || user.status === 'idle' || user.status === 'waiting_monday') {
    await sendWelcomeMessage(replyToken, userId);
  } else if (user.status === 'waiting_theme') {
    await replyWithText(replyToken, 'PROMPT_THEME_CHOICE');
  } else if (user.status === 'waiting_answer') {
    await saveUserAnswer(userId, event.message.text);
    await replyWithText(replyToken, 'HEARD');
    await updateUserStatus(userId, 'active');
  } else if (user.status === 'saturday_showed_record') {
    // 使用者在週六看過紀錄後，又發送了文字訊息
    await replyWithText(replyToken, 'SATURDAY_END');
    await updateUserStatus(userId, 'active');
  } else if (user.status === 'active') {
    await replyWithText(replyToken, 'ACK_ACTIVE');
  } else {
    await replyWithText(replyToken, 'FALLBACK_GENERAL');
  }
}

async function handlePostback(event) {
  const userId = event.source.userId;
  const data = event.postback.data;
  const replyToken = event.replyToken;
  const params = {};
  data.split('&').forEach(pair => { const [key, value] = pair.split('='); params[key] = decodeURIComponent(value); });

  let msg;
  let text;
  let message;

  switch (params.action) {
    case 'start_now':
    case 'start_week':
      msg = await getMessage('START_READY');
      text = msg ? msg.message : (await getMessage('START_READY_FALLBACK')).message;
      message = createMessageObject(text, msg ? msg.buttons : null);
      await client.replyMessage(replyToken, message);
      await updateUserStatus(userId, 'waiting_theme');
      break;

    case 'ready':
      msg = await getMessage('THEME_SELECT');
      text = msg ? msg.message : (await getMessage('THEME_SELECT_FALLBACK')).message;
      message = createMessageObject(text, msg ? msg.buttons : null);
      await client.replyMessage(replyToken, message);
      break;

    case 'select_theme':
      await handleThemeSelection(replyToken, userId, params.theme);
      break;

    case 'start_question':
      // 使用者點擊按鈕，直接為該使用者發送問題
      await sendDailyQuestionForUser(userId);
      // 這是一個 push message，所以不需要 replyToken
      break;

    case 'how_to_play':
      await replyWithText(replyToken, 'HOW_TO_PLAY', 'HOW_TO_PLAY_FALLBACK');
      break;

    case 'later':
      await replyWithText(replyToken, 'LATER', 'LATER_FALLBACK');
      await updateUserStatus(userId, 'waiting_monday');
      break;

    case 'show_record':
      const recordsText = await getWeeklyRecords(userId);
      await client.replyMessage(replyToken, { type: 'text', text: recordsText });
      // 設定狀態為「週六回顧後」，等待使用者輸入
      await updateUserStatus(userId, 'saturday_showed_record');
      break;

    // AI 總結功能已移除
    // case 'get_insight':
    //   await client.replyMessage(replyToken, { type: 'text', text: '好的，正在為您產生 AI 總結，請稍候幾秒鐘...' });
    //   const insightText = await generateAiInsight(userId);
    //   await client.pushMessage(userId, { type: 'text', text: insightText });
    //   break;
  }
}

async function handleThemeSelection(replyToken, userId, theme) {
  await saveUserTheme(userId, theme); // 狀態已設為 active

  const messageId = 'CONFIRM_' + theme;
  const confirmMsg = await getMessage(messageId);
  let text;

  if (confirmMsg) {
    text = confirmMsg.message;
  } else {
    const fallbackMsg = await getMessage('THEME_CONFIRM_FALLBACK');
    const themeChinese = THEME_MAP[theme] || '這個主題';
    text = fallbackMsg ? fallbackMsg.message.replace('【主題】', themeChinese) : `收到。\n\n這週，我們一起關注「${themeChinese}」。`;
  }

  const today = new Date().getDay(); // 0 = Sun, 1 = Mon, ..., 6 = Sat
  let buttons = null;
  if (today >= 1 && today <= 5) { // 如果是週一到週五
    buttons = [{ "label": "開始回答今天問題", "data": "action=start_question" }];
  } else {
    text += '\n\n問題將從下週一開始。';
  }

  const message = createMessageObject(text, buttons);
  await client.replyMessage(replyToken, message);
}


async function sendWelcomeMessage(replyToken, userId) {
  const today = new Date().getDay();
  const messageId = (today === 1) ? 'WELCOME_MONDAY' : 'WELCOME_OTHER_DAY'; // 週日加入也視為非週一
  const welcomeMsg = await getMessage(messageId);
  if (welcomeMsg) {
    const message = createMessageObject(welcomeMsg.message, welcomeMsg.buttons);
    await client.replyMessage(replyToken, message);
    const status = (today === 1) ? 'waiting_theme' : 'waiting_monday';
    await updateUserStatus(userId, status);
  } else {
    await replyWithText(replyToken, 'WELCOME_FALLBACK');
  }
}

// --- 5. 資料庫操作函式 ---

async function getOrCreateUser(userId, userSheet) {
  const rows = await userSheet.getRows();
  const userRow = rows.find(row => row.get('userId') === userId);
  if (userRow) {
    return userRow.toObject();
  }
  const now = new Date();
  const newUserRow = await userSheet.addRow({ userId: userId, status: 'new', CreatedAt: now });
  return newUserRow.toObject();
}

async function updateUserStatus(userId, status) {
  const userSheet = doc.sheetsByTitle['Users'];
  const rows = await userSheet.getRows();
  const userRow = rows.find(row => row.get('userId') === userId);
  if (userRow) {
    const oldStatus = userRow.get('status');
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] Status change for user ${userId}: ${oldStatus} -> ${status}`);

    userRow.set('status', status);
    userRow.set('lastActive', new Date());
    await userRow.save();
  }
}

async function saveUserTheme(userId, theme) {
  const userSheet = doc.sheetsByTitle['Users'];
  const rows = await userSheet.getRows();
  const userRow = rows.find(row => row.get('userId') === userId);
  if (userRow) {
    userRow.set('status', 'active');
    userRow.set('currentTheme', theme);
    userRow.set('currentWeek', getCurrentWeekString());
    userRow.set('lastActive', new Date());
    await userRow.save();
  }
}

async function getMessage(messageId) {
  const messageSheet = doc.sheetsByTitle['Messages'];
  if (!messageSheet) {
    console.error("Sheet 'Messages' not found.");
    return null;
  }
  const rows = await messageSheet.getRows();
  const row = rows.find(r => r.get('MessageID') === messageId && (r.get('Active') === 'TRUE' || r.get('Active') === true));
  if (row) {
    return {
      message: row.get('Message'),
      buttons: row.get('Buttons') ? JSON.parse(row.get('Buttons')) : null
    };
  }
  console.warn(`Message with ID "${messageId}" not found in sheet.`);
  return null;
}

async function getQuestion(theme, day) {
  const questionSheet = doc.sheetsByTitle['Questions'];
  const rows = await questionSheet.getRows();
  const matchingQuestions = rows.filter(row =>
    row.get('Theme') === theme &&
    row.get('Day') === day &&
    (row.get('Active') === 'TRUE' || row.get('Active') === true)
  );
  if (matchingQuestions.length > 0) {
    const row = matchingQuestions[Math.floor(Math.random() * matchingQuestions.length)];
    return { questionId: row.get('QuestionID'), question: row.get('Question') };
  }
  return null;
}

async function getQuestionById(questionId) {
  const questionSheet = doc.sheetsByTitle['Questions'];
  const rows = await questionSheet.getRows();
  const row = rows.find(r => r.get('QuestionID') === questionId);
  if (row) {
    return { questionId: row.get('QuestionID'), question: row.get('Question') };
  }
  return null;
}

async function saveUserAnswer(userId, answer) {
  const userSheet = doc.sheetsByTitle['Users'];
  const user = await getOrCreateUser(userId, userSheet);

  if (!user.lastQuestionId) {
    console.log(`User ${userId} answered without a pending question. Ignoring.`);
    return;
  }

  const question = await getQuestionById(user.lastQuestionId);
  const dayOfWeek = getCurrentDayString();

  const answerSheet = doc.sheetsByTitle['Answers'];
  await answerSheet.addRow({
    AnswerID: 'A' + new Date().getTime(), userId: userId, week: user.currentWeek,
    theme: user.currentTheme, day: dayOfWeek, questionId: question ? question.questionId : 'N/A',
    question: question ? question.question : 'N/A', answer: answer,
    skipped: false, timestamp: new Date()
  });

  const userRow = (await userSheet.getRows()).find(row => row.get('userId') === userId);
  if (userRow) {
    userRow.set('noResponseWeek', 0);
    userRow.set('lastQuestionId', '');
    await userRow.save();
  }
}

// --- 6. 定時任務完整邏輯 ---

async function sendMondayThemeSelection() {
  const userSheet = doc.sheetsByTitle['Users'];
  const rows = await userSheet.getRows();
  const mondayMsg = await getMessage('MONDAY_WEEK1');
  if (!mondayMsg) { console.error("Message 'MONDAY_WEEK1' not found."); return; }

  let totalUsers = rows.length;
  let sentCount = 0;
  let skippedCount = 0;
  let errorCount = 0;
  let results = [];

  for (const row of rows) {
    const userId = row.get('userId');
    const currentStatus = row.get('status');
    const currentWeek = row.get('currentWeek');
    const thisWeek = getCurrentWeekString();

    // 發送條件：waiting_monday, saturday_showed_record, 或 active 且週次不同
    const shouldSend = currentStatus === 'waiting_monday'
                    || currentStatus === 'saturday_showed_record'
                    || (currentStatus === 'active' && currentWeek !== thisWeek);

    if (shouldSend) {
      try {
        const message = createMessageObject(mondayMsg.message, mondayMsg.buttons);
        await client.pushMessage(userId, message);

        row.set('status', 'waiting_theme');
        row.set('lastActive', new Date());
        await row.save();

        sentCount++;
        console.log(`✓ Sent Monday theme selection to user ${userId} (was: ${currentStatus})`);
        results.push(`User ${userId}: Sent (was: ${currentStatus})`);
      } catch (error) {
        errorCount++;
        console.error(`✗ Failed to send Monday theme to user ${userId}:`, error.message);
        results.push(`User ${userId}: ERROR - ${error.message}`);
      }
    } else {
      skippedCount++;
      console.log(`✗ Skipped user ${userId} - status: ${currentStatus}, week: ${currentWeek} vs ${thisWeek}`);
      results.push(`User ${userId}: Skipped (status: ${currentStatus}, week: ${currentWeek})`);
    }
  }

  const summary = {
    totalUsers,
    sentCount,
    skippedCount,
    errorCount,
    results
  };

  console.log('===== Monday Theme Selection Summary =====');
  console.log(`Total users: ${totalUsers}`);
  console.log(`Messages sent: ${sentCount}`);
  console.log(`Users skipped: ${skippedCount}`);
  console.log(`Errors: ${errorCount}`);
  if (results.length > 0) {
    console.log('Details:', results);
  }
  console.log('==========================================');

  return summary;
}

async function sendDailyQuestionForUser(userId) {
  const userSheet = doc.sheetsByTitle['Users'];
  const rows = await userSheet.getRows();
  const row = rows.find(r => r.get('userId') === userId);

  if (!row) {
    return { sent: false, reason: 'User not found' };
  }

  const dayString = getCurrentDayString();
  const status = row.get('status');
  const theme = row.get('currentTheme');

  // 檢查：如果今天已經回答過了，不要再發送
  const todayAnswered = await checkTodayAnswer(userId);
  if (todayAnswered) {
    return { sent: false, reason: 'Already answered today' };
  }

  // 檢查狀態和主題
  if (status !== 'active' && status !== 'waiting_answer') {
    return { sent: false, reason: `Status is '${status}' (not 'active' or 'waiting_answer')` };
  }

  // 檢查：如果狀態是 waiting_answer，檢查是否是今天發送的
  if (status === 'waiting_answer') {
    const lastActive = row.get('lastActive');
    if (lastActive) {
      const lastActiveDate = new Date(lastActive);
      const today = new Date();
      const isSameDay = lastActiveDate.toISOString().split('T')[0] === today.toISOString().split('T')[0];

      if (isSameDay) {
        // 今天已經發送過問題了，跳過
        return { sent: false, reason: `Already sent today (status: waiting_answer, lastActive: ${lastActiveDate.toISOString()})` };
      } else {
        // 是昨天或更早發送的，使用者忘記回答，繼續發送今天的問題
        console.log(`User ${userId} didn't answer yesterday's question, sending today's question anyway`);
        // 允許繼續發送
      }
    }
  }

  if (!theme) {
    return { sent: false, reason: 'No theme set' };
  }

  const question = await getQuestion(theme, dayString);
  if (!question) {
    return { sent: false, reason: `No question found for theme=${theme}, day=${dayString}` };
  }

  // 發送問題
  let messageText = '';
  const themeChinese = THEME_MAP[theme] || theme;

  const today = new Date().getDay();
  if (today !== 1) { // 週一不檢查昨天
    const yesterdayAnswered = await checkYesterdayAnswer(userId);
    if (!yesterdayAnswered) {
      const skipMsg = await getMessage('SKIP_YESTERDAY');
      if (skipMsg) messageText += skipMsg.message + '\n\n';
    }
  }

  const dailyMsg = await getMessage('DAILY_QUESTION');
  if (dailyMsg) {
    messageText += dailyMsg.message.replace('【主題】', themeChinese).replace('【從問題庫隨機抽取】', question.question);
  } else {
    messageText += `關於 ${themeChinese}：\n\n${question.question}`;
  }

  try {
    await client.pushMessage(userId, { type: 'text', text: messageText });

    const oldStatus = row.get('status');
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] sendDailyQuestionForUser: Status change for user ${userId}: ${oldStatus} -> waiting_answer`);

    row.set('status', 'waiting_answer');
    row.set('lastQuestionId', question.questionId);
    row.set('lastActive', new Date());
    await row.save();

    return { sent: true, reason: 'Success' };
  } catch (error) {
    console.error(`Error sending daily question to user ${userId}:`, error);
    return { sent: false, reason: `Failed to send message: ${error.message}` };
  }
}

async function sendDailyQuestion() {
  const userSheet = doc.sheetsByTitle['Users'];
  const rows = await userSheet.getRows();

  let totalUsers = rows.length;
  let sentCount = 0;
  let skippedCount = 0;
  let skippedReasons = [];

  for (const row of rows) {
    const userId = row.get('userId');
    const result = await sendDailyQuestionForUser(userId);

    if (result.sent) {
      sentCount++;
      console.log(`✓ Sent question to user ${userId}`);
    } else {
      skippedCount++;
      const reason = `User ${userId}: ${result.reason}`;
      skippedReasons.push(reason);
      console.log(`✗ Skipped user ${userId} - ${result.reason}`);
    }
  }

  const summary = {
    totalUsers,
    sentCount,
    skippedCount,
    skippedReasons
  };

  console.log('===== Daily Question Summary =====');
  console.log(`Total users: ${totalUsers}`);
  console.log(`Messages sent: ${sentCount}`);
  console.log(`Users skipped: ${skippedCount}`);
  if (skippedReasons.length > 0) {
    console.log('Skip reasons:', skippedReasons);
  }
  console.log('==================================');

  return summary;
}

async function sendSaturdayReview() {
  const userSheet = doc.sheetsByTitle['Users'];
  const rows = await userSheet.getRows();

  for (const row of rows) {
    const status = row.get('status');
    const theme = row.get('currentTheme');
    const userId = row.get('userId');
    const currentWeek = row.get('currentWeek');
    let noResponseWeek = Number(row.get('noResponseWeek')) || 0;

    if ((status === 'active' || status === 'waiting_answer') && theme) {
      try {
        const responseDays = await countWeeklyResponses(userId, currentWeek);
        const messageId = responseDays === 0 ? 'SATURDAY_NO_RESPONSE' : 'SATURDAY_START';
        const saturdayMsg = await getMessage(messageId);

        if (saturdayMsg) {
          const themeChinese = THEME_MAP[theme] || theme;
          let messageText = saturdayMsg.message.replace('【主題】', themeChinese);
          const message = createMessageObject(messageText, responseDays > 0 ? saturdayMsg.buttons : null);
          await client.pushMessage(userId, message);
        }

        row.set('noResponseWeek', responseDays === 0 ? noResponseWeek + 1 : 0);
        await row.save();
      } catch (error) {
        console.error(`Error sending Saturday review to user ${userId}:`, error);
        // 繼續處理下一個用戶，不要因為一個用戶失敗而停止整個流程
      }
    }
  }
}

async function sendMonthlyReview() {
  try {
    const userSheet = doc.sheetsByTitle['Users'];
    const insightsSheet = doc.sheetsByTitle['MonthlyInsights'];

    if (!insightsSheet) {
      console.error('MonthlyInsights sheet not found in spreadsheet');
      // 不要 throw，而是返回錯誤，避免導致未處理的異常
      console.error('Skipping monthly review due to missing MonthlyInsights sheet');
      return;
    }

    const allUsers = await userSheet.getRows();
    console.log(`Found ${allUsers.length} users to check`);

    let sentCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    for (const userRow of allUsers) {
      const userId = userRow.get('userId');

      try {
        const hasEnoughData = await hasEnoughMonthlyData(userId);

        if (hasEnoughData) {
          console.log(`Generating monthly insight for user ${userId}`);
          const insightText = await generateMonthlyAiInsight(userId);

          // 發送給使用者
          await client.pushMessage(userId, { type: 'text', text: insightText });

          // 保存到 MonthlyInsights Sheet
          const now = new Date();
          const monthString = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
          await insightsSheet.addRow({
            InsightID: 'I' + now.getTime(),
            UserID: userId,
            Month: monthString,
            AIInsight: insightText,
            CreatedAt: now
          });

          sentCount++;
          console.log(`✓ Saved monthly insight for user ${userId} to MonthlyInsights sheet (Month: ${monthString})`);
        } else {
          skippedCount++;
          console.log(`Skipping monthly insight for user ${userId}, not enough data.`);
        }
      } catch (error) {
        errorCount++;
        console.error(`Error processing user ${userId}:`, error.message);
        console.error('Error stack:', error.stack);
      }
    }

    console.log(`Monthly review summary: ${sentCount} sent, ${skippedCount} skipped, ${errorCount} errors`);
  } catch (error) {
    console.error('Critical error in sendMonthlyReview:', error);
    console.error('Error stack:', error.stack);
    // 不要 throw，避免導致未處理的異常
  }
}

// --- 7. 輔助工具函式 ---

async function checkYesterdayAnswer(userId) {
  const answerSheet = doc.sheetsByTitle['Answers'];
  const rows = await answerSheet.getRows();

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayString = yesterday.toISOString().split('T')[0];

  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.get('userId') === userId) {
      const answerDate = new Date(row.get('timestamp'));
      const answerDateString = answerDate.toISOString().split('T')[0];
      if (answerDateString === yesterdayString) {
        return true;
      }
      if (answerDate < yesterday) {
        return false;
      }
    }
  }
  return false;
}

async function checkTodayAnswer(userId) {
  const answerSheet = doc.sheetsByTitle['Answers'];
  const rows = await answerSheet.getRows();

  const today = new Date();
  const todayString = today.toISOString().split('T')[0];

  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.get('userId') === userId) {
      const answerDate = new Date(row.get('timestamp'));
      const answerDateString = answerDate.toISOString().split('T')[0];
      if (answerDateString === todayString) {
        return true;
      }
    }
  }
  return false;
}

async function hasEnoughMonthlyData(userId) {
  const answerSheet = doc.sheetsByTitle['Answers'];
  const allAnswers = await answerSheet.getRows();
  const now = new Date();
  const currentMonth = now.getMonth();
  const currentYear = now.getFullYear();

  const monthlyAnswers = allAnswers.filter(row => {
    if (row.get('userId') !== userId) return false;
    const answerDate = new Date(row.get('timestamp'));
    return answerDate.getMonth() === currentMonth && answerDate.getFullYear() === currentYear;
  });

  if (monthlyAnswers.length === 0) return false;
  const uniqueWeeks = new Set(monthlyAnswers.map(row => row.get('week')));
  // 至少要有兩週以上的內容才產生 AI 總結
  return uniqueWeeks.size >= 2;
}

async function getWeeklyAnswerRows(userId) {
  const userSheet = doc.sheetsByTitle['Users'];
  const answerSheet = doc.sheetsByTitle['Answers'];
  const users = await userSheet.getRows();
  const user = users.find(row => row.get('userId') === userId);
  if (!user) return [];
  const currentWeek = user.get('currentWeek');
  const answers = await answerSheet.getRows();
  return answers.filter(row => row.get('userId') === userId && row.get('week') === currentWeek);
}

async function getWeeklyRecords(userId) {
  const weeklyAnswers = await getWeeklyAnswerRows(userId);
  if (weeklyAnswers.length === 0) {
    const msg = await getMessage('NO_WEEKLY_RECORDS');
    const fallbackMsg = await getMessage('GENERIC_ERROR');
    return msg ? msg.message : (fallbackMsg ? fallbackMsg.message : "看來這週你沒有留下任何紀錄喔！");
  }

  const responseDays = new Set(weeklyAnswers.map(row => row.get('day'))).size;

  const dayMap = { 'MON': '週一', 'TUE': '週二', 'WED': '週三', 'THU': '週四', 'FRI': '週五' };
  let formattedRecords = '';
  weeklyAnswers.forEach(row => {
    const day = dayMap[row.get('day')] || row.get('day');
    formattedRecords += `【${day}】\n`;
    formattedRecords += `問：${row.get('question')}\n`;
    formattedRecords += `答：${row.get('answer')}\n\n`;
  });
  const recordHeader = await getMessage('SATURDAY_SHOW_RECORD');
  let headerText = '';
  if (recordHeader) {
    headerText = recordHeader.message.replace('X', responseDays) + '\n\n---\n\n';
  } else {
    const fallbackHeader = await getMessage('RECORDS_HEADER_FALLBACK');
    headerText = fallbackHeader ? fallbackHeader.message + '\n\n' : '這週的紀錄：\n\n';
  }
  return headerText + formattedRecords.trim();
}

async function generateAiInsight(userId) {
  const weeklyAnswers = await getWeeklyAnswerRows(userId);
  if (weeklyAnswers.length === 0) {
    const msg = await getMessage('NO_WEEKLY_RECORDS');
    const fallbackMsg = await getMessage('GENERIC_ERROR');
    return msg ? msg.message : "AI 沒有材料可以分析喔！";
  }
  const theme = weeklyAnswers[0].get('theme');
  let promptText = `這是我這週關於「${THEME_MAP[theme] || theme}」主題的紀錄：\n\n`;
  weeklyAnswers.forEach(row => {
    promptText += `問題：${row.get('question')}\n`;
    promptText += `我的回答：${row.get('answer')}\n---\n`;
  });

  const systemPromptMsg = await getMessage('WEEKLY_AI_PROMPT');
  const systemPrompt = systemPromptMsg ? systemPromptMsg.message : "你是一個溫暖的夥伴，請總結使用者的紀錄。";

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { "role": "system", "content": systemPrompt },
        { "role": "user", "content": promptText }
      ],
    });
    const aiResponse = completion.choices[0].message.content;
    // AI 總結功能已簡化，不再使用 SUNDAY_AI_INSIGHT_PREFIX/SUFFIX
    return aiResponse;
  } catch (error) {
    console.error("Error calling OpenAI API:", error);
    const msg = await getMessage('AI_ERROR_WEEKLY');
    const fallbackMsg = await getMessage('GENERIC_ERROR');
    return msg ? msg.message : "抱歉，AI 總結功能暫時出了點問題。";
  }
}

async function generateMonthlyAiInsight(userId) {
  const answerSheet = doc.sheetsByTitle['Answers'];
  const allAnswers = await answerSheet.getRows();
  const now = new Date();
  const currentMonth = now.getMonth();
  const currentYear = now.getFullYear();

  const monthlyAnswers = allAnswers.filter(row => {
    if (row.get('userId') !== userId) return false;
    const answerDate = new Date(row.get('timestamp'));
    return answerDate.getMonth() === currentMonth && answerDate.getFullYear() === currentYear;
  });

  if (monthlyAnswers.length === 0) {
    const msg = await getMessage('NO_MONTHLY_RECORDS');
    const fallbackMsg = await getMessage('GENERIC_ERROR');
    return msg ? msg.message : "這個月沒有紀錄可以分析。";
  }

  let promptText = '這是我這個月的紀錄，請幫我總結：\n\n';
  const weeklyData = {};
  monthlyAnswers.forEach(row => {
    const week = row.get('week');
    if (!weeklyData[week]) {
      weeklyData[week] = `--- ${week} ---\n`;
    }
    weeklyData[week] += `問題：${row.get('question')}\n`;
    weeklyData[week] += `我的回答：${row.get('answer')}\n`;
  });
  promptText += Object.values(weeklyData).join('\n');

  const systemPromptMsg = await getMessage('MONTHLY_AI_PROMPT');
  const systemPrompt = systemPromptMsg ? systemPromptMsg.message : "你是一個溫暖的夥伴，請總結使用者的紀錄。";

  try {
    console.log('Calling OpenAI API for monthly insight...');
    console.log(`Prompt length: ${promptText.length} characters`);

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { "role": "system", "content": systemPrompt },
        { "role": "user", "content": promptText }
      ],
    });

    console.log('OpenAI API call successful');
    return completion.choices[0].message.content;
  } catch (error) {
    console.error("Error calling OpenAI API for monthly insight:");
    console.error("Error name:", error.name);
    console.error("Error message:", error.message);
    console.error("Error status:", error.status);
    console.error("Full error:", JSON.stringify(error, null, 2));

    const msg = await getMessage('AI_ERROR_MONTHLY');
    const fallbackMsg = await getMessage('GENERIC_ERROR');
    return msg ? msg.message : "抱歉，月份 AI 總結功能暫時出了點問題。";
  }
}

async function countWeeklyResponses(userId, week) {
  const answerSheet = doc.sheetsByTitle['Answers'];
  const rows = await answerSheet.getRows();
  let count = 0;
  for (const row of rows) {
    if (row.get('userId') === userId && row.get('week') === week && (row.get('skipped') === 'FALSE' || row.get('skipped') === false)) {
      count++;
    }
  }
  return count;
}

function getCurrentWeekString() {
  const now = new Date();
  const year = now.getFullYear();
  const weekNum = getWeekNumber(now);
  return year + '-W' + (weekNum < 10 ? '0' + weekNum : weekNum);
}

function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function getCurrentDayString() {
  const dayMap = { 0: 'SUN', 1: 'MON', 2: 'TUE', 3: 'WED', 4: 'THU', 5: 'FRI', 6: 'SAT' };
  return dayMap[new Date().getDay()] || '';
}

// --- 8. 伺服器啟動 ---
const port = process.env.PORT || 3000;

// 啟動前檢查關鍵環境變數
const requiredEnvVars = ['CHANNEL_ACCESS_TOKEN', 'CHANNEL_SECRET', 'GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_PRIVATE_KEY'];
const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingEnvVars.length > 0) {
  console.warn('WARNING: Missing environment variables:', missingEnvVars.join(', '));
  console.warn('Service may not function correctly without these variables.');
}

app.listen(port, '0.0.0.0', () => {
  console.log(`========================================`);
  console.log(`隙音 LINE Bot 服務已啟動`);
  console.log(`Port: ${port}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Start Time: ${new Date().toISOString()}`);
  console.log(`Node Version: ${process.version}`);
  const memUsage = process.memoryUsage();
  console.log(`Memory: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB / ${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`);
  console.log(`========================================`);
}).on('error', (err) => {
  console.error('========================================');
  console.error('CRITICAL: Failed to start server!');
  console.error('Time:', new Date().toISOString());
  console.error('Error:', err);
  console.error('Stack:', err.stack);
  console.error('========================================');
  // 只有在啟動失敗時才退出，這是合理的
  process.exit(1);
});

// 定期記錄服務狀態（每小時一次），幫助診斷問題
setInterval(() => {
  const memUsage = process.memoryUsage();
  console.log(`[${new Date().toISOString()}] Service Status Check:`);
  console.log(`  Uptime: ${Math.round(process.uptime())}s (${Math.round(process.uptime() / 3600)}h)`);
  console.log(`  Memory: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB / ${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`);
  console.log(`  RSS: ${Math.round(memUsage.rss / 1024 / 1024)}MB`);
}, 3600000); // 每小時記錄一次
