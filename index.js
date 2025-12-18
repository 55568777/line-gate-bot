import express from 'express'
import crypto from 'crypto'
import fetch from 'node-fetch'

const app = express()

const {
  CHANNEL_ACCESS_TOKEN,
  CHANNEL_SECRET,
  ADMIN_USER_ID,     // 你的私人 LINE userId（U開頭32位）
  OPENAI_API_KEY,
} = process.env

app.use(express.json({ verify: verifyLine }))

/* ===== 常數 ===== */
const MANUAL_TTL_MS = 60 * 60 * 1000          // 通關後：該客人單獨人工 1 小時
const MANUAL_PING_COOLDOWN_MS = 2 * 60 * 1000 // 彙整推播：每位客人最多 2 分鐘推一次

/* ===== 驗簽 ===== */
function verifyLine(req, res, buf) {
  const sig = crypto.createHmac('sha256', CHANNEL_SECRET).update(buf).digest('base64')
  if (sig !== req.headers['x-line-signature']) throw new Error('Bad signature')
}

/* ===== 工具 ===== */
function isPureFiveDigits(t) { return /^\d{5}$/.test((t || '').trim()) }
function isValidUserId(u) { return typeof u === 'string' && /^U[0-9a-f]{32}$/i.test(u) }
function now() { return Date.now() }

function briefOfMessage(e) {
  const mt = e?.message?.type
  if (mt === 'text') return (e.message.text || '').slice(0, 80)
  if (mt === 'image') return '[圖片]'
  if (mt === 'video') return '[影片]'
  if (mt === 'audio') return '[音訊]'
  if (mt === 'file') return `[檔案] ${(e.message.fileName || '').slice(0, 40)}`
  if (mt === 'sticker') return '[貼圖]'
  return `[${mt || 'unknown'}]`
}

/* ✅ 領貨/付款/序號意圖：WAIT_ORDER 時命中就直接要 5 位數訂單（不走 GPT） */
function hasPickupIntent(t) {
  const s = (t || '').trim().toLowerCase()

  // ❌ 你指定不要攔的
  const exclude = /(等很久了|怎麼那麼久|到底好了沒|處理一下|回一下|在嗎|人呢|快一點|不回是怎樣)/i
  if (exclude.test(s)) return false

  // ✅ 要攔的（付款／領貨／序號／出貨／查單）
  const include = /(已付款|我已付款|付款了|付了|錢付了|付過了|
                    已轉帳|轉帳了|匯款了|已匯款|繳費了|已繳費|付款完成|
                    刷卡了|刷過了|有付錢|有給錢|
                    領貨|取貨|拿貨|我要領|我要拿|可以領了嗎|可以拿了嗎|
                    出貨了嗎|幾時出貨|發貨了嗎|什麼時候發|
                    寄了嗎|寄了沒|幾時寄|什麼時候到|到了沒|
                    序號呢|序號在哪|卡呢|點數呢|
                    怎麼還沒給|沒收到序號|沒發|還沒發|
                    東西呢|貨呢|
                    我都付了|什麼時候好|幫我看一下|看一下訂單|幫我查|查一下)/ix

  return include.test(s)
}

/* ===== 文案 ===== */
const TEXT = {
  askOrder: '請提供【5 位數訂單編號】。',
  askProof: '請上傳【付款明細截圖】（圖片）。',
  done: '資料已收齊，核對中；未通知前請勿重複詢問。',
}

/* ===== 狀態 ===== */
const store = new Map()
function getState(uid) {
  if (!store.has(uid)) {
    store.set(uid, {
      state: 'WAIT_ORDER',
      order: null,
      pushed: false,

      manualUntil: 0,

      // 彙整推播用
      _lastManualPingAt: 0,
      _manualBurstCount: 0,
      _manualLastBrief: '',
    })
  }
  return store.get(uid)
}

function isManual(st) { return st.manualUntil && st.manualUntil > now() }
function setManual(st) {
  st.manualUntil = now() + MANUAL_TTL_MS
  st._lastManualPingAt = 0
  st._manualBurstCount = 0
  st._manualLastBrief = ''
}

/* ===== LINE API ===== */
async function reply(replyToken, text) {
  if (!replyToken) return
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }),
  })
}

async function push(to, text) {
  if (!isValidUserId(to)) return
  await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ to, messages: [{ type: 'text', text }] }),
  })
}

async function getProfile(uid) {
  try {
    const r = await fetch(`https://api.line.me/v2/bot/profile/${uid}`, {
      headers: { Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` },
    })
    if (!r.ok) return null
    return await r.json()
  } catch { return null }
}

/* ===== GPT 客服 ===== */
async function gptReply(userText) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content:
`你是官方客服，語氣冷靜、專業、簡短。
你不能確認訂單、不能說已完成、不能說已收齊。
若提到領貨，一律指示：提供 5 位數訂單編號，再上傳付款截圖。`,
        },
        { role: 'user', content: userText },
      ],
    }),
  })
  if (!r.ok) return '客服系統暫時忙碌，請稍後再試。'
  const j = await r.json()
  return j.choices?.[0]?.message?.content || '客服系統暫時忙碌，請稍後再試。'
}

/* ===== Webhook ===== */
app.post('/webhook', async (req, res) => {
  try {
    const events = req.body?.events || []

    for (const e of events) {
      if (e.type !== 'message') continue
      if (e.source?.type !== 'user') continue

      const uid = e.source?.userId
      const msgType = e.message?.type
      const st = getState(uid)

      /* ===== 人工期間（單一客人）：不回客，但要「彙整」推播給你 ===== */
      if (isManual(st)) {
        st._manualBurstCount = (st._manualBurstCount || 0) + 1
        st._manualLastBrief = briefOfMessage(e)

        const lastAt = st._lastManualPingAt || 0
        const canPing = (now() - lastAt) > MANUAL_PING_COOLDOWN_MS

        if (canPing) {
          st._lastManualPingAt = now()

          const profile = await getProfile(uid)
          const name = profile?.displayName || '（未提供暱稱）'

          const n = st._manualBurstCount || 0
          const last = st._manualLastBrief || ''
          st._manualBurstCount = 0
          st._manualLastBrief = ''

          await push(
            ADMIN_USER_ID,
            `人工期間新訊息（彙整）\n客人暱稱：${name}\n訂單：${st.order || '（未填）'}\n本段共：${n} 則\n最後：${last}`
          )
        }
        continue
      }

      /* === 圖片：領貨流程 === */
      if (msgType === 'image') {
        if (st.state === 'WAIT_ORDER') {
          await reply(e.replyToken, TEXT.askOrder)
          continue
        }
        if (st.state === 'WAIT_PROOF' && !st.pushed) {
          st.state = 'DONE'
          st.pushed = true
          await reply(e.replyToken, TEXT.done)

          // 通關後：只鎖這位客人 1 小時
          setManual(st)

          const profile = await getProfile(uid)
          const name = profile?.displayName || '（未提供暱稱）'
          await push(
            ADMIN_USER_ID,
            `通關通知\n客人暱稱：${name}\n訂單編號：${st.order}`
          )
          continue
        }
        await reply(e.replyToken, TEXT.done)
        continue
      }

      /* === 文字 === */
      if (msgType === 'text') {
        const t = (e.message.text || '').trim()

        // 5 位數訂單 → 進 WAIT_PROOF
        if (isPureFiveDigits(t)) {
          st.order = t
          st.state = 'WAIT_PROOF'
          await reply(e.replyToken, TEXT.askProof)
          continue
        }

        // ✅ WAIT_ORDER 時命中「領貨/付款/序號」意圖 → 直接要訂單（不走 GPT）
        if (st.state === 'WAIT_ORDER' && hasPickupIntent(t)) {
          await reply(e.replyToken, TEXT.askOrder)
          continue
        }

        // 領貨流程中，不走 GPT
        if (st.state === 'WAIT_PROOF') {
          await reply(e.replyToken, TEXT.askProof)
          continue
        }
        if (st.state === 'DONE') {
          await reply(e.replyToken, TEXT.done)
          continue
        }

        // 其他 → GPT
        const ans = await gptReply(t)
        await reply(e.replyToken, ans)
      }
    }

    res.sendStatus(200)
  } catch (err) {
    console.error(err)
    res.sendStatus(500)
  }
})

app.listen(process.env.PORT || 3000, () => console.log('Your service is live'))
