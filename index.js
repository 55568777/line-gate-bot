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

/* ===== 文案 ===== */
const TEXT = {
  askOrder: '請提供【5 位數訂單編號】。',
  askProof: '請上傳【付款明細截圖】（圖片）。',
  done: '資料已收齊，核對中；未通知前請勿重複詢問。',
}

/* ===== 狀態 ===== */
const store = new Map()
// WAIT_ORDER → WAIT_PROOF → DONE
function getState(uid) {
  if (!store.has(uid)) {
    store.set(uid, { state: 'WAIT_ORDER', order: null, pushed: false })
  }
  return store.get(uid)
}

/* ===== LINE API ===== */
async function reply(replyToken, text) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: 'text', text }],
    }),
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
    body: JSON.stringify({
      to,
      messages: [{ type: 'text', text }],
    }),
  })
}

async function getProfile(uid) {
  try {
    const r = await fetch(`https://api.line.me/v2/bot/profile/${uid}`, {
      headers: { Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` },
    })
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  }
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
      model: 'gpt-4o-mini',
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

  const txt = await r.text()
  console.log('GPT_STATUS', r.status, txt)

  if (!r.ok) {
    return '客服系統暫時忙碌，請稍後再試。'
  }

  const j = JSON.parse(txt)
  return j.choices?.[0]?.message?.content || '客服系統暫時忙碌，請稍後再試。'
}


/* ===== Webhook ===== */
app.post('/webhook', async (req, res) => {
  try {
    for (const e of req.body?.events || []) {
      if (e.type !== 'message') continue

      const uid = e.source?.userId
      const st = getState(uid)

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

        // （你專用）重置流程
        if (t === '#reset') {
          store.delete(uid)
          await reply(e.replyToken, '流程已重置。')
          continue
        }

        // 純 5 位數 → 領貨
        if (isPureFiveDigits(t)) {
          st.order = t
          st.state = 'WAIT_PROOF'
          await reply(e.replyToken, TEXT.askProof)
          continue
        }

        // 已在領貨流程中 → 不給 GPT
        if (st.state !== 'WAIT_ORDER') {
          await reply(e.replyToken, TEXT.askProof)
          continue
        }

        // 其他純文字 → GPT 客服
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

