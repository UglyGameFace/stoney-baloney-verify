const { createClient } = require("@supabase/supabase-js");
const formidable = require("formidable");
const fs = require("fs");

function setCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

module.exports = async function handler(req, res) {
  setCors(req, res);

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

  // IMPORTANT on serverless: use /tmp
  const form = formidable({
    multiples: false,
    keepExtensions: true,
    uploadDir: "/tmp",
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

      // 1) Lookup token
      const { data: row, error: readErr } = await supabase
        .from("verification_tokens")
        .select("webhook_url, expires_at, used")
        .eq("token", token)
        .single();

      if (readErr || !row) return res.status(400).json({ error: "Invalid token" });
      if (row.used) return res.status(400).json({ error: "Token already decided" });

      // 2) Expiry check
      if (row.expires_at) {
        const expMs = new Date(row.expires_at).getTime();
        if (Number.isFinite(expMs) && Date.now() > expMs) {
          return res.status(400).json({ error: "Token expired" });
        }
      }

      // 3) Read file into memory (native fetch + native FormData needs Blob/ArrayBuffer)
      const buf = fs.readFileSync(tempPath);

      // If formidable provides mimetype, use it; fallback to png
      const mime = file.mimetype || "image/png";
      const filename = file.originalFilename || "stoney_verify.png";

      // 4) Send to Discord webhook using NATIVE FormData + Blob
      const fd = new FormData();

      fd.append(
        "payload_json",
        JSON.stringify({
          content: "🌿 **Verification Submission Received**",
          embeds: [
            {
              title: "Stoney Verify Submission",
              description:
                `**Status:** ${status || "UNKNOWN"}\n` +
                `**Token:** \`${token}\`\n\n` +
                "Staff: use the Approve/Reject buttons in the ticket.",
              footer: { text: `token: \`${token}\`` },
              timestamp: new Date().toISOString(),
            },
          ],
        })
      );

      // Blob is what makes the attachment actually work with native fetch
      fd.append("file", new Blob([buf], { type: mime }), filename);

      const discordRes = await fetch(row.webhook_url, {
        method: "POST",
        body: fd,
      });

      if (!discordRes.ok) {
        const txt = await discordRes.text().catch(() => "");
        return res.status(502).json({
          error: "Discord rejected webhook",
          status: discordRes.status,
          details: txt.slice(0, 500),
        });
      }

      // 5) Optional submission logging (DO NOT set used=true here)
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
      console.error("verify.js error:", e);
      return res.status(500).json({ error: "Internal server error" });
    } finally {
      if (tempPath) fs.unlink(tempPath, () => {});
    }
  });
};

module.exports.config = {
  api: { bodyParser: false },
};
