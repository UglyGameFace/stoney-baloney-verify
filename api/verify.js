const { createClient } = require("@supabase/supabase-js");
const formidable = require("formidable");
const FormData = require("form-data");
const fs = require("fs");
const fetch = require("node-fetch"); // ✅ ensure fetch exists in serverless

// ✅ CORS helper (safe defaults)
// If you want to lock this down later, restrict origin to your Vercel domain.
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

module.exports = async function handler(req, res) {
  setCors(res);

  // ✅ Preflight
  if (req.method === "OPTIONS") return res.status(204).end();

  // ✅ Only POST
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return res.status(500).json({ error: "Server missing Supabase env vars" });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // ✅ Parse multipart form data
  const form = formidable({
    multiples: false,
    keepExtensions: true,
  });

  form.parse(req, async (err, fields, files) => {
    let tempPath = null;

    try {
      if (err) return res.status(400).json({ error: "Bad upload payload" });

      const token = Array.isArray(fields.token) ? fields.token[0] : fields.token;
      const status = Array.isArray(fields.status) ? fields.status[0] : fields.status;

      const file = Array.isArray(files.file) ? files.file[0] : files.file;

      if (!token) return res.status(400).json({ error: "Missing token" });
      if (!file?.filepath) return res.status(400).json({ error: "Missing file" });

      tempPath = file.filepath;

      // 1) Lookup token -> webhook url
      const { data: row, error: readErr } = await supabase
        .from("verification_tokens")
        .select("webhook_url, expires_at, used")
        .eq("token", token)
        .single();

      if (readErr || !row) return res.status(400).json({ error: "Invalid token" });
      if (row.used) return res.status(400).json({ error: "Token already used" });

      // 2) Expiry check (robust)
      if (row.expires_at) {
        const expMs = new Date(row.expires_at).getTime();
        if (Number.isFinite(expMs) && Date.now() > expMs) {
          return res.status(400).json({ error: "Token expired" });
        }
      }

      // 3) Send to Discord webhook
      const discordData = new FormData();

      // Discord webhooks accept either "content" directly or payload_json
      discordData.append(
        "payload_json",
        JSON.stringify({
          content: `🌿 **Verification**\n> Status: ${status || "UNKNOWN"}\n> Token: \`${token}\``,
        })
      );

      discordData.append("file", fs.createReadStream(tempPath), {
        filename: "stoney_verify.png",
        contentType: "image/png",
      });

      const discordRes = await fetch(row.webhook_url, {
        method: "POST",
        body: discordData,
        headers: discordData.getHeaders(),
      });

      if (!discordRes.ok) {
        const txt = await discordRes.text().catch(() => "");
        return res.status(502).json({
          error: "Discord rejected webhook",
          details: txt.slice(0, 300),
        });
      }

      // 4) Mark token used (harden against races)
      // Only update if used is still false
      const { error: updErr } = await supabase
        .from("verification_tokens")
        .update({ used: true })
        .eq("token", token)
        .eq("used", false);

      if (updErr) {
        // Not fatal for the user, but log it.
        console.error("Supabase update error:", updErr);
      }

      return res.status(200).json({ success: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Internal server error" });
    } finally {
      // Optional cleanup: remove temp file if it exists
      // (Not required but keeps things tidy.)
      if (tempPath) {
        fs.unlink(tempPath, () => {});
      }
    }
  });
};

// ✅ Important: let formidable parse multipart form data
module.exports.config = {
  api: { bodyParser: false },
};
