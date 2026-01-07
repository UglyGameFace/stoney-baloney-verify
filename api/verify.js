const { createClient } = require("@supabase/supabase-js");
const formidable = require("formidable");
const FormData = require("form-data");
const fs = require("fs");

// ✅ Ensure fetch exists everywhere (Vercel usually has it, but this prevents surprises)
let fetchFn = global.fetch;
try {
  if (!fetchFn) fetchFn = require("node-fetch");
} catch (_) {
  // if node-fetch isn't installed, and global fetch doesn't exist, you'll get a clear error below
}

// ---- CORS (safe defaults for now) ----
function setCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

module.exports = async function handler(req, res) {
  setCors(req, res);

  // Preflight
  if (req.method === "OPTIONS") return res.status(204).end();

  // Only POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return res.status(500).json({ error: "Server missing Supabase env vars" });
  }

  if (!fetchFn) {
    return res.status(500).json({
      error: "Server missing fetch()",
      details: "Install node-fetch or use a runtime that provides global fetch.",
    });
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

      // 1) Lookup token
      const { data: row, error: readErr } = await supabase
        .from("verification_tokens")
        .select("webhook_url, expires_at, used")
        .eq("token", token)
        .single();

      if (readErr || !row) return res.status(400).json({ error: "Invalid token" });

      // IMPORTANT: used=true means DECIDED (approve/deny) not uploaded
      if (row.used) return res.status(400).json({ error: "Token already decided" });

      // 2) Expiry check
      if (row.expires_at) {
        const expMs = new Date(row.expires_at).getTime();
        if (Number.isFinite(expMs) && Date.now() > expMs) {
          return res.status(400).json({ error: "Token expired" });
        }
      }

      // 3) Send to Discord webhook
      const discordData = new FormData();

      // ✅ Token is in EMBED footer + description using exact format your Python regex matches: token: `...`
      discordData.append(
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

      discordData.append("file", fs.createReadStream(tempPath), {
        filename: "stoney_verify.png",
        contentType: "image/png",
      });

      const discordRes = await fetchFn(row.webhook_url, {
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

      // 4) Optional submission logging (DO NOT mark used=true here)
      // This will only work if those columns exist.
      try {
        await supabase
          .from("verification_tokens")
          .update({
            submitted: true,
            submitted_at: new Date().toISOString(),
            ai_status: status || null,
          })
          .eq("token", token);
      } catch (_) {
        // ignore schema mismatch
      }

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
