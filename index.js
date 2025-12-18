import express from 'express'
import crypto from 'crypto'
import fetch from 'node-fetch'

const app = express()
app.use(express.json({ verify: verifyLine }))

const {
  CHANNEL_ACCESS_TOKEN,
  CHANNEL_SECRET,
  ADMIN_USER_ID
} = process.env

// 極簡暫存（只為驗證推播）
const cache = new Map()

function verifyLine(req, res, buf) {
  const sig = crypto
    .createHmac('sha256', CHANNEL_SECRET)
    .update(buf)
    .digest('base64')

  if (sig !== req.headers['x-line-signature']) {
    throw new Error('Bad signature')
  }
}

app.post('/webhook', async (req, res) => {
  try {
    for (const e of req.body.events) {
      if (e.type !== 'message') continue

      const uid = e.source.userId
      console.log('FROM USER:', uid)

      // 文字：抓 5 位數
      if (e.message.type === 'text') {
        const m = e.message.text.match(/\b\d{5}\b/)
        if (m) {
          cache.set(uid, { order: m[0] })
          console.log('ORDER OK:', m[0])
        }
      }

      // 圖片：只要之前有單號就直接推
      if (e.message.type === 'image') {
        const st = cache.get(uid)
        if (st?.order) {
          console.log('READY_TO_PUSH')

          const r = await fetch('https://api.line.me/v2/bot/message/push', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              to: ADMIN_USER_ID,
              messages: [{
                type: 'text',
                text: `通關\nUSER: ${uid}\nORDER: ${st.order}`
              }]
            })
          })

          console.log('PUSH_STATUS:', r.status)
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

app.listen(process.env.PORT || 3000, () =>
  console.log('Your service is live')
)
