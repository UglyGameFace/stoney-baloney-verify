const { createClient } = require("@supabase/supabase-js");
const { formidable } = require("formidable"); // ✅ v3 correct import
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
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Method not allowed" });

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return res.status(500).json({ success: false, error: "Missing SUPABASE env vars" });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  const form = formidable({
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
          error: "Bad upload payload",
          details: String(err.message || err),
        });
      }

      const token = Array.isArray(fields.token) ? fields.token[0] : fields.token;
      const status = Array.isArray(fields.status) ? fields.status[0] : fields.status;
      const docType = Array.isArray(fields.doc_type) ? fields.doc_type[0] : fields.doc_type;

      const uploaded = Array.isArray(files.file) ? files.file[0] : files.file;

      if (!token) return res.status(400).json({ success: false, error: "Missing token" });
      if (!uploaded?.filepath) return res.status(400).json({ success: false, error: "Missing file" });

      tempPath = uploaded.filepath;

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

      const buf = fs.readFileSync(tempPath);
      const mime = uploaded.mimetype || "image/jpeg";
      const filename = "stoney_verify.jpg";

      // ✅ Post to the ticket webhook (this makes message.webhook_id exist)
      const payload = {
        username: "StoneyVerify",
        content: "🌿 **Verification Submission Received**\nStaff: check the image, then use the Approve/Reject panel.",
        embeds: [
          {
            title: "Stoney Verify Submission",
            description:
              `**AI Status:** ${status || "UNKNOWN"}` +
              `\n**Doc Type:** ${docType || "UNKNOWN"}` +
              `\n**Token:** \`${token}\``,
            image: { url: `attachment://${filename}` },
            footer: { text: `token: ${token}` }, // ✅ bot can extract even without message_content intent
            timestamp: new Date().toISOString(),
          },
        ],
        attachments: [{ id: 0, filename }],
      };

      const fd = new FormData();
      fd.append("payload_json", JSON.stringify(payload));
      fd.append("files[0]", new Blob([buf], { type: mime }), filename);

      const webhookRes = await fetch(`${row.webhook_url}?wait=true`, { method: "POST", body: fd });
      const webhookText = await webhookRes.text();

      if (!webhookRes.ok) {
        return res.status(502).json({
          success: false,
          error: "Discord webhook rejected message",
          status: webhookRes.status,
          details: webhookText.slice(0, 900),
        });
      }

      await supabase
        .from("verification_tokens")
        .update({
          submitted: true,
          submitted_at: new Date().toISOString(),
          ai_status: status || null,
          doc_type: docType || null,
        })
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
