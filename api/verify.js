const { createClient } = require("@supabase/supabase-js");
const formidable = require("formidable");
const fs = require("fs");

// ---- CORS ----
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

  const form = formidable({ multiples: false, keepExtensions: true });

  form.parse(req, async (err, fields, files) => {
    let tempPath = null;

    try {
      if (err) return res.status(400).json({ error: "Bad upload payload" });

      const token = Array.isArray(fields.token) ? fields.token[0] : fields.token;
      const status = Array.isArray(fields.status) ? fields.status[0] : fields.status;

      const uploaded = Array.isArray(files.file) ? files.file[0] : files.file;

      if (!token) return res.status(400).json({ error: "Missing token" });
      if (!uploaded?.filepath) return res.status(400).json({ error: "Missing file" });

      tempPath = uploaded.filepath;

      // 1) Lookup token
      const { data: row, error: readErr } = await supabase
        .from("verification_tokens")
        .select("webhook_url, expires_at, used")
        .eq("token", token)
        .single();

      if (readErr || !row) return res.status(400).json({ error: "Invalid token" });

      // used === DECIDED (approve/deny), NOT uploaded
      if (row.used) return res.status(400).json({ error: "Token already decided" });

      // 2) Expiry
      if (row.expires_at) {
        const expMs = new Date(row.expires_at).getTime();
        if (Number.isFinite(expMs) && Date.now() > expMs) {
          return res.status(400).json({ error: "Token expired" });
        }
      }

      // 3) Build multipart using *native* FormData + Blob
      const buf = fs.readFileSync(tempPath);
      const mime = uploaded.mimetype || "image/png";

      const fd = new FormData();

      // Content + embed (token in embed footer so your bot can parse without message-content intent)
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
                "Staff: use the Approve/Reject buttons inside the ticket.",
              footer: { text: `token: \`${token}\`` },
              timestamp: new Date().toISOString(),
            },
          ],
        })
      );

      // ✅ Discord expects: files[0]
      fd.append("files[0]", new Blob([buf], { type: mime }), "stoney_verify.png");

      // Post to Discord webhook
      const discordRes = await fetch(row.webhook_url, {
        method: "POST",
        body: fd,
        // IMPORTANT: do NOT set Content-Type manually; fetch sets boundary
      });

      if (!discordRes.ok) {
        const txt = await discordRes.text().catch(() => "");
        return res.status(502).json({
          error: "Discord rejected webhook",
          details: txt.slice(0, 300),
        });
      }

      // 4) Optional logging (safe-ignore if columns don’t exist)
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
      return res.status(500).json({ error: "Internal server error" });
    } finally {
      if (tempPath) fs.unlink(tempPath, () => {});
    }
  });
};

module.exports.config = {
  api: { bodyParser: false },
};
