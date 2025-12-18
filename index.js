import express from 'express'
import crypto from 'crypto'
import fetch from 'node-fetch'

const app = express()

const { CHANNEL_ACCESS_TOKEN, CHANNEL_SECRET, ADMIN_USER_ID } = process.env

// 啟動就先印一次，確認 Render env 有吃到
console.log('ENV_ADMIN_USER_ID=', JSON.stringify(ADMIN_USER_ID))

app.use(express.json({ verify: verifyLine }))

// 極簡暫存：同一個 uid 先收 5 位數，再收圖片就推播
const cache = new Map()

function verifyLine(req, res, buf) {
  const sig = crypto.createHmac('sha256', CHANNEL_SECRET).update(buf).digest('base64')
  if (sig !== req.headers['x-line-signature']) throw new Error('Bad signature')
}

function isValidLineUserId(u) {
  return typeof u === 'string' && /^U[0-9a-f]{32}$/i.test(u.trim())
}

async function push(to, messages) {
  const toClean = String(to || '').trim()

  if (!isValidLineUserId(toClean)) {
    console.log('BAD_TO:', JSON.stringify(toClean))
    return { status: 0, body: 'BAD_TO' }
  }

  const r = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ to: toClean, messages }),
  })

  const txt = await r.text()
  console.log('PUSH_STATUS', r.status, txt)
  return { status: r.status, body: txt }
}

app.post('/webhook', async (req, res) => {
  try {
    const events = req.body?.events || []

    for (const e of events) {
      if (e.type !== 'message') continue

      const uid = e.source?.userId
      console.log('FROM USER:', uid)

      // 文字：抓 5 位數
      if (e.message?.type === 'text') {
        const m = String(e.message.text || '').match(/\b\d{5}\b/)
        if (m) {
          cache.set(uid, { order: m[0] })
          console.log('ORDER OK:', m[0])
        }
      }

      // 圖片：只要之前有單號就直接推
      if (e.message?.type === 'image') {
        const st = cache.get(uid)
        if (st?.order) {
          console.log('READY_TO_PUSH')
          console.log('ADMIN_USER_ID=', JSON.stringify(ADMIN_USER_ID))

          await push(ADMIN_USER_ID, [
            { type: 'text', text: `通關\nUSER: ${uid}\nORDER: ${st.order}` },
          ])

          cache.delete(uid)
        }
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
