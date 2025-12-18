import express from 'express'
import crypto from 'crypto'
import fetch from 'node-fetch'

const app = express()
app.use(express.json({ verify: verifyLine }))

const { CHANNEL_ACCESS_TOKEN, CHANNEL_SECRET, ADMIN_USER_ID } = process.env

const cache = new Map()

function verifyLine(req, res, buf) {
  const sig = crypto.createHmac('sha256', CHANNEL_SECRET).update(buf).digest('base64')
  if (sig !== req.headers['x-line-signature']) throw new Error('Bad signature')
}

async function push(to, messages) {
  const r = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ to: String(to).trim(), messages }),
  })
  const txt = await r.text()
  console.log('PUSH_STATUS', r.status, txt)
  return r.status
}

app.post('/webhook', async (req, res) => {
  try {
    for (const e of req.body.events || []) {
      if (e.type !== 'message') continue

      const uid = e.source.userId
      console.log('FROM USER:', uid)

      if (e.message.type === 'text') {
        const m = e.message.text.match(/\b\d{5}\b/)
        if (m) {
          cache.set(uid, { order: m[0] })
          console.log('ORDER OK:', m[0])
        }
      }

      if (e.message.type === 'image') {
        const st = cache.get(uid)
        if (st?.order) {
          console.log('READY_TO_PUSH')
          await push(ADMIN_USER_ID, [{
            type: 'text',
            text: `通關\nUSER: ${uid}\nORDER: ${st.order}`
          }])
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

app.listen(process.env.PORT || 3000, () => console.log('Your service is live'))
