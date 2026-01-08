/**
 * /api/verify.js  (Vercel Serverless Function, CommonJS)
 *
 * Receives multipart form-data from index.html:
 *   - file: image/jpeg
 *   - token: verification token
 *   - status: AI status string
 *
 * Looks up verification_tokens in Supabase (service role key),
 * then POSTS the image to the stored Discord webhook_url.
 *
 * IMPORTANT: We post via WEBHOOK (not Bot API) so:
 *   - you do NOT need DISCORD_BOT_TOKEN here
 *   - your Python bot can detect webhook messages (message.webhook_id)
 *     and drop the Approve/Reject panel in the ticket channel.
 */

const { createClient } = require("@supabase/supabase-js");
const fs = require("fs");
const https = require("https");
const FormData = require("form-data");

// Formidable v2/v3 compatible import
const formidablePkg = require("formidable");
const formidableFactory =
  (typeof formidablePkg === "function" && formidablePkg) ||
  (formidablePkg && typeof formidablePkg.formidable === "function" && formidablePkg.formidable);

function setCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function first(v) {
  return Array.isArray(v) ? v[0] : v;
}

function readStreamBody(stream) {
  return new Promise((resolve) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function formGetLength(fd) {
  return new Promise((resolve, reject) => {
    fd.getLength((err, length) => (err ? reject(err) : resolve(length)));
  });
}

async function postDiscordWebhookMultipart(webhookUrl, formData) {
  const url = new URL(webhookUrl);
  const length = await formGetLength(formData);

  const options = {
    method: "POST",
    hostname: url.hostname,
    path: url.pathname + (url.search || ""),
    headers: {
      ...formData.getHeaders(),
      "Content-Length": length,
    },
    timeout: 20000,
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, async (resp) => {
      const body = await readStreamBody(resp);
      resolve({ status: resp.statusCode || 0, body });
    });
    req.on("timeout", () => req.destroy(new Error("Discord webhook timeout")));
    req.on("error", reject);
    formData.pipe(req);
  });
}

async function parseMultipart(req) {
  if (!formidableFactory) {
    throw new Error("Formidable not available (bad install/import)");
  }

  const form = formidableFactory({
    multiples: false,
    keepExtensions: true,
    maxFileSize: 4 * 1024 * 1024, // 4MB
  });

  return await new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) return reject(err);
      resolve({ fields, files });
    });
  });
}

module.exports = async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return res.status(500).json({ success: false, error: "Server missing Supabase env vars" });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  let tempPath = null;

  try {
    const { fields, files } = await parseMultipart(req);

    const token = first(fields.token);
    const status = first(fields.status) || null;
    const uploaded = first(files.file);

    if (!token) return res.status(400).json({ success: false, error: "Missing token" });
    if (!uploaded || !uploaded.filepath) return res.status(400).json({ success: false, error: "Missing file" });

    tempPath = uploaded.filepath;

    // Server-side size check
    if (uploaded.size && uploaded.size > 4 * 1024 * 1024) {
      return res.status(413).json({ success: false, error: "File too large (max 4MB)" });
    }

    // Lookup token
    const { data: row, error: readErr } = await supabase
      .from("verification_tokens")
      .select("webhook_url, expires_at, used, user_id")
      .eq("token", token)
      .single();

    if (readErr || !row) return res.status(400).json({ success: false, error: "Invalid token" });
    if (!row.webhook_url) return res.status(400).json({ success: false, error: "Token missing webhook_url" });
    if (row.used) return res.status(400).json({ success: false, error: "Token already decided" });

    // Expiry
    if (row.expires_at) {
      const expMs = new Date(row.expires_at).getTime();
      if (Number.isFinite(expMs) && Date.now() > expMs) {
        return res.status(400).json({ success: false, error: "Token expired" });
      }
    }

    // Build Discord multipart (webhook post)
    const buf = fs.readFileSync(tempPath);
    const mime = uploaded.mimetype || "image/jpeg";
    const filename = uploaded.originalFilename || "stoney_verify.jpg";

    const fd = new FormData();

    // MUST have a SPACE after ":" so your Python bot regex matches it
    const tokenLine = `token: ${token}`;

    fd.append(
      "payload_json",
      JSON.stringify({
        content: [
          "🌿 **Verification Submission Received**",
          row.user_id ? `User: <@${row.user_id}>` : null,
          status ? `AI: **${status}**` : null,
          tokenLine,
          "",
          "Staff: check the image, then use the Approve/Reject panel.",
        ]
          .filter(Boolean)
          .join("\n"),
        embeds: [
          {
            title: "Stoney Verify Submission",
            description: [status ? `AI Status: **${status}**` : null, tokenLine].filter(Boolean).join("\n"),
            image: { url: `attachment://${filename}` },
            footer: { text: tokenLine },
            timestamp: new Date().toISOString(),
          },
        ],
        attachments: [{ id: 0, filename }],
      })
    );

    fd.append("files[0]", buf, { filename, contentType: mime });

    // wait=true helps debugging (Discord returns message JSON)
    const webhookUrl = row.webhook_url.includes("?")
      ? `${row.webhook_url}&wait=true`
      : `${row.webhook_url}?wait=true`;

    const discordRes = await postDiscordWebhookMultipart(webhookUrl, fd);

    if (discordRes.status < 200 || discordRes.status >= 300) {
      return res.status(502).json({
        success: false,
        error: "Discord rejected webhook",
        status: discordRes.status,
        details: (discordRes.body || "").slice(0, 900),
      });
    }

    // Log submission (do NOT mark used — staff decision does that)
    await supabase
      .from("verification_tokens")
      .update({
        submitted: true,
        submitted_at: new Date().toISOString(),
        ai_status: status,
      })
      .eq("token", token);

    return res.status(200).json({ success: true });
  } catch (e) {
    console.error("verify api error:", e);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
      details: String(e && (e.stack || e.message || e)),
    });
  } finally {
    if (tempPath) {
      try {
        fs.unlinkSync(tempPath);
      } catch (_) {}
    }
  }
};

module.exports.config = {
  api: { bodyParser: false },
};
