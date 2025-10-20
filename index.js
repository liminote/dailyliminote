// ========================================
// 隙音 LINE Bot - Render (V3.2 - 修正週末按鈕邏輯版)
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

const serviceAccountAuth = new JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const SPREADSHEET_ID = '1TMyXHW2BaYJ3l8p1EdCQfb9Vhx_fJUrAZAEVOSBiom0'; // ⚠️ 請確認這是你正確的 Google Sheet ID
const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);

const client = new line.Client(lineConfig);
const app = express();

// --- 2. Webhook & 測試路徑 ---

app.get('/', (req, res) => {
  res.status(200).send('OK');
});

app.get('/test-saturday-review', async (req, res) => {
  console.log('手動觸發週六回顧');
  try {
    await doc.loadInfo();
    await sendSaturdayReview();
    res.status(200).send('週六回顧任務已觸發');
  } catch (err) {
    console.error('手動觸發週六回顧時發生錯誤:', err);
    res.status(500).send('觸發失敗，請檢查 Logs');
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

cron.schedule('0 9 * * 2-5', async () => {
  console.log('Running: sendDailyQuestion @ 9:00 AM Taipei Time');
  try {
    await doc.loadInfo();
    await sendDailyQuestion();
  } catch (err) {
    console.error('Error in sendDailyQuestion cron job:', err);
  }
}, { timezone: "Asia/Taipei" });

cron.schedule('0 20 * * 6', async () => {
  console.log('Running: sendSaturdayReview @ 8:00 PM Taipei Time');
   try {
    await doc.loadInfo();
    await sendSaturdayReview();
  } catch (err) {
    console.error('Error in sendSaturdayReview cron job:', err);
  }
}, { timezone: "Asia/Taipei" });

cron.schedule('0 22 * * *', async () => {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  if (tomorrow.getDate() === 1) {
    console.log('Running: sendMonthlyReview @ 10:00 PM on Last Day of Month');
    try {
      await doc.loadInfo();
      await sendMonthlyReview();
    } catch (err) {
      console.error('Error in sendMonthlyReview cron job:', err);
    }
  }
}, { timezone: "Asia/Taipei" });


// --- 4. 核心程式碼邏輯 ---

const THEME_MAP = { 'SELF': '自己', 'CREATION': '創作', 'FAMILY': '家庭' };

async function replyWithText(replyToken, messageId, fallbackId = 'GENERIC_ERROR') {
    let msg = await getMessage(messageId);
    if (!msg) {
        msg = await getMessage(fallbackId);
    }
    await client.replyMessage(replyToken, { type: 'text', text: msg ? msg.message : '系統發生錯誤' });
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
      await sendDailyQuestionForUser(userId);
      // No reply needed here as it's a push message
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
      break;

    case 'get_insight':
      await client.replyMessage(replyToken, { type: 'text', text: '好的，正在為您產生 AI 總結，請稍候幾秒鐘...' });
      const insightText = await generateAiInsight(userId);
      await client.pushMessage(userId, { type: 'text', text: insightText });
      break;
  }
}

// [邏輯修改] 只有週一到週五才顯示「開始回答」按鈕
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

  // 判斷今天是否為週一到週五
  const today = new Date().getDay(); // 0 = Sun, 1 = Mon, ..., 6 = Sat
  let buttons = null;
  if (today >= 1 && today <= 5) { // 如果是週一到週五
    buttons = [{"label":"開始回答今天問題","data":"action=start_question"}];
  } else {
    // 如果是週六或週日，可以考慮加上提示文字
    text += '\n\n問題將從下週一開始。';
  }

  const message = createMessageObject(text, buttons);
  await client.replyMessage(replyToken, message);
}


async function sendWelcomeMessage(replyToken, userId) {
  const today = new Date().getDay();
  // 週日加入也視為非週一
  const messageId = (today === 1) ? 'WELCOME_MONDAY' : 'WELCOME_OTHER_DAY';
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
  if(userRow){
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

  for (const row of rows) {
    const currentStatus = row.get('status');
    const currentWeek = row.get('currentWeek');
    const thisWeek = getCurrentWeekString(); 

    if (currentStatus === 'waiting_monday' || (currentStatus === 'active' && currentWeek !== thisWeek)) {
      const userId = row.get('userId');
      const message = createMessageObject(mondayMsg.message, mondayMsg.buttons);
      await client.pushMessage(userId, message);
      row.set('status', 'waiting_theme'); 
      row.set('lastActive', new Date());
      await row.save();
    }
  }
}

async function sendDailyQuestionForUser(userId) {
    const userSheet = doc.sheetsByTitle['Users'];
    const rows = await userSheet.getRows();
    const row = rows.find(r => r.get('userId') === userId);
    
    if (!row) return;

    const dayString = getCurrentDayString();
    const status = row.get('status');
    const theme = row.get('currentTheme');

    if (status === 'active' && theme) {
      const question = await getQuestion(theme, dayString);
      if (question) {
        let messageText = '';
        const themeChinese = THEME_MAP[theme] || theme;
        
        const today = new Date().getDay();
        if (today !== 1) { // 週一不檢查昨天
            const yesterdayAnswered = await checkYesterdayAnswer(userId);
            if (!yesterdayAnswered) { 
              const skipMsg = await getMessage('SKIP_YESTERDAY');
              if(skipMsg) messageText += skipMsg.message + '\n\n';
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
        row.set('lastQuestionId', question.questionId);
        row.set('lastActive', new Date());
        await row.save();
      } else {
        console.log(`找不到問題: 主題=${theme}, 天=${dayString}, 未發送給用戶 ${userId}`);
      }
    }
}

async function sendDailyQuestion() {
  const userSheet = doc.sheetsByTitle['Users'];
  const rows = await userSheet.getRows();
  for (const row of rows) {
    await sendDailyQuestionForUser(row.get('userId'));
  }
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
    }
  }
}

async function sendMonthlyReview() {
  const userSheet = doc.sheetsByTitle['Users'];
  const allUsers = await userSheet.getRows();

  for (const userRow of allUsers) {
    const userId = userRow.get('userId');
    const hasEnoughData = await hasEnoughMonthlyData(userId);
    
    if (hasEnoughData) {
      console.log(`Generating monthly insight for user ${userId}`);
      const insightText = await generateMonthlyAiInsight(userId);
      await client.pushMessage(userId, { type: 'text', text: insightText });
    } else {
      console.log(`Skipping monthly insight for user ${userId}, not enough data.`);
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

async function hasEnoughMonthlyData(userId) {
  const answerSheet = doc.sheetsByTitle['Answers'];
  const allAnswers = await answerSheet.getRows();
  const currentMonth = new Date().getMonth();

  const monthlyAnswers = allAnswers.filter(row => {
    if (row.get('userId') !== userId) return false;
    const answerDate = new Date(row.get('timestamp'));
    return answerDate.getMonth() === currentMonth;
  });

  if (monthlyAnswers.length === 0) return false;
  const uniqueWeeks = new Set(monthlyAnswers.map(row => row.get('week')));
  return uniqueWeeks.size > 1;
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
    const prefixMsg = await getMessage('SUNDAY_AI_INSIGHT_PREFIX'); // Keep these MessageIDs for now
    const suffixMsg = await getMessage('SUNDAY_AI_INSIGHT_SUFFIX');
    let finalText = '';
    if (prefixMsg) finalText += prefixMsg.message + '\n\n';
    finalText += aiResponse;
    if (suffixMsg) finalText += '\n\n' + suffixMsg.message;
    return finalText;
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
  const currentMonth = new Date().getMonth();

  const monthlyAnswers = allAnswers.filter(row => {
    if (row.get('userId') !== userId) return false;
    const answerDate = new Date(row.get('timestamp'));
    return answerDate.getMonth() === currentMonth;
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
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { "role": "system", "content": systemPrompt },
        { "role": "user", "content": promptText }
      ],
    });
    return completion.choices[0].message.content;
  } catch (error) {
    console.error("Error calling OpenAI API for monthly insight:", error);
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
app.listen(port, () => {
  console.log(`listening on ${port}`);
});
