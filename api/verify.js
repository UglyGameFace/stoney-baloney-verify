const { createClient } = require("@supabase/supabase-js");
const formidable = require("formidable");
const FormData = require("form-data");
const fs = require("fs");
const fetch = require("node-fetch");

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return res.status(500).json({ error: "Server missing Supabase env vars" });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const form = formidable({ multiples: false, keepExtensions: true });

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

      const { data: row, error: readErr } = await supabase
        .from("verification_tokens")
        .select("webhook_url, expires_at, used")
        .eq("token", token)
        .single();

      if (readErr || !row) return res.status(400).json({ error: "Invalid token" });
      if (row.used) return res.status(400).json({ error: "Token already used" });

      if (row.expires_at) {
        const expMs = new Date(row.expires_at).getTime();
        if (Number.isFinite(expMs) && Date.now() > expMs) {
          return res.status(400).json({ error: "Token expired" });
        }
      }

      // 1) Post the image
      const imgData = new FormData();
      imgData.append(
        "payload_json",
        JSON.stringify({
          content:
            `🌿 **Verification Upload Received**\n` +
            `> Status: ${status || "UNKNOWN"}\n` +
            `> Token: \`${token}\`\n\n` +
            `Staff: please review the image below.`,
        })
      );

      imgData.append("file", fs.createReadStream(tempPath), {
        filename: "stoney_verify.png",
        contentType: "image/png",
      });

      const discordRes = await fetch(row.webhook_url, {
        method: "POST",
        body: imgData,
        headers: imgData.getHeaders(),
      });

      if (!discordRes.ok) {
        const txt = await discordRes.text().catch(() => "");
        return res.status(502).json({ error: "Discord rejected webhook", details: txt.slice(0, 300) });
      }

      // 2) Post a separate “Submission” message that staff reacts to
      // This is what your Discloud bot watches for.
      const decisionData = new FormData();
      decisionData.append(
        "payload_json",
        JSON.stringify({
          content:
            `🧾 **Verification Submission (STAFF ACTION REQUIRED)**\n` +
            `React ✅ to **APPROVE** (grants Resident + Verified)\n` +
            `React ❌ to **DENY**\n\n` +
            `Token: \`${token}\``,
        })
      );

      const decisionRes = await fetch(row.webhook_url, {
        method: "POST",
        body: decisionData,
        headers: decisionData.getHeaders(),
      });

      if (!decisionRes.ok) {
        const txt = await decisionRes.text().catch(() => "");
        return res.status(502).json({ error: "Discord rejected decision message", details: txt.slice(0, 300) });
      }

      // IMPORTANT: we do NOT mark "used" here.
      // Token gets closed ONLY when staff approves/denies via the bot.

      return res.status(200).json({ success: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Internal server error" });
    } finally {
      if (tempPath) fs.unlink(tempPath, () => {});
    }
  });
};

module.exports.config = {
  api: { bodyParser: false },
};
