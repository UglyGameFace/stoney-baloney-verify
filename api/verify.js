const { createClient } = require("@supabase/supabase-js");
const formidable = require("formidable");
const fs = require("fs");
const http = require("http");
const https = require("https");
const FormData = require("form-data");

// ---- CORS ----
function setCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function readStreamBody(resStream) {
  return new Promise((resolve) => {
    let data = "";
    resStream.on("data", (c) => (data += c));
    resStream.on("end", () => resolve(data));
    resStream.on("error", () => resolve(data));
  });
}

function formGetLength(fd) {
  return new Promise((resolve, reject) => {
    fd.getLength((err, length) => {
      if (err) return reject(err);
      resolve(length);
    });
  });
}

async function postMultipart(urlString, fd) {
  const url = new URL(urlString);
  const isHttps = url.protocol === "https:";
  const client = isHttps ? https : http;

  const headers = fd.getHeaders();
  const length = await formGetLength(fd);
  headers["Content-Length"] = length;

  const options = {
    method: "POST",
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname + url.search,
    headers,
    timeout: 15000,
  };

  return new Promise((resolve, reject) => {
    const req = client.request(options, async (resp) => {
      const body = await readStreamBody(resp);
      resolve({ status: resp.statusCode || 0, body });
    });

    req.on("timeout", () => req.destroy(new Error("Discord request timed out")));
    req.on("error", reject);

    fd.pipe(req);
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

  // ✅ FIX: Formidable v3 init
  const form = formidable.formidable({
    multiples: false,
    keepExtensions: true,
    maxFileSize: 4 * 1024 * 1024, // 4MB
  });

  form.parse(req, async (err, fields, files) => {
    let tempPath = null;

    try {
      if (err) {
        return res.status(400).json({
          success: false,
          error: "Bad upload payload (maybe too large)",
          details: String(err?.message || err),
        });
      }

      const token = Array.isArray(fields.token) ? fields.token[0] : fields.token;
      const status = Array.isArray(fields.status) ? fields.status[0] : fields.status;
      const uploaded = Array.isArray(files.file) ? files.file[0] : files.file;

      if (!token) return res.status(400).json({ success: false, error: "Missing token" });
      if (!uploaded?.filepath) return res.status(400).json({ success: false, error: "Missing file" });

      tempPath = uploaded.filepath;

      if (uploaded.size && uploaded.size > 4 * 1024 * 1024) {
        return res.status(413).json({ success: false, error: "File too large (max 4MB)" });
      }

      // 1) Lookup token
      const { data: row, error: readErr } = await supabase
        .from("verification_tokens")
        .select("webhook_url, expires_at, used")
        .eq("token", token)
        .single();

      if (readErr || !row) return res.status(400).json({ success: false, error: "Invalid token" });
      if (!row.webhook_url) return res.status(400).json({ success: false, error: "Token missing webhook_url" });
      if (row.used) return res.status(400).json({ success: false, error: "Token already decided" });

      if (row.expires_at) {
        const expMs = new Date(row.expires_at).getTime();
        if (Number.isFinite(expMs) && Date.now() > expMs) {
          return res.status(400).json({ success: false, error: "Token expired" });
        }
      }

      // 2) Build Discord multipart (Node-safe)
      const buf = fs.readFileSync(tempPath);
      const mime = uploaded.mimetype || "image/jpeg";
      const filename = "stoney_verify.jpg";

      const fd = new FormData();

      fd.append(
        "payload_json",
        JSON.stringify({
          content: "🌿 **Verification Submission Received**",
          attachments: [{ id: 0, filename, description: "User upload" }],
          embeds: [
            {
              title: "Stoney Verify Submission",
              description:
                `**Status:** ${status || "UNKNOWN"}\n` +
                `**Token:** \`${token}\`\n\n` +
                "Staff: use the Approve/Reject buttons inside the ticket.",
              image: { url: `attachment://${filename}` },
              footer: { text: `token: ${token}` },
              timestamp: new Date().toISOString(),
            },
          ],
        })
      );

      fd.append("files[0]", buf, { filename, contentType: mime });

      // 3) Send to Discord webhook
      const discordRes = await postMultipart(row.webhook_url, fd);

      if (discordRes.status < 200 || discordRes.status >= 300) {
        return res.status(502).json({
          success: false,
          error: "Discord rejected webhook",
          status: discordRes.status,
          details: (discordRes.body || "").slice(0, 700),
        });
      }

      // 4) Optional logging
      try {
        await supabase
          .from("verification_tokens")
          .update({
            submitted: true,
            submitted_at: new Date().toISOString(),
            ai_status: status || null,
          })
          .eq("token", token);
      } catch (_) {}

      return res.status(200).json({ success: true });
    } catch (e) {
      console.error("verify api error:", e);
      return res.status(500).json({
        success: false,
        error: "Internal server error",
        details: String(e?.message || e),
      });
    } finally {
      if (tempPath) fs.unlink(tempPath, () => {});
    }
  });
};

module.exports.config = {
  api: { bodyParser: false },
};
