const { createClient } = require("@supabase/supabase-js");
const formidable = require("formidable");
const fs = require("fs");
const FormData = require("form-data");

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

  // NOTE: add limits so mobile photos don't explode the function
  const form = formidable({
    multiples: false,
    keepExtensions: true,
    maxFileSize: 8 * 1024 * 1024, // 8MB
    allowEmptyFiles: false,
  });

  form.parse(req, async (err, fields, files) => {
    let tempPath = null;

    try {
      if (err) {
        return res.status(400).json({
          error: "Bad upload payload",
          details: String(err?.message || err),
        });
      }

      const token = Array.isArray(fields.token) ? fields.token[0] : fields.token;
      const status = Array.isArray(fields.status) ? fields.status[0] : fields.status;

      const uploaded = Array.isArray(files.file) ? files.file[0] : files.file;

      if (!token) return res.status(400).json({ error: "Missing token" });
      if (!uploaded?.filepath) return res.status(400).json({ error: "Missing file" });

      tempPath = uploaded.filepath;

      // Basic file sanity
      const mime = uploaded.mimetype || "image/png";
      if (!mime.startsWith("image/")) {
        return res.status(400).json({ error: "File must be an image", details: mime });
      }

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

      if (!row.webhook_url) {
        return res.status(500).json({ error: "Token row missing webhook_url" });
      }

      // 3) Build multipart for Discord webhook (ROBUST)
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
                "Staff: use the Approve/Reject buttons inside the ticket.",
              footer: { text: `token: \`${token}\`` },
              timestamp: new Date().toISOString(),
            },
          ],
        })
      );

      // Discord wants files[0]
      fd.append("files[0]", fs.createReadStream(tempPath), {
        filename: "stoney_verify.png",
        contentType: mime,
      });

      const discordRes = await fetch(row.webhook_url, {
        method: "POST",
        headers: fd.getHeaders(), // ✅ IMPORTANT: sets boundary
        body: fd,
      });

      const discordText = await discordRes.text().catch(() => "");

      if (!discordRes.ok) {
        return res.status(502).json({
          error: "Discord rejected webhook",
          details: discordText.slice(0, 700),
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
      return res.status(500).json({
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
