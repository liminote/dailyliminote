// ========================================
// 隙音 LINE Bot - Render (AI 功能完整版)
// ========================================
const express = require('express');
const line = require('@line/bot-sdk');
const cron = require('node-cron');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const OpenAI = require('openai'); // [新增] 引入 OpenAI 工具

// --- 1. 初始化設定 ---

const lineConfig = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const serviceAccountAuth = new JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// [新增] 初始化 OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const SPREADSHEET_ID = '1TMyXHW2BaYJ3l8p1EdCQfb9Vhx_fJUrAZAEVOSBiom0'; // ⚠️ 請確認這是你正確的 Google Sheet ID
const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);

const client = new line.Client(lineConfig);
const app = express();

// --- 2. Webhook 進入點 ---

app.get('/', (req, res) => {
  res.status(200).send('OK');
});

// [測試用] 建立一個秘密的 GET 請求路徑，用來手動觸發週日回顧
app.get('/test-sunday-review', async (req, res) => {
  console.log('手動觸發週日回顧 (Manual trigger for Sunday review)');
  try {
    await doc.loadInfo();
    await sendSundayReview(); // 呼叫我們想要測試的函式
    res.status(200).send('週日回顧任務已觸發，請檢查你的 LINE 和 Render Logs。');
  } catch (err) {
    console.error('手動觸發週日回顧時發生錯誤:', err);
    res.status(500).send('觸發失敗，請檢查 Render Logs 中的錯誤訊息。');
  }
});

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
  try {
    await doc.loadInfo(); 
    if (event.type === 'message' && event.message.type === 'text') {
      await handleTextMessage(event);
    } else if (event.type === 'postback') {
      await handlePostback(event);
    }
  } catch (err) {
    console.error('Error in handleEvent:', err);
  }
  return Promise.resolve(null);
}

// --- 3. 定時任務排程 ---

cron.schedule('0 9 * * 1', async () => {
  console.log('Running: sendMondayThemeSelection @ 9:00 AM Taipei Time');
  try {
    await doc.loadInfo();
    await sendMondayThemeSelection();
  } catch (err) {
    console.error('Error in sendMondayThemeSelection cron job:', err);
  }
}, { timezone: "Asia/Taipei" });

cron.schedule('0 9 * * 2-6', async () => {
  console.log('Running: sendDailyQuestion @ 9:00 AM Taipei Time');
  try {
    await doc.loadInfo();
    await sendDailyQuestion();
  } catch (err) {
    console.error('Error in sendDailyQuestion cron job:', err);
  }
}, { timezone: "Asia/Taipei" });

cron.schedule('0 20 * * 0', async () => {
  console.log('Running: sendSundayReview @ 8:00 PM Taipei Time');
   try {
    await doc.loadInfo();
    await sendSundayReview();
  } catch (err) {
    console.error('Error in sendSundayReview cron job:', err);
  }
}, { timezone: "Asia/Taipei" });


// --- 4. 核心程式碼邏輯 ---

const THEME_MAP = { 'SELF': '自己', 'CREATION': '創作', 'FAMILY': '家庭' };

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
    const msg = await getMessage('PROMPT_THEME_CHOICE');
    await client.replyMessage(replyToken, { type: 'text', text: msg ? msg.message : '請點選上方按鈕選擇你想探索的主題 😊' });
  } else if (user.status === 'waiting_answer') {
    await saveUserAnswer(userId, event.message.text);
    const heardMsg = await getMessage('HEARD');
    await client.replyMessage(replyToken, { type: 'text', text: heardMsg ? heardMsg.message : '聽到了。' });
    await updateUserStatus(userId, 'active');
  } else if (user.status === 'active') {
    const msg = await getMessage('ACK_ACTIVE');
    await client.replyMessage(replyToken, { type: 'text', text: msg ? msg.message : '好的，我們明天早上 9 點見！🌱' });
  } else {
    const msg = await getMessage('FALLBACK_GENERAL');
    await client.replyMessage(replyToken, { type: 'text', text: msg ? msg.message : '我好像有點不太明白…' });
  }
}

async function handlePostback(event) {
  const userId = event.source.userId;
  const data = event.postback.data;
  const replyToken = event.replyToken;
  const params = {};
  data.split('&').forEach(pair => { const [key, value] = pair.split('='); params[key] = decodeURIComponent(value); });

  if (params.action === 'start_now') {
    const startMsg = await getMessage('START_READY');
    const message = createMessageObject(startMsg ? startMsg.message : '收到。接下來會問你，這週想關注什麼主題。', startMsg ? startMsg.buttons : null);
    await client.replyMessage(replyToken, message);
    await updateUserStatus(userId, 'waiting_theme');
  } else if (params.action === 'ready') {
    const themeSelectMsg = await getMessage('THEME_SELECT');
    if (themeSelectMsg) {
      const message = createMessageObject(themeSelectMsg.message, themeSelectMsg.buttons);
      await client.replyMessage(replyToken, message);
    } else {
      await client.replyMessage(replyToken, { type: 'text', text: '好的，你想選擇什麼主題呢？' });
    }
  } else if (params.action === 'select_theme') {
    await handleThemeSelection(replyToken, userId, params.theme);
  } else if (params.action === 'start_week') {
    const startMsg = await getMessage('START_READY');
    const message = createMessageObject(startMsg ? startMsg.message : '收到。接下來會問你，這週想關注什麼主題。', startMsg ? startMsg.buttons : null);
    await client.replyMessage(replyToken, message);
    await updateUserStatus(userId, 'waiting_theme');
  } else if (params.action === 'how_to_play') {
    const howToMsg = await getMessage('HOW_TO_PLAY');
    await client.replyMessage(replyToken, { type: 'text', text: howToMsg ? howToMsg.message : '每週流程...' });
  } else if (params.action === 'later') {
    const laterMsg = await getMessage('LATER');
    await client.replyMessage(replyToken, { type: 'text', text: laterMsg ? laterMsg.message : '好的。當你準備好，隨時可以回來。' });
    await updateUserStatus(userId, 'waiting_monday');
  } else if (params.action === 'show_record') {
    const recordsText = await getWeeklyRecords(userId);
    await client.replyMessage(replyToken, { type: 'text', text: recordsText });
  } else if (params.action === 'get_insight') {
    await client.replyMessage(replyToken, { type: 'text', text: '好的，正在為您產生 AI 總結，請稍候幾秒鐘...' });
    const insightText = await generateAiInsight(userId);
    await client.pushMessage(userId, { type: 'text', text: insightText });
  }
}

async function handleThemeSelection(replyToken, userId, theme) {
  await saveUserTheme(userId, theme);
  const messageId = 'CONFIRM_' + theme;
  const confirmMsg = await getMessage(messageId);
  if (confirmMsg) {
    await client.replyMessage(replyToken, { type: 'text', text: confirmMsg.message });
  } else {
    const themeChinese = THEME_MAP[theme] || '這個主題';
    await client.replyMessage(replyToken, { type: 'text', text: `收到。\n\n這週，我們一起關注「${themeChinese}」。` });
  }
}

async function sendWelcomeMessage(replyToken, userId) {
  const userSheet = doc.sheetsByTitle['Users'];
  const today = new Date().getDay();
  const messageId = (today === 1) ? 'WELCOME_MONDAY' : 'WELCOME_OTHER_DAY';
  const welcomeMsg = await getMessage(messageId);
  if (welcomeMsg) {
    const message = createMessageObject(welcomeMsg.message, welcomeMsg.buttons);
    await client.replyMessage(replyToken, message);
    const status = (today === 1) ? 'waiting_theme' : 'waiting_monday';
    await updateUserStatus(userId, status);
  } else {
    await client.replyMessage(replyToken, { type: 'text', text: '你好！歡迎來到「隙音」。' });
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
  if(userRow){
    userRow.set('status', status);
    userRow.set('lastActive', new Date());
    await userRow.save();
  }
}

async function saveUserTheme(userId, theme) {
  const userSheet = doc.sheetsByTitle['Users'];
  const rows = await userSheet.getRows();
  const userRow = rows.find(row => row.get('userId') === userId);
  if(userRow){
    userRow.set('status', 'active');
    userRow.set('currentTheme', theme);
    userRow.set('currentWeek', getCurrentWeekString());
    userRow.set('lastActive', new Date());
    await userRow.save();
  }
}

async function getMessage(messageId) {
  const messageSheet = doc.sheetsByTitle['Messages'];
  const rows = await messageSheet.getRows();
  const row = rows.find(r => r.get('MessageID') === messageId && (r.get('Active') === 'TRUE' || r.get('Active') === true));
  if (row) {
    return {
      message: row.get('Message'),
      buttons: row.get('Buttons') ? JSON.parse(row.get('Buttons')) : null
    };
  }
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

async function saveUserAnswer(userId, answer) {
  const userSheet = doc.sheetsByTitle['Users'];
  const user = await getOrCreateUser(userId, userSheet);
  const dayOfWeek = getCurrentDayString();
  const question = await getQuestion(user.currentTheme, dayOfWeek);
  
  const answerSheet = doc.sheetsByTitle['Answers'];
  await answerSheet.addRow({
    AnswerID: 'A' + new Date().getTime(), userId: userId, week: user.currentWeek,
    theme: user.currentTheme, day: dayOfWeek, questionId: question ? question.questionId : '',
    question: question ? question.question : '', answer: answer,
    skipped: false, timestamp: new Date()
  });

  const userRow = (await userSheet.getRows()).find(row => row.get('userId') === userId);
  if(userRow){
    userRow.set('noResponseWeek', 0);
    await userRow.save();
  }
}

// --- 6. 定時任務完整邏輯 ---

async function sendMondayThemeSelection() {
  const userSheet = doc.sheetsByTitle['Users'];
  const rows = await userSheet.getRows();
  const mondayMsg = await getMessage('MONDAY_WEEK1');
  if (!mondayMsg) { console.error("Message 'MONDAY_WEEK1' not found."); return; }

  for (const row of rows) {
    if (row.get('status') === 'active' || row.get('status') === 'waiting_monday') {
      const userId = row.get('userId');
      const message = createMessageObject(mondayMsg.message, mondayMsg.buttons);
      await client.pushMessage(userId, message);
      row.set('status', 'waiting_theme');
      row.set('lastActive', new Date());
      await row.save();
    }
  }
}

async function sendDailyQuestion() {
  const dayString = getCurrentDayString();
  const userSheet = doc.sheetsByTitle['Users'];
  const rows = await userSheet.getRows();
  
  for (const row of rows) {
    const status = row.get('status');
    const theme = row.get('currentTheme');
    const userId = row.get('userId');

    if (status === 'active' && theme) {
      const question = await getQuestion(theme, dayString);
      if (question) {
        let messageText = '';
        const themeChinese = THEME_MAP[theme] || theme;
        
        const yesterdayAnswered = await checkYesterdayAnswer(userId);
        const today = new Date().getDay();
        if (!yesterdayAnswered && today > 2) { 
          const skipMsg = await getMessage('SKIP_YESTERDAY');
          if(skipMsg) {
            messageText += skipMsg.message + '\n\n';
          }
        }
        
        const dailyMsg = await getMessage('DAILY_QUESTION');
        if (dailyMsg) {
          messageText += dailyMsg.message.replace('【主題】', themeChinese).replace('【從問題庫隨機抽取】', question.question);
        } else {
          messageText += `關於 ${themeChinese}：\n\n${question.question}`;
        }
        
        await client.pushMessage(userId, { type: 'text', text: messageText });
        row.set('status', 'waiting_answer');
        row.set('lastActive', new Date());
        await row.save();
      } else {
        console.log(`找不到問題: 主題=${theme}, 天=${dayString}, 未發送給用戶 ${userId}`);
      }
    }
  }
}

async function sendSundayReview() {
  const userSheet = doc.sheetsByTitle['Users'];
  const rows = await userSheet.getRows();
  
  for (const row of rows) {
    const status = row.get('status');
    const theme = row.get('currentTheme');
    const userId = row.get('userId');
    const currentWeek = row.get('currentWeek');
    let noResponseWeek = Number(row.get('noResponseWeek')) || 0;

    if ((status === 'active' || status === 'waiting_answer') && theme) {
      const responseDays = await countWeeklyResponses(userId, currentWeek);
      const messageId = responseDays === 0 ? 'SUNDAY_NO_RESPONSE' : 'SUNDAY_START';
      const sundayMsg = await getMessage(messageId);
      
      if (sundayMsg) {
        const themeChinese = THEME_MAP[theme] || theme;
        let messageText = sundayMsg.message.replace('【主題】', themeChinese);
        const message = createMessageObject(messageText, responseDays > 0 ? sundayMsg.buttons : null);
        await client.pushMessage(userId, message);
      }
      
      row.set('noResponseWeek', responseDays === 0 ? noResponseWeek + 1 : 0);
      await row.save();
    }
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
    return '看來這週你沒有留下任何紀錄喔！沒關係，下週我們再一起努力。';
  }
  const dayMap = { 'TUE': '週二', 'WED': '週三', 'THU': '週四', 'FRI': '週五', 'SAT': '週六' };
  let formattedRecords = '';
  weeklyAnswers.forEach(row => {
    const day = dayMap[row.get('day')] || row.get('day');
    formattedRecords += `【${day}】\n`;
    formattedRecords += `問：${row.get('question')}\n`;
    formattedRecords += `答：${row.get('answer')}\n\n`;
  });
  const recordHeader = await getMessage('SUNDAY_SHOW_RECORD');
  const headerText = recordHeader ? recordHeader.message + '\n\n---\n\n' : '這週的紀錄：\n\n';
  return headerText + formattedRecords.trim();
}

async function generateAiInsight(userId) {
  const weeklyAnswers = await getWeeklyAnswerRows(userId);
  if (weeklyAnswers.length === 0) {
    return '看來你這週沒有留下紀錄，AI 也沒有材料可以分析喔！';
  }
  const theme = weeklyAnswers[0].get('theme');
  let promptText = `這是我這週關於「${THEME_MAP[theme] || theme}」主題的紀錄：\n\n`;
  weeklyAnswers.forEach(row => {
    promptText += `問題：${row.get('question')}\n`;
    promptText += `我的回答：${row.get('answer')}\n---\n`;
  });
  const systemPrompt = `你是一個溫暖、有洞察力的夥伴，名叫「隙音」。你的任務是總結使用者一週的紀錄，以第二人稱「你」來和使用者對話。請從紀錄中找出重複出現的主題或情緒，給予溫柔的鼓勵和觀察，但不要給予指令或建議。風格要簡潔、真誠、像朋友一樣。`;
  
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { "role": "system", "content": systemPrompt },
        { "role": "user", "content": promptText }
      ],
    });
    const aiResponse = completion.choices[0].message.content;
    const prefixMsg = await getMessage('SUNDAY_AI_INSIGHT_PREFIX');
    const suffixMsg = await getMessage('SUNDAY_AI_INSIGHT_SUFFIX');
    let finalText = '';
    if (prefixMsg) finalText += prefixMsg.message + '\n\n';
    finalText += aiResponse;
    if (suffixMsg) finalText += '\n\n' + suffixMsg.message;
    return finalText;
  } catch (error) {
    console.error("Error calling OpenAI API:", error);
    return "抱歉，AI 總結功能暫時出了點問題，請稍後再試。";
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
app.listen(port, () => {
  console.log(`listening on ${port}`);
});
