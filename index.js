import express from 'express'
import crypto from 'crypto'
import fetch from 'node-fetch'
import fs from 'fs'
import path from 'path'

const app = express()

const {
  CHANNEL_ACCESS_TOKEN,
  CHANNEL_SECRET,
  ADMIN_USER_ID,
  OPENAI_API_KEY,
} = process.env

/* ===== 驗簽（不 throw） ===== */
function verifyLine(req, res, buf) {
  const sig = crypto
    .createHmac('sha256', CHANNEL_SECRET)
    .update(buf)
    .digest('base64')

  if (sig !== req.headers['x-line-signature']) {
    req._badSig = true
  }
}

app.use(express.json({ verify: verifyLine }))

/* ===== 常數 ===== */
const MANUAL_TTL_MS = 60 * 60 * 1000
const MANUAL_PING_COOLDOWN_MS = 2 * 60 * 1000

/* ===== KB（kb.json TopK 檢索 + 熱更新） ===== */
const KB_PATH = path.resolve(process.cwd(), 'kb.json')
let KB = []

function loadKB() {
  try {
    const raw = fs.readFileSync(KB_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) throw new Error('kb.json must be an array')
    KB = parsed
    console.log(`[KB] loaded ${KB.length} items`)
  } catch (e) {
    console.error('[KB] load failed:', e.message)
    KB = []
  }
}
loadKB()

try {
  fs.watch(KB_PATH, { persistent: false }, () => {
    console.log('[KB] changed, reloading...')
    loadKB()
  })
} catch (_) {}

const norm = (s = '') => String(s).toLowerCase().replace(/\s+/g, ' ').trim()

function kbScore(query, item) {
  const q = norm(query)
  if (!q) return 0

  const hay = norm(
    [
      ...(item.questions || []),
      item.answer || '',
      ...(item.tags || []),
    ].join(' ')
  )

  if (hay.includes(q)) return 999

  const words = q
    .split(/[^a-z0-9\u4e00-\u9fff]+/i)
    .filter(Boolean)

  let hit = 0
  for (const w of words) {
    if (w.length >= 2 && hay.includes(w)) hit++
  }
  return hit
}

function kbTopK(query, k = 4, minScore = 2) {
  const ranked = KB
    .map(it => ({ it, s: kbScore(query, it) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, k)

  const best = ranked[0]?.s || 0
  if (best !== 999 && best < minScore) return []
  return ranked.map(x => x.it)
}

function kbToContext(items) {
  return items
    .map(it => {
      const qs = (it.questions || []).slice(0, 6).join(' / ')
      const links = (it.links || []).length
        ? `\nLinks:\n- ${(it.links || []).join('\n- ')}`
        : ''
      return `【KB】${it.id || ''}\nQ: ${qs}\nA: ${it.answer || ''}${links}`.trim()
    })
    .join('\n\n')
}

/* ===== 工具 ===== */
const now = () => Date.now()
const isPureFiveDigits = t => /^\d{5}$/.test((t || '').trim())
const isValidUserId = u => typeof u === 'string' && /^U[0-9a-f]{32}$/i.test(u)

function briefOfMessage(e) {
  const mt = e?.message?.type
  if (mt === 'text') return (e.message.text || '').slice(0, 80)
  if (mt === 'image') return '[圖片]'
  if (mt === 'video') return '[影片]'
  if (mt === 'audio') return '[音訊]'
  if (mt === 'file') return `[檔案] ${(e.message.fileName || '').slice(0, 40)}`
  if (mt === 'sticker') return '[貼圖]'
  return '[未知]'
}

/* ===== 領貨意圖判斷（已修） ===== */
function hasPickupIntent(t) {
  const s = (t || '').trim()

  const exclude = [
    '等很久了', '怎麼那麼久', '到底好了沒', '處理一下',
    '回一下', '在嗎', '人呢', '快一點', '不回是怎樣',
  ]
  if (exclude.some(k => s.includes(k))) return false

  const include = [
    '已付款', '付款了', '轉帳', '匯款', '繳費', '刷卡',
    '領貨', '取貨', '拿貨',
    '出貨', '發貨', '寄了', '到了沒',
    '序號', '點數', '卡',
    '沒收到', '幫我查', '查訂單',
  ]
  return include.some(k => s.includes(k))
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
      _lastManualPingAt: 0,
      _manualBurstCount: 0,
      _manualLastBrief: '',
    })
  }
  return store.get(uid)
}

function isManual(st) {
  if (!st.manualUntil) return false
  if (st.manualUntil > now()) return true

  // 人工期結束 → 重置狀態
  st.manualUntil = 0
  st.state = 'WAIT_ORDER'
  st.order = null
  st.pushed = false
  return false
}

function setManual(st) {
  st.manualUntil = now() + MANUAL_TTL_MS
  st._lastManualPingAt = 0
  st._manualBurstCount = 0
  st._manualLastBrief = ''
}

/* ===== LINE API ===== */
async function reply(replyToken, text) {
  if (!replyToken) return
  const r = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }),
  })
  if (!r.ok) console.error('LINE reply fail', r.status, await r.text())
}

async function push(to, text) {
  if (!isValidUserId(to)) return
  const r = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ to, messages: [{ type: 'text', text }] }),
  })
  if (!r.ok) console.error('LINE push fail', r.status, await r.text())
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

/* ===== GPT（含 KB 注入） ===== */
async function gptReply(userText) {
  const hits = kbTopK(userText, 4, 2)
  const kbContext = hits.length ? kbToContext(hits) : ''

  const messages = [
    {
      role: 'system',
      content:
        '你是官方客服，語氣冷靜、專業、簡短。若提到領貨，一律指示提供 5 位數訂單編號與付款截圖。若有 KB 內容，必須優先遵守 KB 的規則與標準答案；KB 沒提到才自由回答。',
    },
    ...(kbContext ? [{
      role: 'system',
      content: `以下是知識庫（優先遵守）：\n\n${kbContext}`,
    }] : []),
    { role: 'user', content: userText },
  ]

  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      temperature: 0.3,
      messages,
    }),
  })

  if (!r.ok) return '客服系統暫時忙碌，請稍後再試。'
  const j = await r.json()
  return j.choices?.[0]?.message?.content || '客服系統暫時忙碌，請稍後再試。'
}

/* ===== Webhook ===== */
app.post('/webhook', async (req, res) => {
  if (req._badSig) return res.sendStatus(401)

  try {
    const events = req.body?.events || []

    for (const e of events) {
      if (e.type !== 'message' || e.source?.type !== 'user') continue

      const uid = e.source.userId
      const st = getState(uid)

      /* 人工期：不回客，只彙整推播 */
      if (isManual(st)) {
        st._manualBurstCount++
        st._manualLastBrief = briefOfMessage(e)

        if (now() - st._lastManualPingAt > MANUAL_PING_COOLDOWN_MS) {
          st._lastManualPingAt = now()

          const profile = await getProfile(uid)
          await push(
            ADMIN_USER_ID,
            `人工期間新訊息（彙整）
客人暱稱：${profile?.displayName || '未提供'}
訂單：${st.order || '未填'}
本段共：${st._manualBurstCount} 則
最後：${st._manualLastBrief}`
          )

          st._manualBurstCount = 0
          st._manualLastBrief = ''
        }
        continue
      }

      /* 圖片 */
      if (e.message.type === 'image') {
        if (st.state === 'WAIT_PROOF' && !st.pushed) {
          st.state = 'DONE'
          st.pushed = true
          await reply(e.replyToken, TEXT.done)
          setManual(st)

          const profile = await getProfile(uid)
          await push(
            ADMIN_USER_ID,
            `通關通知\n客人暱稱：${profile?.displayName || '未提供'}\n訂單編號：${st.order}`
          )
        } else {
          await reply(e.replyToken, TEXT.askOrder)
        }
        continue
      }

      /* 文字 */
      const t = (e.message.text || '').trim()

      if (isPureFiveDigits(t)) {
        st.order = t
        st.state = 'WAIT_PROOF'
        await reply(e.replyToken, TEXT.askProof)
        continue
      }

      if (st.state === 'WAIT_ORDER' && hasPickupIntent(t)) {
        await reply(e.replyToken, TEXT.askOrder)
        continue
      }

      if (st.state === 'WAIT_PROOF') {
        await reply(e.replyToken, TEXT.askProof)
        continue
      }

      if (st.state === 'DONE') {
        await reply(e.replyToken, TEXT.done)
        continue
      }

      await reply(e.replyToken, await gptReply(t))
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
