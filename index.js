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
const MANUAL_TTL_MS = 60 * 60 * 1000        // 通關後：該客人單獨人工 1 小時
const MANUAL_PING_COOLDOWN_MS = 30 * 1000   // 人工期間：同一客人推播最短間隔

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

/* ===== 文案 ===== */
const TEXT = {
  askOrder: '請提供【5 位數訂單編號】。',
  askProof: '請上傳【付款明細截圖】（圖片）。',
  done: '資料已收齊，核對中；未通知前請勿重複詢問。',
}

/* ===== 狀態 =====
state: WAIT_ORDER → WAIT_PROOF → DONE
manualUntil: 通關後自動開（單一客人）
*/
const store = new Map()
function getState(uid) {
  if (!store.has(uid)) {
    store.set(uid, {
      state: 'WAIT_ORDER',
      order: null,
      pushed: false,
      manualUntil: 0,
      _lastManualPingAt: 0,
    })
  }
  return store.get(uid)
}
function isManual(st) { return st.manualUntil && st.manualUntil > now() }
function setManual(st) { st.manualUntil = now() + MANUAL_TTL_MS }

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

      /* ===== 人工期間（單一客人）：不回客，但要推播通知給你 ===== */
      if (isManual(st)) {
        const canPing = (now() - (st._lastManualPingAt || 0)) > MANUAL_PING_COOLDOWN_MS
        if (canPing) {
          st._lastManualPingAt = now()
          const profile = await getProfile(uid)
          const name = profile?.displayName || '（未提供暱稱）'
          const brief = briefOfMessage(e)

          await push(
            ADMIN_USER_ID,
            `人工期間新訊息\n客人暱稱：${name}\n訂單：${st.order || '（未填）'}\n內容：${brief}`
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

          // ✅ 通關後：只鎖「這位客人」1 小時（bot 對他靜默，但仍會推播他後續訊息）
          setManual(st)

          const profile = await getProfile(uid)
          const name = profile?.displayName || '（未提供暱稱）'
          await push(
            ADMIN_USER_ID,
            `通關通知\n客人暱稱：${name}\n訂單編號：${st.order}\n（此客人已自動進入人工 1 小時）`
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
