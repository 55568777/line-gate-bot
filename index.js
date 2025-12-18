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

/* ===== 必要環境檢查（避免 verifyLine 直接炸） ===== */
function requireEnv() {
  const missing = []
  if (!CHANNEL_ACCESS_TOKEN) missing.push('CHANNEL_ACCESS_TOKEN')
  if (!CHANNEL_SECRET) missing.push('CHANNEL_SECRET')
  if (!ADMIN_USER_ID) missing.push('ADMIN_USER_ID')
  // OPENAI_API_KEY 可選：沒設就不走 GPT
  if (missing.length) {
    console.error('[FATAL] Missing env:', missing.join(', '))
    process.exit(1)
  }
}
requireEnv()

/* ===== 驗簽（不 throw） ===== */
function verifyLine(req, res, buf) {
  try {
    if (!CHANNEL_SECRET) { req._badSig = true; return }
    const sig = crypto
      .createHmac('sha256', CHANNEL_SECRET)
      .update(buf)
      .digest('base64')
    if (sig !== req.headers['x-line-signature']) req._badSig = true
  } catch {
    req._badSig = true
  }
}

app.use(express.json({ verify: verifyLine }))

/* ===== 常數 ===== */
const MANUAL_TTL_MS = 60 * 60 * 1000
const MANUAL_PING_COOLDOWN_MS = 2 * 60 * 1000
const STATE_TTL_MS = 24 * 60 * 60 * 1000          // WAIT_ORDER / WAIT_PROOF 24h 過期
const DEDUPE_TTL_MS = 10 * 60 * 1000              // 事件去重 10m
const PROFILE_TTL_MS = 24 * 60 * 60 * 1000        // profile 快取 24h
const OPENAI_TIMEOUT_MS = 8000                    // GPT 超時
const KB_WATCH_DEBOUNCE_MS = 250

// ===== 久未互動再打招呼（你可改天數）=====
const GREET_IDLE_MS = 7 * 24 * 60 * 60 * 1000     // 7 天沒互動就再打招呼
const GREETING_TEXT = `Yuyi 機器人客服
本帳號為自動客服系統，
負責引導領貨流程與一般問題回覆，
實際核對將由人工處理。`

/* ===== KB（kb.json TopK 檢索 + 熱更新 + 原子更新） ===== */
const KB_PATH = path.resolve(process.cwd(), 'kb.json')
let KB = []

const norm = (s = '') => String(s).toLowerCase().replace(/\s+/g, ' ').trim()

function loadKBAtomic() {
  try {
    const raw = fs.readFileSync(KB_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) throw new Error('kb.json must be an array')
    KB = parsed
    console.log(`[KB] loaded ${KB.length} items`)
  } catch (e) {
    // 失敗不清空 KB，保留舊資料避免瞬間變空
    console.error('[KB] reload failed (keep old):', e.message)
  }
}
loadKBAtomic()

let _kbWatchTimer = null
try {
  fs.watch(KB_PATH, { persistent: false }, () => {
    clearTimeout(_kbWatchTimer)
    _kbWatchTimer = setTimeout(() => {
      console.log('[KB] changed, reloading...')
      loadKBAtomic()
    }, KB_WATCH_DEBOUNCE_MS)
  })
} catch (_) {}

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

  // 避免短 query 過度命中
  if (q.length >= 6 && hay.includes(q)) return 999

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

/* ===== 領貨意圖判斷 ===== */
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
  done: '資料已收齊，交由真人客服核對中；未通知前請勿重複詢問。',
  needText: '請用文字描述問題或提供訂單流程所需資料。',
  busy: '客服系統暫時忙碌，請稍後再試。',
}

/* ===== 狀態（RAM + TTL） ===== */
const store = new Map()
function getState(uid) {
  if (!store.has(uid)) {
    store.set(uid, {
      state: 'WAIT_ORDER',
      order: null,
      proofMessageId: null,
      proofAt: 0,
      pushed: false,

      manualUntil: 0,
      _lastManualPingAt: 0,
      _manualBurstCount: 0,
      _manualLastBrief: '',

      updatedAt: now(),

      // ===== 開場白（久未互動再送）=====
      lastSeenAt: 0,
      lastGreetAt: 0,
    })
  }
  return store.get(uid)
}

function resetState(st) {
  st.state = 'WAIT_ORDER'
  st.order = null
  st.proofMessageId = null
  st.proofAt = 0
  st.pushed = false
  st.updatedAt = now()
}

function touch(st) { st.updatedAt = now() }

function expireIfNeeded(st) {
  if (!st.updatedAt) st.updatedAt = now()
  if (now() - st.updatedAt > STATE_TTL_MS) {
    resetState(st)
  }
}

function isManual(st) {
  if (!st.manualUntil) return false
  if (st.manualUntil > now()) return true

  // 人工期結束 → 重置
  st.manualUntil = 0
  resetState(st)
  return false
}

function setManual(st) {
  st.manualUntil = now() + MANUAL_TTL_MS
  st._lastManualPingAt = 0
  st._manualBurstCount = 0
  st._manualLastBrief = ''
  touch(st)
}

/* ===== 事件去重 ===== */
const dedupe = new Map() // key -> ts
function dedupeKey(e) {
  const uid = e?.source?.userId || ''
  const mid = e?.message?.id || ''
  const rt = e?.replyToken || ''
  const ts = e?.timestamp || ''
  return `${uid}|${mid}|${rt}|${ts}`
}
function isDup(key) {
  const t = dedupe.get(key)
  const n = now()
  if (t && (n - t) < DEDUPE_TTL_MS) return true
  dedupe.set(key, n)
  return false
}
setInterval(() => {
  const n = now()
  for (const [k, t] of dedupe) {
    if (n - t > DEDUPE_TTL_MS) dedupe.delete(k)
  }
}, 60_000).unref?.()

/* ===== Profile 快取 ===== */
const profileCache = new Map() // uid -> { data, at }
async function getProfile(uid) {
  try {
    const c = profileCache.get(uid)
    if (c && (now() - c.at) < PROFILE_TTL_MS) return c.data

    const r = await fetch(`https://api.line.me/v2/bot/profile/${uid}`, {
      headers: { Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` },
    })
    if (!r.ok) return null
    const data = await r.json()
    profileCache.set(uid, { data, at: now() })
    return data
  } catch {
    return null
  }
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

/* ===== GPT（KB 命中→只回KB；否則 GPT；含 timeout） ===== */
async function gptReply(userText) {
  if (!OPENAI_API_KEY) return TEXT.busy

  const hits = kbTopK(userText, 4, 2)
  if (hits.length) return hits[0].answer || TEXT.busy

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS)

  try {
    const messages = [
      {
        role: 'system',
        content:
          '你是官方客服，語氣冷靜、專業、簡短。若提到領貨，一律指示提供 5 位數訂單編號與付款截圖。若有知識庫答案則必須遵守；沒有才自由回答。',
      },
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
      signal: controller.signal,
    })

    if (!r.ok) return TEXT.busy
    const j = await r.json()
    return j.choices?.[0]?.message?.content || TEXT.busy
  } catch {
    return TEXT.busy
  } finally {
    clearTimeout(timer)
  }
}

/* ===== 同客戶序列化（避免競態） ===== */
const userQueue = new Map() // uid -> Promise
function enqueue(uid, fn) {
  const prev = userQueue.get(uid) || Promise.resolve()
  const next = prev
    .catch(() => {})
    .then(fn)
    .finally(() => {
      if (userQueue.get(uid) === next) userQueue.delete(uid)
    })
  userQueue.set(uid, next)
  return next
}

/* ===== Webhook ===== */
app.post('/webhook', (req, res) => {
  if (req._badSig) return res.sendStatus(401)

  // 先回 200，避免 LINE 重送
  res.sendStatus(200)

  const events = req.body?.events || []
  for (const e of events) {
    if (e.type !== 'message' || e.source?.type !== 'user') continue

    const key = dedupeKey(e)
    if (isDup(key)) continue

    const uid = e.source.userId

    enqueue(uid, async () => {
      const st = getState(uid)
      expireIfNeeded(st)

      // ===== 久未互動先打招呼（且本次不進流程）=====
      const n = now()
      const idleTooLong = st.lastSeenAt && (n - st.lastSeenAt > GREET_IDLE_MS)
      st.lastSeenAt = n

      // 人工期不打招呼（避免干擾）
      if (!isManual(st) && (st.lastGreetAt === 0 || idleTooLong)) {
        st.lastGreetAt = n
        await reply(e.replyToken, GREETING_TEXT)
        return
      }

      /* 人工期：不回客，只彙整推播 */
      if (isManual(st)) {
        st._manualBurstCount++
        st._manualLastBrief = briefOfMessage(e)
        touch(st)

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
        return
      }

      /* 圖片訊息 */
      if (e.message.type === 'image') {
        if (st.state === 'WAIT_PROOF' && !st.pushed) {
          st.proofMessageId = e.message.id || null
          st.proofAt = now()
          st.state = 'DONE'
          st.pushed = true
          touch(st)

          await reply(e.replyToken, TEXT.done)

          setManual(st)

          const profile = await getProfile(uid)
          await push(
            ADMIN_USER_ID,
            `通關通知
客人暱稱：${profile?.displayName || '未提供'}
訂單編號：${st.order}
付款圖ID：${st.proofMessageId || '未知'}`
          )
        } else {
          await reply(e.replyToken, await gptReply('[客人傳了圖片，未提供文字]'))
        }
        return
      }

      /* 其他非文字類型 */
      if (e.message.type !== 'text') {
        if (st.state === 'WAIT_PROOF') await reply(e.replyToken, TEXT.askProof)
        else if (st.state === 'DONE') await reply(e.replyToken, TEXT.done)
        else await reply(e.replyToken, TEXT.needText)
        touch(st)
        return
      }

      /* 文字 */
      const t = (e.message.text || '').trim()
      touch(st)

      // 只在 WAIT_ORDER 才吃 5 位數（避免亂切）
      if (st.state === 'WAIT_ORDER' && isPureFiveDigits(t)) {
        st.order = t
        st.state = 'WAIT_PROOF'
        await reply(e.replyToken, TEXT.askProof)
        return
      }

      if (st.state === 'WAIT_ORDER' && hasPickupIntent(t)) {
        await reply(e.replyToken, TEXT.askOrder)
        return
      }

      if (st.state === 'WAIT_PROOF') {
        await reply(e.replyToken, TEXT.askProof)
        return
      }

      if (st.state === 'DONE') {
        await reply(e.replyToken, TEXT.done)
        return
      }

      await reply(e.replyToken, await gptReply(t))
    }).catch(err => console.error('[event] error', err))
  }
})

app.listen(process.env.PORT || 3000, () => console.log('Your service is live'))
