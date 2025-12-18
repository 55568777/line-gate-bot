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
  OPENAI_MODEL, // 可選：不設就用 gpt-4o
} = process.env

/* ===== 必要環境檢查 ===== */
function requireEnv() {
  const missing = []
  if (!CHANNEL_ACCESS_TOKEN) missing.push('CHANNEL_ACCESS_TOKEN')
  if (!CHANNEL_SECRET) missing.push('CHANNEL_SECRET')
  if (!ADMIN_USER_ID) missing.push('ADMIN_USER_ID')
  if (missing.length) {
    console.error('[FATAL] Missing env:', missing.join(', '))
    process.exit(1)
  }
}
requireEnv()

/* ===== 驗簽（timing-safe，不 throw） ===== */
function verifyLine(req, res, buf) {
  try {
    const headerSig = req.headers['x-line-signature']
    if (!CHANNEL_SECRET || typeof headerSig !== 'string' || !headerSig) {
      req._badSig = true
      return
    }

    const computed = crypto
      .createHmac('sha256', CHANNEL_SECRET)
      .update(buf)
      .digest('base64')

    // timing-safe compare
    const a = Buffer.from(computed)
    const b = Buffer.from(headerSig)
    if (a.length !== b.length) {
      req._badSig = true
      return
    }
    if (!crypto.timingSafeEqual(a, b)) req._badSig = true
  } catch {
    req._badSig = true
  }
}

app.use(express.json({ verify: verifyLine }))

/* ===== 常數 ===== */
const MANUAL_TTL_MS = 60 * 60 * 1000
const MANUAL_PING_COOLDOWN_MS = 2 * 60 * 1000

const WAIT_ORDER_TTL_MS = 24 * 60 * 60 * 1000
const WAIT_PROOF_TTL_MS = 7 * 24 * 60 * 60 * 1000

const DEDUPE_TTL_MS = 10 * 60 * 1000
const PROFILE_TTL_MS = 24 * 60 * 60 * 1000
const OPENAI_TIMEOUT_MS = 8000
const KB_WATCH_DEBOUNCE_MS = 250

const GREET_IDLE_MS = 7 * 24 * 60 * 60 * 1000
const GREETING_TEXT = `Yuyi 機器人客服｜自動回覆系統（必要時轉真人）`

// ===== GPT 併發/排隊/反洗版（標準）=====
const GPT_MAX_CONCURRENT = 5
const GPT_QUEUE_REMIND_MS = 60 * 1000
const GPT_COOLDOWN_MS = 5 * 60 * 1000
const SPAM30_THRESHOLD = 6
const SPAM120_THRESHOLD = 15
const SPAM120_HARD_THRESHOLD = 40

// ===== B1：狀態持久化（state.json）=====
const STATE_PATH = path.resolve(process.cwd(), 'state.json')
const STATE_FLUSH_DEBOUNCE_MS = 900
const STATE_FLUSH_INTERVAL_MS = 10_000
const PRUNE_AFTER_MS = 10 * 24 * 60 * 60 * 1000
const MAX_USERS = 10_000

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

/* ===== KB 命中更嚴格 + 調整門檻（更穩定帶出） ===== */
function kbScore(query, item) {
  const q = norm(query)
  if (!q) return { score: 0, ratio: 0, strong: false }

  const qs = (item.questions || []).map(norm)
  const ans = norm(item.answer || '')
  const tags = (item.tags || []).map(norm)

  // 句子包含：強命中
  if (q.length >= 4 && qs.some(x => x.includes(q))) {
    return { score: 999, ratio: 1, strong: true }
  }

  const hay = norm([...qs, ans, ...tags].join(' '))
  const words = q.split(/[^a-z0-9\u4e00-\u9fff]+/i).filter(Boolean)
  if (!words.length) return { score: 0, ratio: 0, strong: false }

  let hit = 0
  for (const w of words) {
    if (w.length >= 2 && hay.includes(w)) hit++
  }

  const ratio = hit / Math.max(words.length, 1)
  return { score: hit, ratio, strong: false }
}

function kbTopK(query, k = 4) {
  const ranked = KB
    .map(it => {
      const r = kbScore(query, it)
      return { it, ...r }
    })
    .filter(x => x.score > 0)
    .sort((a, b) => (b.strong - a.strong) || (b.score - a.score) || (b.ratio - a.ratio))
    .slice(0, k)

  const best = ranked[0]
  if (!best) return []

  if (best.strong) return ranked.map(x => x.it)

  // ★ 放寬：避免「有些問法」抓不到 KB
  if (best.score >= 2 && best.ratio >= 0.4) return ranked.map(x => x.it)

  return []
}

/* ===== 工具 ===== */
const now = () => Date.now()
const isPureFiveDigits = t => /^\s*\d{5}\s*$/.test(String(t || ''))
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

function tzTimeHHMM(ts = Date.now()) {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(ts))
}

/* ===== 領貨意圖判斷 ===== */
function hasPickupIntent(t) {
  const s = (t || '').trim()
  const exclude = [
    '等很久了', '怎麼那麼久', '到底好了沒', '處理一下',
    '回一下', '在嗎', '人呢', '快一點', '不回是怎樣',
  ]
  if (exclude.some(k => s.includes(k))) return false

  const strong = [
    '已付款', '付款了', '轉帳', '匯款', '繳費', '刷卡', '扣款',
    '領貨', '取貨', '拿貨',
    '出貨', '發貨', '寄了', '到了沒', '沒收到',
  ]
  const weak = ['幫我查', '查訂單', '查一下', '查詢']

  const hasStrong = strong.some(k => s.includes(k))
  if (hasStrong) return true
  if (weak.some(k => s.includes(k))) return false

  const other = ['序號', '點數', '卡']
  return other.some(k => s.includes(k))
}

/* ===== 發票意圖：固定導去問與答（不要求訂單）===== */
function hasInvoiceIntent(t = '') {
  const s = String(t).trim()
  if (!s) return false
  const keys = ['發票', '电子发票', '電子發票', '統編', '载具', '載具', '抬頭', '開票', '开票']
  return keys.some(k => s.includes(k))
}

/* ===== 取消/重來/傳錯 ===== */
function hasResetIntent(t = '') {
  const s = String(t).trim()
  const keys = [
    '取消', '重來', '重做', '重新', '重啟',
    '傳錯', '傳錯了', '發錯', '貼錯',
    '重傳', '再傳', '改一下', '換一張',
  ]
  return keys.some(k => s.includes(k))
}

/* ===== 文案 ===== */
const TEXT = {
  askOrder: '若要領貨，請提供【5 位數訂單編號】。',
  askProof:
`請上傳【付款明細截圖】（圖片）。
超商：紙本單據／轉帳：網銀轉帳紀錄／刷卡：扣款通知或網銀紀錄／電子支付：錢包消費紀錄。`,
  proofNote: '已收到補充說明，仍請上傳【付款明細截圖】即可。',
  done: '資料已收齊，將由真人客服核對；如需補件會再通知，請稍候。',
  needText: '一般問題請用文字描述；若要領貨，請先提供【5 位數訂單編號】。',
  busy: '客服系統暫時忙碌，請稍後再試。',
  imageNoText: '若要領貨，請先提供【5 位數訂單編號】；一般問題請用文字說明。',

  invoiceFaq:
`我們提供電子發票。
發票說明與常見問題請至【問與答 → 發票相關】查看。`,

  queueEnter:
`機器人目前正在處理其他用戶，
已幫您排隊，請勿洗版，輪到您會主動通知。`,
  queueStill: '您已在排隊中，請耐心等候，輪到您會通知。',
  queueStrong:
`偵測到重複訊息，為維護服務品質，
排隊期間請勿洗版；輪到您會通知。`,
  queueReady: '已輪到您，請直接把問題再傳一次，我會立刻處理。',
  cooldown:
`您訊息過於頻繁，系統已進入短暫冷卻以維護服務品質；
請稍後再傳，輪到您會通知。`,
}

/* ===== 狀態（RAM + B1 持久化） ===== */
const store = new Map()

function defaultState() {
  return {
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

    lastSeenAt: 0,
    lastGreetAt: 0,

    _lastPresenceFlushAt: 0,

    // ===== GPT 排隊/反洗版（持久化）=====
    gptQueued: false,
    gptQueuedAt: 0,
    gptLastQueueReplyAt: 0,
    gptReadyNotifiedAt: 0,

    cooldownUntil: 0,
    cooldownNotifiedAt: 0,

    spam30Start: 0, spam30Count: 0,
    spam120Start: 0, spam120Count: 0,
  }
}

function getState(uid) {
  if (!store.has(uid)) store.set(uid, defaultState())
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

function touch(st) {
  st.updatedAt = now()
}

function markDirty(st) {
  st.updatedAt = now()
  scheduleFlush()
}

function expireIfNeeded(st) {
  if (!st.updatedAt) st.updatedAt = now()
  const idle = now() - st.updatedAt

  if (st.state === 'WAIT_ORDER' && idle > WAIT_ORDER_TTL_MS) {
    resetState(st)
    scheduleFlush()
    return
  }

  if (st.state === 'WAIT_PROOF' && idle > WAIT_PROOF_TTL_MS) {
    resetState(st)
    scheduleFlush()
    return
  }
}

function isManual(st) {
  if (!st.manualUntil) return false
  if (st.manualUntil > now()) return true
  st.manualUntil = 0
  markDirty(st)
  return false
}

function setManual(st) {
  st.manualUntil = now() + MANUAL_TTL_MS
  st._lastManualPingAt = 0
  st._manualBurstCount = 0
  st._manualLastBrief = ''
  markDirty(st)
}

/* ===== B1：載入/寫入 state.json ===== */
let _flushTimer = null
let _dirty = false

function scheduleFlush() {
  _dirty = true
  if (_flushTimer) return
  _flushTimer = setTimeout(() => {
    _flushTimer = null
    flushStateToDisk()
  }, STATE_FLUSH_DEBOUNCE_MS)
}

function pruneStore() {
  const n = now()

  for (const [uid, st] of store) {
    const last = st.lastSeenAt || st.updatedAt || 0
    if (last && (n - last > PRUNE_AFTER_MS)) store.delete(uid)
  }

  if (store.size > MAX_USERS) {
    const arr = []
    for (const [uid, st] of store) {
      const last = st.lastSeenAt || st.updatedAt || 0
      arr.push([uid, last])
    }
    arr.sort((a, b) => a[1] - b[1])
    const needDrop = store.size - MAX_USERS
    for (let i = 0; i < needDrop; i++) store.delete(arr[i][0])
  }
}

function flushStateToDisk() {
  if (!_dirty) return
  _dirty = false
  try {
    pruneStore()
    const obj = Object.create(null)
    for (const [uid, st] of store) obj[uid] = st

    const tmp = `${STATE_PATH}.tmp`
    const data = JSON.stringify(obj)

    const fd = fs.openSync(tmp, 'w')
    try {
      fs.writeFileSync(fd, data, 'utf8')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }

    fs.renameSync(tmp, STATE_PATH)
  } catch (e) {
    console.error('[STATE] flush failed:', e.message)
  }
}

function loadStateFromDisk() {
  try {
    if (!fs.existsSync(STATE_PATH)) return
    const raw = fs.readFileSync(STATE_PATH, 'utf8')
    const data = JSON.parse(raw)
    if (!data || typeof data !== 'object') return
    for (const [uid, st] of Object.entries(data)) {
      if (!isValidUserId(uid)) continue
      if (!st || typeof st !== 'object') continue
      store.set(uid, { ...defaultState(), ...st })
    }
    pruneStore()
    console.log(`[STATE] loaded ${store.size} users`)
  } catch (e) {
    console.error('[STATE] load failed:', e.message)
  }
}

setInterval(() => flushStateToDisk(), STATE_FLUSH_INTERVAL_MS).unref?.()
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try { flushStateToDisk() } catch {}
    process.exit(0)
  })
}
loadStateFromDisk()

/* ===== 事件去重 ===== */
const dedupe = new Map()
function dedupeKey(e) {
  const uid = e?.source?.userId || ''
  const mid = e?.message?.id || ''
  const ts = e?.timestamp || ''
  const rt = e?.replyToken || ''
  return `${uid}|${mid}|${ts}|${rt}`
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
  for (const [k, t] of dedupe) if (n - t > DEDUPE_TTL_MS) dedupe.delete(k)
}, 60_000).unref?.()

/* ===== Profile 快取 ===== */
const profileCache = new Map()
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
async function replyMany(replyToken, texts = [], meta = {}) {
  const arr = (texts || []).filter(Boolean).slice(0, 5)
  if (!replyToken || arr.length === 0) return
  const r = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: arr.map(t => ({ type: 'text', text: t })),
    }),
  })
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    console.error('LINE reply fail', r.status, body, meta)
  }
}

function maybeFlushPresence(st) {
  const n = now()
  if (!st._lastPresenceFlushAt || (n - st._lastPresenceFlushAt > 10 * 60 * 1000)) {
    st._lastPresenceFlushAt = n
    scheduleFlush()
  }
}

async function replyWithGreetingIfNeeded(st, replyToken, mainText, meta = {}) {
  const n = now()
  const idleTooLong = st.lastSeenAt && (n - st.lastSeenAt > GREET_IDLE_MS)
  st.lastSeenAt = n

  const needGreet = (st.lastGreetAt === 0 || idleTooLong)
  if (needGreet) st.lastGreetAt = n

  maybeFlushPresence(st)

  if (needGreet) return replyMany(replyToken, [GREETING_TEXT, mainText], meta)
  return replyMany(replyToken, [mainText], meta)
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

/* ===== 同客戶序列化 ===== */
const userQueue = new Map()
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

/* ===== 訂單抽取 ===== */
function extractOrderCandidate(text) {
  const s = String(text || '').trim()
  if (!s) return null

  if (/^\d{5}$/.test(s)) return s

  const hasLongDigitRun = /\d{7,}/.test(s)

  const m = s.match(/(?:^|[^\d])(\d{5})(?:[^\d]|$)/)
  if (!m) return null
  const five = m[1]

  const keywordNear = (() => {
    const idx = s.indexOf(five)
    if (idx < 0) return false
    const left = Math.max(0, idx - 10)
    const right = Math.min(s.length, idx + five.length + 10)
    const window = s.slice(left, right)
    return /(訂單|單號|編號|訂單號|order)/i.test(window)
  })()
  if (keywordNear) return five

  if (hasLongDigitRun) return null

  return five
}

/* ===== GPT：併發/排隊/反洗版 ===== */
let gptActive = 0
const gptWaitQueue = []
let gptWaitHead = 0
const gptQueuedSet = new Set()

function queueUserForGpt(uid, st) {
  if (st.gptQueued && gptQueuedSet.has(uid)) return
  st.gptQueued = true
  st.gptQueuedAt = now()
  st.gptReadyNotifiedAt = 0
  if (!gptQueuedSet.has(uid)) {
    gptQueuedSet.add(uid)
    gptWaitQueue.push(uid)
  }
  markDirty(st)
}

function unqueueUser(uid, st) {
  st.gptQueued = false
  st.gptQueuedAt = 0
  st.gptReadyNotifiedAt = 0
  gptQueuedSet.delete(uid)
  markDirty(st)
}

function compactQueueIfNeeded() {
  if (gptWaitHead > 200 && gptWaitHead * 2 > gptWaitQueue.length) {
    gptWaitQueue.splice(0, gptWaitHead)
    gptWaitHead = 0
  }
}

async function notifyNextQueuedUsers() {
  const slots = Math.max(0, GPT_MAX_CONCURRENT - gptActive)
  if (slots <= 0) return

  let notified = 0
  const n = now()

  while (notified < slots && gptWaitHead < gptWaitQueue.length) {
    const uid = gptWaitQueue[gptWaitHead++]
    if (!uid) break

    if (!gptQueuedSet.has(uid)) continue
    gptQueuedSet.delete(uid)

    const st = store.get(uid)
    if (!st) continue

    if (isManual(st)) { unqueueUser(uid, st); continue }

    if (st.cooldownUntil && st.cooldownUntil > n) {
      queueUserForGpt(uid, st)
      continue
    }

    if (!st.gptQueued) continue

    if (st.gptReadyNotifiedAt && (n - st.gptReadyNotifiedAt) < 2 * 60 * 1000) {
      queueUserForGpt(uid, st)
      continue
    }

    st.gptQueued = false
    st.gptReadyNotifiedAt = n
    markDirty(st)

    await push(uid, TEXT.queueReady)
    notified++
  }

  compactQueueIfNeeded()
}

function onGptFinished() {
  notifyNextQueuedUsers().catch(() => {})
}

function tryAcquireGptSlot() {
  if (gptActive >= GPT_MAX_CONCURRENT) return false
  gptActive++
  return true
}
function releaseGptSlot() {
  gptActive = Math.max(0, gptActive - 1)
  onGptFinished()
}

/* ===== 排隊/冷卻：反洗版（任何訊息都算） ===== */
function bumpSpamCounters(st) {
  const n = now()

  if (!st.spam30Start || (n - st.spam30Start > 30 * 1000)) {
    st.spam30Start = n
    st.spam30Count = 0
  }
  st.spam30Count++

  if (!st.spam120Start || (n - st.spam120Start > 120 * 1000)) {
    st.spam120Start = n
    st.spam120Count = 0
  }
  st.spam120Count++

  markDirty(st)
}

function shouldReplyQueueMessage(st, ms = GPT_QUEUE_REMIND_MS) {
  const n = now()
  if (!st.gptLastQueueReplyAt || (n - st.gptLastQueueReplyAt > ms)) {
    st.gptLastQueueReplyAt = n
    markDirty(st)
    return true
  }
  return false
}

function enterCooldown(st) {
  const n = now()
  st.cooldownUntil = n + GPT_COOLDOWN_MS
  st.cooldownNotifiedAt = 0
  st.gptQueued = false
  st.gptQueuedAt = 0
  st.gptReadyNotifiedAt = 0
  st.gptLastQueueReplyAt = n
  markDirty(st)
}

function normalizeCooldown(st) {
  if (st.cooldownUntil && st.cooldownUntil <= now()) {
    st.cooldownUntil = 0
    st.cooldownNotifiedAt = 0
    markDirty(st)
  }
}

function handleQueuedAntiSpam(st, wasQueuedAlready) {
  bumpSpamCounters(st)

  if (st.spam120Count >= SPAM120_HARD_THRESHOLD) {
    enterCooldown(st)
    return { handled: true, replyText: TEXT.cooldown }
  }

  const strongWarn = (st.spam30Count >= SPAM30_THRESHOLD) || (st.spam120Count >= SPAM120_THRESHOLD)

  if (shouldReplyQueueMessage(st)) {
    if (!wasQueuedAlready) return { handled: true, replyText: TEXT.queueEnter }
    return { handled: true, replyText: strongWarn ? TEXT.queueStrong : TEXT.queueStill }
  }

  return { handled: true, replyText: null }
}

/* ===== GPT：Responses API + timeout（用 instructions） ===== */
async function gptReplyDirect(userText) {
  if (!OPENAI_API_KEY) return TEXT.busy

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS)

  try {
    const r = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL || 'gpt-4o',
        temperature: 0.3,
        instructions:
          '你是官方客服，語氣冷靜、專業、簡短。若提到領貨，一律指示提供 5 位數訂單編號與付款截圖。若有知識庫答案則必須遵守；沒有才自由回答。',
        input: [{ role: 'user', content: userText }],
      }),
      signal: controller.signal,
    })

    if (!r.ok) return TEXT.busy
    const j = await r.json()

    const out =
      j.output_text ||
      j.output?.[0]?.content?.find?.(c => c.type === 'output_text')?.text ||
      ''

    return out || TEXT.busy
  } catch {
    return TEXT.busy
  } finally {
    clearTimeout(timer)
  }
}

/* ===== Webhook ===== */
app.post('/webhook', async (req, res) => {
  if (req._badSig) return res.sendStatus(401)

  let responded = false
  const safeRespond = (code = 200) => {
    if (responded) return
    responded = true
    res.sendStatus(code)
  }

  const timer = setTimeout(() => safeRespond(200), 900)

  try {
    const events = req.body?.events || []
    const jobs = []

    for (const e of events) {
      if (e.type !== 'message' || e.source?.type !== 'user') continue

      const key = dedupeKey(e)
      if (isDup(key)) continue

      const uid = e.source.userId

      jobs.push(
        enqueue(uid, async () => {
          const st = getState(uid)
          expireIfNeeded(st)
          normalizeCooldown(st)

          const meta = {
            uid,
            st: st.state,
            order: st.order,
            mid: e?.message?.id,
            ts: e?.timestamp,
          }

          /* 人工期：不回客，只彙整推播 */
          if (isManual(st)) {
            st.lastSeenAt = now()
            maybeFlushPresence(st)

            st._manualBurstCount++
            st._manualLastBrief = briefOfMessage(e)
            touch(st)

            if (now() - st._lastManualPingAt > MANUAL_PING_COOLDOWN_MS) {
              st._lastManualPingAt = now()
              const profile = await getProfile(uid)

              await push(
                ADMIN_USER_ID,
                `人工期間新訊息（彙整）
客人：${profile?.displayName || '未提供'}
訂單：${st.order || '未填'}
本段：${st._manualBurstCount} 則
最後：${st._manualLastBrief}
時間：${tzTimeHHMM(now())}`
              )

              st._manualBurstCount = 0
              st._manualLastBrief = ''
              markDirty(st)
            }
            return
          }

          /* ===== 冷卻中：只影響一般問題/GPT；領貨照走 ===== */
          if (st.cooldownUntil && st.cooldownUntil > now()) {
            if (e.message.type === 'text') {
              const t0 = (e.message.text || '').trim()

              if (st.state === 'WAIT_ORDER' && isPureFiveDigits(t0)) {
                st.order = t0.trim()
                st.state = 'WAIT_PROOF'
                markDirty(st)
                await replyWithGreetingIfNeeded(st, e.replyToken, TEXT.askProof, meta)
                return
              }

              if (st.state === 'WAIT_ORDER' && hasPickupIntent(t0)) {
                const extracted = extractOrderCandidate(t0)
                if (extracted) {
                  st.order = extracted
                  st.state = 'WAIT_PROOF'
                  markDirty(st)
                  await replyWithGreetingIfNeeded(st, e.replyToken, TEXT.askProof, meta)
                  return
                }
                await replyWithGreetingIfNeeded(st, e.replyToken, TEXT.askOrder, meta)
                return
              }

              if (st.state === 'WAIT_PROOF') {
                await replyWithGreetingIfNeeded(st, e.replyToken, TEXT.proofNote, meta)
                return
              }

              if (st.state === 'DONE') {
                await replyWithGreetingIfNeeded(st, e.replyToken, TEXT.done, meta)
                return
              }
            }

            if (!st.cooldownNotifiedAt) {
              st.cooldownNotifiedAt = now()
              markDirty(st)
              await replyWithGreetingIfNeeded(st, e.replyToken, TEXT.cooldown, meta)
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
              markDirty(st)

              await replyWithGreetingIfNeeded(st, e.replyToken, TEXT.done, meta)

              setManual(st)

              const profile = await getProfile(uid)
              await push(
                ADMIN_USER_ID,
                `通關通知
客人：${profile?.displayName || '未提供'}
訂單：${st.order}
付款圖ID：${st.proofMessageId || '未知'}`
              )
              return
            }

            if (st.gptQueued) {
              const r = handleQueuedAntiSpam(st, true)
              if (r.replyText) await replyWithGreetingIfNeeded(st, e.replyToken, r.replyText, meta)
              return
            }

            touch(st)
            await replyWithGreetingIfNeeded(st, e.replyToken, TEXT.imageNoText, meta)
            return
          }

          /* 其他非文字類型（含貼圖） */
          if (e.message.type !== 'text') {
            if (st.gptQueued) {
              const r = handleQueuedAntiSpam(st, true)
              if (r.replyText) await replyWithGreetingIfNeeded(st, e.replyToken, r.replyText, meta)
              return
            }

            let out = TEXT.needText
            if (st.state === 'WAIT_PROOF') out = TEXT.askProof
            else if (st.state === 'DONE') out = TEXT.done
            touch(st)
            await replyWithGreetingIfNeeded(st, e.replyToken, out, meta)
            return
          }

          /* 文字 */
          const t = (e.message.text || '').trim()
          touch(st)

          // 取消/重來/傳錯：WAIT_PROOF / DONE 直接回到 WAIT_ORDER
          if ((st.state === 'WAIT_PROOF' || st.state === 'DONE') && hasResetIntent(t)) {
            resetState(st)
            markDirty(st)
            await replyWithGreetingIfNeeded(st, e.replyToken, TEXT.askOrder, meta)
            return
          }

          if (st.state === 'WAIT_PROOF') {
            await replyWithGreetingIfNeeded(st, e.replyToken, TEXT.proofNote, meta)
            return
          }

          if (st.state === 'DONE') {
            await replyWithGreetingIfNeeded(st, e.replyToken, TEXT.done, meta)
            return
          }

          // ★ 發票：固定導去問與答（不要求訂單、不走 GPT）
          // 但若同一句其實是領貨意圖（已付款/取貨等），仍讓領貨優先
          if (st.state === 'WAIT_ORDER' && hasInvoiceIntent(t) && !hasPickupIntent(t)) {
            await replyWithGreetingIfNeeded(st, e.replyToken, TEXT.invoiceFaq, meta)
            return
          }

          // WAIT_ORDER：純 5 位數（永遠有效）
          if (st.state === 'WAIT_ORDER' && isPureFiveDigits(t)) {
            st.order = t.trim()
            st.state = 'WAIT_PROOF'
            markDirty(st)
            await replyWithGreetingIfNeeded(st, e.replyToken, TEXT.askProof, meta)
            return
          }

          // ★★ 先 KB（很重要）：避免「領貨/取貨」問法被流程吃掉，看不到 KB
          if (st.state === 'WAIT_ORDER') {
            const hits = kbTopK(t, 4)
            if (hits.length) {
              unqueueUser(uid, st)
              await replyWithGreetingIfNeeded(st, e.replyToken, hits[0].answer || TEXT.busy, meta)
              return
            }
          }

          // WAIT_ORDER：領貨意圖才抽訂單（KB 沒命中才走這段）
          if (st.state === 'WAIT_ORDER' && hasPickupIntent(t)) {
            const extracted = extractOrderCandidate(t)
            if (extracted) {
              st.order = extracted
              st.state = 'WAIT_PROOF'
              markDirty(st)
              await replyWithGreetingIfNeeded(st, e.replyToken, TEXT.askProof, meta)
              return
            }
            await replyWithGreetingIfNeeded(st, e.replyToken, TEXT.askOrder, meta)
            return
          }

          /* ===== 一般問題：KB → 否則 GPT（含排隊/反洗版） ===== */
          //（這裡再跑一次 KB：給非 WAIT_ORDER 或漏網情況）
          {
            const hits = kbTopK(t, 4)
            if (hits.length) {
              unqueueUser(uid, st)
              await replyWithGreetingIfNeeded(st, e.replyToken, hits[0].answer || TEXT.busy, meta)
              return
            }
          }

          if (!OPENAI_API_KEY) {
            await replyWithGreetingIfNeeded(st, e.replyToken, TEXT.busy, meta)
            return
          }

          if (st.gptQueued) {
            const r = handleQueuedAntiSpam(st, true)
            if (r.replyText) await replyWithGreetingIfNeeded(st, e.replyToken, r.replyText, meta)
            return
          }

          if (gptActive >= GPT_MAX_CONCURRENT) {
            const wasQueued = !!st.gptQueued
            queueUserForGpt(uid, st)
            const r = handleQueuedAntiSpam(st, wasQueued)
            if (r.replyText) await replyWithGreetingIfNeeded(st, e.replyToken, r.replyText, meta)
            return
          }

          if (!tryAcquireGptSlot()) {
            const wasQueued = !!st.gptQueued
            queueUserForGpt(uid, st)
            const r = handleQueuedAntiSpam(st, wasQueued)
            if (r.replyText) await replyWithGreetingIfNeeded(st, e.replyToken, r.replyText, meta)
            return
          }

          unqueueUser(uid, st)

          try {
            const out = await gptReplyDirect(t)
            await replyWithGreetingIfNeeded(st, e.replyToken, out, meta)
          } finally {
            releaseGptSlot()
          }
        }).catch(err => console.error('[event] error', err))
      )
    }

    await Promise.allSettled(jobs)
    safeRespond(200)
  } catch (err) {
    console.error(err)
    safeRespond(500)
  } finally {
    clearTimeout(timer)
  }
})

/* ===== 啟動後：把 state.json 裡仍在排隊的人補回隊列（重啟不忘排隊）===== */
function rebuildGptQueueFromStore() {
  gptWaitQueue.length = 0
  gptWaitHead = 0
  gptQueuedSet.clear()

  for (const [uid, st] of store) {
    if (!st) continue
    if (!st.gptQueued) continue
    if (isManual(st)) continue
    if (!gptQueuedSet.has(uid)) {
      gptQueuedSet.add(uid)
      gptWaitQueue.push(uid)
    }
  }
}
rebuildGptQueueFromStore()

app.listen(process.env.PORT || 3000, () => console.log('Your service is live'))
