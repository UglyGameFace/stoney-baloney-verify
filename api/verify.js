// /api/verify.js

const { createClient } = require("@supabase/supabase-js");
const formidablePkg = require("formidable");
const fs = require("fs");
const https = require("https");
const FormData = require("form-data");

const makeFormidable =
  typeof formidablePkg === "function"
    ? formidablePkg
    : typeof formidablePkg?.formidable === "function"
    ? formidablePkg.formidable
    : null;

function setCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function readStreamBody(stream) {
  return new Promise((resolve) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

async function postWebhook(url, fd) {
  const u = new URL(url);
  const len = await new Promise((r, j) =>
    fd.getLength((e, l) => (e ? j(e) : r(l)))
  );

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        method: "POST",
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: { ...fd.getHeaders(), "Content-Length": len },
        timeout: 20000,
      },
      async (resp) => {
        const body = await readStreamBody(resp);
        resolve({ status: resp.statusCode || 0, body });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Webhook timeout")));
    fd.pipe(req);
  });
}

function pickFirst(v) {
  return Array.isArray(v) ? v[0] : v;
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  if (!makeFormidable) {
    return res.status(500).json({
      success: false,
      error: "Formidable import failed",
    });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  const form = makeFormidable({
    multiples: false,
    keepExtensions: true,
    maxFileSize: 4 * 1024 * 1024,
  });

  form.parse(req, async (err, fields, files) => {
    let tempPath = null;

    try {
      if (err) throw err;

      const token = String(pickFirst(fields.token) || "").trim();
      const aiStatus = String(pickFirst(fields.status) || "UNKNOWN").trim();
      const uploaded = pickFirst(files.file);

      if (!token) throw new Error("Missing token");
      tempPath = uploaded?.filepath || uploaded?.path;
      if (!tempPath) throw new Error("Missing file");

      const { data: row, error } = await supabase
        .from("verification_tokens")
        .select("webhook_url, expires_at, used, user_id, guild_id, channel_id")
        .eq("token", token)
        .single();

      if (error || !row) throw new Error("Invalid token");
      if (row.used) throw new Error("Token already used");
      if (row.expires_at && Date.now() > new Date(row.expires_at).getTime()) {
        throw new Error("Token expired");
      }

      // ✅ CRITICAL: UPDATE SUPABASE FIRST
      const { error: updErr } = await supabase
        .from("verification_tokens")
        .update({
          submitted: true,
          submitted_at: new Date().toISOString(),
          ai_status: aiStatus,
        })
        .eq("token", token);

      if (updErr) throw updErr;

      // THEN post webhook
      const buf = fs.readFileSync(tempPath);
      const fd = new FormData();
      const filename = "stoney_verify.jpg";

      fd.append(
        "payload_json",
        JSON.stringify({
          username: "StoneyVerify",
          content:
            "🌿 **Verification Submission Received**\n" +
            (row.user_id ? `User: <@${row.user_id}>\n` : "") +
            `AI: ${aiStatus}\n` +
            "Staff: use the Approve/Reject panel below.",
          embeds: [
            {
              title: "Stoney Verify Submission",
              image: { url: `attachment://${filename}` },
              footer: { text: `t:${token}` },
              timestamp: new Date().toISOString(),
            },
          ],
          attachments: [{ id: 0, filename }],
        })
      );

      fd.append("files[0]", buf, { filename });

      const wh = new URL(row.webhook_url);
      wh.searchParams.set("wait", "true");

      const whRes = await postWebhook(wh.toString(), fd);
      if (whRes.status < 200 || whRes.status >= 300) {
        throw new Error("Webhook failed");
      }

      res.status(200).json({ success: true });
    } catch (e) {
      res.status(400).json({ success: false, error: String(e.message || e) });
    } finally {
      if (tempPath) fs.unlink(tempPath, () => {});
    }
  });
};

module.exports.config = { api: { bodyParser: false } };
