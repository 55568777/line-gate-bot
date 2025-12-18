import express from 'express'
import crypto from 'crypto'
import fetch from 'node-fetch'

const app = express()
const { CHANNEL_ACCESS_TOKEN, CHANNEL_SECRET, ADMIN_USER_ID } = process.env

app.use(express.json({ verify: verifyLine }))

/* ===== LINE 驗簽 ===== */
function verifyLine(req, res, buf) {
  const sig = crypto.createHmac('sha256', CHANNEL_SECRET).update(buf).digest('base64')
  if (sig !== req.headers['x-line-signature']) throw new Error('Bad signature')
}

/* ===== 工具 ===== */
function isFiveDigits(t) {
  return /^\d{5}$/.test(t)
}

function isValidUserId(u) {
  return typeof u === 'string' && /^U[0-9a-f]{32}$/i.test(u)
}

/* ===== 對話文案（客人端） ===== */
const TEXT = {
  askOrder: '請提供【5 位數訂單編號】（僅收數字）。',
  askProof: '請上傳【付款明細截圖】（圖片）。',
  done: '資料已收齊，通知真人發貨客服核對中；未通知前請勿重複詢問。',
  follow: '僅依流程處理，請提供【訂單編號＋付款截圖】。',
}

/* ===== 暫存狀態 =====
state:
- WAIT_ORDER
- WAIT_PROOF
- DONE
*/
const store = new Map()

function getState(uid) {
  if (!store.has(uid)) {
    store.set(uid, {
      state: 'WAIT_ORDER',
      order: null,
      pushed: false,
    })
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

  const r = await fetch('https://api.line.me/v2/bot/message/push', {
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

  const body = await r.text()
  console.log('PUSH_STATUS', r.status, body)
}

async function getProfile(uid) {
  try {
    const r = await fetch(`https://api.line.me/v2/bot/profile/${uid}`, {
      headers: { 'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}` },
    })
    if (!r.ok) return null
    return await r.json() // { displayName }
  } catch {
    return null
  }
}

/* ===== Webhook ===== */
app.post('/webhook', async (req, res) => {
  try {
    for (const e of req.body?.events || []) {
      if (e.type !== 'message') continue

      const uid = e.source?.userId
      const st = getState(uid)

      /* ===== 文字 ===== */
      if (e.message.type === 'text') {
        const t = e.message.text.trim()

        if (st.state === 'WAIT_ORDER') {
          if (isFiveDigits(t)) {
            st.order = t
            st.state = 'WAIT_PROOF'
            await reply(e.replyToken, TEXT.askProof)
          } else {
            await reply(e.replyToken, TEXT.askOrder)
          }
          continue
        }

        if (st.state === 'WAIT_PROOF') {
          await reply(e.replyToken, TEXT.askProof)
          continue
        }

        await reply(e.replyToken, TEXT.done)
        continue
      }

      /* ===== 圖片 ===== */
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
      }
    }

    res.sendStatus(200)
  } catch (err) {
    console.error(err)
    res.sendStatus(500)
  }
})

app.get('/', (_, res) => res.send('ok'))
app.listen(process.env.PORT || 3000, () => console.log('Your service is live'))
