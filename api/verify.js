const { createClient } = require("@supabase/supabase-js");
const formidable = require("formidable");
const FormData = require("form-data");
const fs = require("fs");

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const form = formidable({ multiples: false });

  form.parse(req, async (err, fields, files) => {
    try {
      if (err) return res.status(400).json({ error: "Bad upload payload" });

      const token = Array.isArray(fields.token) ? fields.token[0] : fields.token;
      const status = Array.isArray(fields.status) ? fields.status[0] : fields.status;
      const file = Array.isArray(files.file) ? files.file[0] : files.file;

      if (!token) return res.status(400).json({ error: "Missing token" });
      if (!file?.filepath) return res.status(400).json({ error: "Missing file" });

      const supabaseUrl = process.env.SUPABASE_URL;
      const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

      if (!supabaseUrl || !serviceRoleKey) {
        return res.status(500).json({ error: "Server missing Supabase env vars" });
      }

      const supabase = createClient(supabaseUrl, serviceRoleKey, {
        auth: { persistSession: false },
      });

      // Lookup token -> webhook url
      const { data: row, error: readErr } = await supabase
        .from("verification_tokens")
        .select("webhook_url, expires_at, used")
        .eq("token", token)
        .single();

      if (readErr || !row) return res.status(400).json({ error: "Invalid token" });
      if (row.used) return res.status(400).json({ error: "Token already used" });

      const expMs = new Date(row.expires_at).getTime();
      if (Number.isFinite(expMs) && Date.now() > expMs) {
        return res.status(400).json({ error: "Token expired" });
      }

      // Send to Discord webhook
      const discordData = new FormData();
      discordData.append(
        "payload_json",
        JSON.stringify({
          content: `🌿 **Verification**\n> Status: ${status || "UNKNOWN"}`,
        })
      );

      discordData.append("file", fs.createReadStream(file.filepath), {
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
        return res.status(502).json({ error: "Discord rejected webhook", details: txt.slice(0, 300) });
      }

      // Mark token used
      await supabase.from("verification_tokens").update({ used: true }).eq("token", token);

      return res.status(200).json({ success: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Internal server error" });
    }
  });
};

// Important: let formidable parse multipart form data
module.exports.config = {
  api: { bodyParser: false },
};
