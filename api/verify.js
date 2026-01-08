const { createClient } = require("@supabase/supabase-js");
const formidable = require("formidable");
const fs = require("fs");
const https = require("https");
const FormData = require("form-data");

// ---- CORS ----
function setCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function readStreamBody(stream) {
  return new Promise((resolve) => {
    let data = "";
    stream.on("data", (c) => (data += c));
    stream.on("end", () => resolve(data));
    stream.on("error", () => resolve(data));
  });
}

async function getWebhookInfo(webhookUrl) {
  // GET https://discord.com/api/webhooks/{id}/{token}
  return new Promise((resolve, reject) => {
    https
      .get(webhookUrl, async (resp) => {
        const body = await readStreamBody(resp);
        if ((resp.statusCode || 0) < 200 || (resp.statusCode || 0) >= 300) {
          return reject(new Error(`Webhook GET failed ${resp.statusCode}: ${body}`));
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error("Webhook GET returned non-JSON"));
        }
      })
      .on("error", reject);
  });
}

function formGetLength(fd) {
  return new Promise((resolve, reject) => {
    fd.getLength((err, length) => (err ? reject(err) : resolve(length)));
  });
}

async function postDiscordChannelMessage(channelId, botToken, formData) {
  const length = await formGetLength(formData);

  const options = {
    method: "POST",
    hostname: "discord.com",
    path: `/api/v10/channels/${channelId}/messages`,
    headers: {
      Authorization: `Bot ${botToken}`,
      ...formData.getHeaders(),
      "Content-Length": length,
    },
    timeout: 15000,
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, async (resp) => {
      const body = await readStreamBody(resp);
      resolve({ status: resp.statusCode || 0, body });
    });
    req.on("timeout", () => req.destroy(new Error("Discord request timeout")));
    req.on("error", reject);
    formData.pipe(req);
  });
}

module.exports = async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Method not allowed" });

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const botToken = process.env.DISCORD_BOT_TOKEN;

  if (!supabaseUrl || !serviceRoleKey) {
    return res.status(500).json({ success: false, error: "Missing SUPABASE env vars" });
  }
  if (!botToken) {
    return res.status(500).json({ success: false, error: "Missing DISCORD_BOT_TOKEN env var" });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  // ✅ Formidable v3 init
  const form = formidable.formidable({
    multiples: false,
    keepExtensions: true,
    maxFileSize: 4 * 1024 * 1024,
  });

  form.parse(req, async (err, fields, files) => {
    let tempPath = null;

    try {
      if (err) {
        return res.status(400).json({ success: false, error: "Bad upload payload", details: String(err.message || err) });
      }

      const token = Array.isArray(fields.token) ? fields.token[0] : fields.token;
      const status = Array.isArray(fields.status) ? fields.status[0] : fields.status;
      const uploaded = Array.isArray(files.file) ? files.file[0] : files.file;

      if (!token) return res.status(400).json({ success: false, error: "Missing token" });
      if (!uploaded?.filepath) return res.status(400).json({ success: false, error: "Missing file" });

      tempPath = uploaded.filepath;

      const { data: row, error: readErr } = await supabase
        .from("verification_tokens")
        .select("webhook_url, expires_at, used, user_id")
        .eq("token", token)
        .single();

      if (readErr || !row) return res.status(400).json({ success: false, error: "Invalid token" });
      if (!row.webhook_url) return res.status(400).json({ success: false, error: "Token missing webhook_url" });
      if (!row.user_id) return res.status(400).json({ success: false, error: "Token missing user_id (Discord user id)" });
      if (row.used) return res.status(400).json({ success: false, error: "Token already decided" });

      if (row.expires_at) {
        const expMs = new Date(row.expires_at).getTime();
        if (Number.isFinite(expMs) && Date.now() > expMs) {
          return res.status(400).json({ success: false, error: "Token expired" });
        }
      }

      // Discover channel_id from webhook
      const webhookInfo = await getWebhookInfo(row.webhook_url);
      const channelId = webhookInfo.channel_id;
      if (!channelId) return res.status(500).json({ success: false, error: "Could not resolve channel_id from webhook" });

      const buf = fs.readFileSync(tempPath);
      const mime = uploaded.mimetype || "image/jpeg";
      const filename = "stoney_verify.jpg";

      const fd = new FormData();
      fd.append(
        "payload_json",
        JSON.stringify({
          content: `🌿 **Verification Submission Received**\nUser: <@${row.user_id}>`,
          attachments: [{ id: 0, filename, description: "User upload" }],
          embeds: [
            {
              title: "Stoney Verify Submission",
              description: `**AI Status:** ${status || "UNKNOWN"}\n**Token:** \`${token}\``,
              image: { url: `attachment://${filename}` },
              timestamp: new Date().toISOString(),
            },
          ],
          components: [
            {
              type: 1,
              components: [
                { type: 2, style: 3, label: "APPROVE", custom_id: `verify:approve:${token}` },
                { type: 2, style: 4, label: "DENY", custom_id: `verify:deny:${token}` },
              ],
            },
          ],
        })
      );

      fd.append("files[0]", buf, { filename, contentType: mime });

      const discordRes = await postDiscordChannelMessage(channelId, botToken, fd);
      if (discordRes.status < 200 || discordRes.status >= 300) {
        return res.status(502).json({
          success: false,
          error: "Discord rejected message",
          status: discordRes.status,
          details: (discordRes.body || "").slice(0, 900),
        });
      }

      await supabase
        .from("verification_tokens")
        .update({ submitted: true, submitted_at: new Date().toISOString(), ai_status: status || null })
        .eq("token", token);

      return res.status(200).json({ success: true });
    } catch (e) {
      console.error("verify api error:", e);
      return res.status(500).json({ success: false, error: "Internal server error", details: String(e.message || e) });
    } finally {
      if (tempPath) fs.unlink(tempPath, () => {});
    }
  });
};

module.exports.config = { api: { bodyParser: false } };
