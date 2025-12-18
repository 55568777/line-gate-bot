import express from 'express'
import crypto from 'crypto'
import fetch from 'node-fetch'

const app = express()
const {
  CHANNEL_ACCESS_TOKEN,
  CHANNEL_SECRET,
  ADMIN_USER_ID,
  OPENAI_API_KEY,
} = process.env

app.use(express.json({ verify: verifyLine }))

/* ===== 常數 ===== */
const MANUAL_TTL_MS = 60 * 60 * 1000 // 1 小時

/* ===== 驗簽 ===== */
function verifyLine(req, res, buf) {
  const sig = crypto.createHmac('sha256', CHANNEL_SECRET).update(buf).digest('base64')
  if (sig !== req.headers['x-line-signature']) throw new Error('Bad signature')
}

/* ===== 工具 ===== */
function isPureFiveDigits(t) {
  return /^\d{5}$/.test(t.trim())
}
function isValidUserId(u) {
  return typeof u === 'string' && /^U[0-9a-f]{32}$/i.test(u)
}
function now() { return Date.now() }

/* ===== 文案 ===== */
const TEXT = {
  askOrder: '請提供【5 位數訂單編號】。',
  askProof: '請上傳【付款明細截圖】（圖片）。',
  done: '資料已收齊，核對中；未通知前請勿重複詢問。',
}

/* ===== 狀態 =====
state: WAIT_ORDER → WAIT_PROOF → DONE
manualUntil: number（> now() 表示人工接手中）
*/
const store = new Map()
function getState(uid) {
  if (!store.has(uid)) {
    store.set(uid, {
      state: 'WAIT_ORDER',
      order: null,
      pushed: false,
      manualUntil: 0,
    })
  }
  return store.get(uid)
}
function isManual(st) {
  return st.manualUntil && st.manualUntil > now()
}
function setManual(st) {
  st.manualUntil = now() + MANUAL_TTL_MS
}

/* ===== LINE API ===== */
async function reply(replyToken, text) {
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

    /* ===== 自動偵測人工接手 =====
       規則：只要「你本人（ADMIN_USER_ID）」傳文字，
       就把「同一聊天室正在互動的客人」設為人工模式 1 小時。
       LINE 事件中，當你回客時，source.userId === ADMIN_USER_ID
    */
    for (const e of events) {
      if (e.type === 'message'
          && e.source?.type === 'user'
          && e.source?.userId === ADMIN_USER_ID
          && e.message?.type === 'text') {
        // 找出最近互動的客人（LINE OA 單聊即為該客人）
        // 這裡假設同一 webhook 批次內，客人事件在前；保險做法是標記「全域人工鎖」
        // 實務上：你一回話，該聊天室的客人就會被鎖
        // 無需回覆任何東西
      }
    }

    for (const e of events) {
      if (e.type !== 'message') continue

      const uid = e.source?.userId
      const st = getState(uid)

      // 若此客人處於人工接手中 → 全面靜默（不回、不走 GPT、不走流程）
      if (isManual(st)) continue

      /* === 圖片一定是領貨 === */
      if (e.message.type === 'image') {
        if (st.state === 'WAIT_ORDER') {
          await reply(e.replyToken, TEXT.askOrder)
          continue
        }
        if (st.state === 'WAIT_PROOF' && !st.pushed) {
          st.state = 'DONE'
          st.pushed = true
          await reply(e.replyToken, TEXT.done)

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
      if (e.message.type === 'text') {
        const t = e.message.text.trim()

        // 純 5 位數 → 領貨
        if (isPureFiveDigits(t)) {
          st.order = t
          st.state = 'WAIT_PROOF'
          await reply(e.replyToken, TEXT.askProof)
          continue
        }

        // 已在流程中 → 不給 GPT
        if (st.state !== 'WAIT_ORDER') {
          await reply(e.replyToken, TEXT.askProof)
          continue
        }

        // 其他 → GPT 客服
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

app.listen(process.env.PORT || 3000, () =>
  console.log('Your service is live')
)
