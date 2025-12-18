import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";

const app = express();

app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

const TOKEN  = process.env.CHANNEL_ACCESS_TOKEN;
const SECRET = process.env.CHANNEL_SECRET;
const ADMIN_USER_ID = process.env.ADMIN_USER_ID; // 之後再填

// 暫存狀態（先跑起來用）
const store = new Map();

const TEXT = {
  askOrder: "請提供【5位數】訂單編號（文字或圖片）。",
  askProof: "請提供【繳費明細截圖】。",
  received: "資料已收齊，核對中；未通知前請勿重複詢問。",
  follow: "僅依流程處理，請提供【單號＋明細】。"
};

function verifySignature(req) {
  const sig = req.get("x-line-signature");
  const hash = crypto.createHmac("sha256", SECRET)
    .update(req.rawBody)
    .digest("base64");
  return sig === hash;
}

async function reply(token, messages) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${TOKEN}`
    },
    body: JSON.stringify({ replyToken: token, messages })
  });
}

async function push(to, messages) {
  const r = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${TOKEN}`
    },
    body: JSON.stringify({ to, messages })
  });
  const txt = await r.text();
  console.log("PUSH_STATUS", r.status, txt);
}

function getState(uid) {
  if (!store.has(uid)) {
    store.set(uid, { state: "WAIT_ORDER", pushed: false });
  }
  return store.get(uid);
}

function isFiveDigits(t) {
  return /^\d{5}$/.test(t);
}

app.post("/webhook", async (req, res) => {
  if (!verifySignature(req)) return res.status(401).end();

  for (const ev of req.body.events || []) {
    if (ev.type !== "message") continue;
    const uid = ev.source.userId;
    console.log("FROM USER:", uid);
    const st = getState(uid);

    if (ev.message.type === "text") {
      const t = ev.message.text.trim();

      if (st.state === "WAIT_ORDER") {
        if (isFiveDigits(t)) {
          st.order = t;
          st.state = "WAIT_PROOF";
          await reply(ev.replyToken, [{ type: "text", text: TEXT.askProof }]);
        } else {
          await reply(ev.replyToken, [{ type: "text", text: TEXT.askOrder }]);
        }
        continue;
      }

      if (st.state === "WAIT_PROOF") {
        await reply(ev.replyToken, [{ type: "text", text: TEXT.askProof }]);
        continue;
      }

      await reply(ev.replyToken, [{ type: "text", text: TEXT.received }]);
    }

    if (ev.message.type === "image") {
      if (st.state === "WAIT_ORDER") {
        st.state = "WAIT_PROOF";
        await reply(ev.replyToken, [{ type: "text", text: TEXT.askProof }]);
        continue;
      }

      if (st.state === "WAIT_PROOF" && !st.pushed) {
        st.state = "READY";
        st.pushed = true;
        await reply(ev.replyToken, [{ type: "text", text: TEXT.received }]);

        if (ADMIN_USER_ID) {
          await push(ADMIN_USER_ID, [{
            type: "text",
            text: `通關單\n單號:${st.order || "圖片"}\n客人:${uid}`
          }]);
        }
      }
    }
  }

  res.end();
});

app.get("/", (_, res) => res.send("ok"));
app.listen(process.env.PORT || 3000);


