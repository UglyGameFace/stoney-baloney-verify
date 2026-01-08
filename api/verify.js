// /api/verify.js

const { createClient } = require("@supabase/supabase-js");

// Hardened formidable import for v3 differences
const formidablePkg = require("formidable");
const makeFormidable =
  typeof formidablePkg === "function"
    ? formidablePkg
    : typeof formidablePkg?.formidable === "function"
    ? formidablePkg.formidable
    : null;

const fs = require("fs");
const https = require("https");
const FormData = require("form-data");

function setCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With"
  );
}

function readStreamBody(stream) {
  return new Promise((resolve) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

async function formGetLength(fd) {
  return new Promise((resolve, reject) => {
    fd.getLength((err, len) => (err ? reject(err) : resolve(len)));
  });
}

async function postWebhook(url, fd) {
  const u = new URL(url);
  const len = await formGetLength(fd);

  const opts = {
    method: "POST",
    hostname: u.hostname,
    path: u.pathname + (u.search || ""),
    headers: { ...fd.getHeaders(), "Content-Length": len },
    timeout: 20000,
  };

  return new Promise((resolve, reject) => {
    const req = https.request(opts, async (resp) => {
      const body = await readStreamBody(resp);
      resolve({ status: resp.statusCode || 0, body });
    });
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
      details:
        "Expected require('formidable') to be a function or have a .formidable function.",
    });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return res
      .status(500)
      .json({ success: false, error: "Missing Supabase env vars" });
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  const form = makeFormidable({
    multiples: false,
    keepExtensions: true,
    maxFileSize: 4 * 1024 * 1024,
  });

  form.parse(req, async (err, fields, files) => {
    let tempPath = null;

    try {
      if (err) {
        return res.status(400).json({
          success: false,
          error: "Form parse error",
          details: String(err?.message || err),
        });
      }

      const token = String(pickFirst(fields.token) || "").trim();
      const status = String(pickFirst(fields.status) || "").trim() || "UNKNOWN";
      const uploaded = pickFirst(files.file);

      if (!token) {
        return res.status(400).json({ success: false, error: "Missing token" });
      }

      tempPath = uploaded?.filepath || uploaded?.path || null;
      if (!tempPath) {
        return res.status(400).json({ success: false, error: "Missing file" });
      }

      const { data: row, error: readErr } = await supabase
        .from("verification_tokens")
        .select("webhook_url, expires_at, used, user_id")
        .eq("token", token)
        .single();

      if (readErr || !row) {
        return res.status(400).json({ success: false, error: "Invalid token" });
      }
      if (row.used) {
        return res
          .status(400)
          .json({ success: false, error: "Token already used" });
      }
      if (row.expires_at && Date.now() > new Date(row.expires_at).getTime()) {
        return res.status(400).json({ success: false, error: "Token expired" });
      }
      if (!row.webhook_url) {
        return res.status(500).json({
          success: false,
          error: "Token row missing webhook_url",
        });
      }

      const buf = fs.readFileSync(tempPath);

      const fd = new FormData();
      const filename = "stoney_verify.jpg";
      const mime = uploaded?.mimetype || "image/jpeg";

      // ✅ CLEAN PAYLOAD: no repeated token spam, no embed fields
      // Keep token ONLY in footer (short form) so staff can reference it if needed.
      const payload = {
        username: "StoneyVerify",
        content:
          "🌿 **Verification Submission Received**\n" +
          (row.user_id ? `User: <@${row.user_id}>\n` : "") +
          `AI: ${status}\n` +
          "Staff: use the Approve/Reject panel below.",
        embeds: [
          {
            title: "Stoney Verify Submission",
            description: `AI Status: ${status}`,
            image: { url: `attachment://${filename}` },
            footer: { text: `t:${token}` }, // ✅ short + consistent
            timestamp: new Date().toISOString(),
          },
        ],
        attachments: [{ id: 0, filename }],
      };

      fd.append("payload_json", JSON.stringify(payload));
      fd.append("files[0]", buf, { filename, contentType: mime });

      const whUrl = new URL(row.webhook_url);
      whUrl.searchParams.set("wait", "true");

      const webhookRes = await postWebhook(whUrl.toString(), fd);

      if (webhookRes.status < 200 || webhookRes.status >= 300) {
        return res.status(502).json({
          success: false,
          error: "Webhook post failed",
          status: webhookRes.status,
          details: String(webhookRes.body || "").slice(0, 900),
        });
      }

      // ✅ Mark submitted (warn-only if your table lacks cols)
      const upd = await supabase
        .from("verification_tokens")
        .update({
          submitted: true,
          submitted_at: new Date().toISOString(),
          ai_status: status || null,
        })
        .eq("token", token);

      if (upd?.error) {
        console.warn("Supabase update warning:", upd.error?.message || upd.error);
      }

      return res.status(200).json({ success: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({
        success: false,
        error: String(e?.message || e),
      });
    } finally {
      if (tempPath) fs.unlink(tempPath, () => {});
    }
  });
};

module.exports.config = { api: { bodyParser: false } };
