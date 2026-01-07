const { createClient } = require("@supabase/supabase-js");
const formidable = require("formidable");
const fs = require("fs");

// Ensure fetch + FormData + Blob exist in runtime (Vercel/Node differences)
let fetchFn = global.fetch;
let FormDataCtor = global.FormData;
let BlobCtor = global.Blob;

try {
  const undici = require("undici");
  fetchFn = fetchFn || undici.fetch;
  FormDataCtor = FormDataCtor || undici.FormData;
  BlobCtor = BlobCtor || undici.Blob;
} catch (_) {}

// ---- CORS ----
function setCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
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
    return res
      .status(500)
      .json({ success: false, error: "Server missing Supabase env vars" });
  }

  if (!fetchFn || !FormDataCtor || !BlobCtor) {
    return res
      .status(500)
      .json({ success: false, error: "Server runtime missing fetch/FormData/Blob" });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

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

      // 2) Expiry
      if (row.expires_at) {
        const expMs = new Date(row.expires_at).getTime();
        if (Number.isFinite(expMs) && Date.now() > expMs) {
          return res.status(400).json({ success: false, error: "Token expired" });
        }
      }

      // 3) Read upload + build Discord multipart
      const buf = fs.readFileSync(tempPath);
      const mime = uploaded.mimetype || "image/jpeg";

      const fd = new FormDataCtor();
      const filename = "stoney_verify.jpg";

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
              footer: { text: `token: \`${token}\`` },
              timestamp: new Date().toISOString(),
            },
          ],
        })
      );

      fd.append("files[0]", new BlobCtor([buf], { type: mime }), filename);

      // Force wait=true so we can get a JSON response back (helps debugging)
      const webhookUrl =
        row.webhook_url.includes("?")
          ? `${row.webhook_url}&wait=true`
          : `${row.webhook_url}?wait=true`;

      const discordRes = await fetchFn(webhookUrl, { method: "POST", body: fd });

      if (!discordRes.ok) {
        const txt = await discordRes.text().catch(() => "");
        return res.status(502).json({
          success: false,
          error: "Discord rejected webhook",
          details: txt.slice(0, 500),
          status: discordRes.status,
        });
      }

      // Optional: read response to confirm attachments exist
      // (won't crash if not JSON)
      const discordBody = await discordRes.text().catch(() => "");
      // Uncomment if you want:
      // console.log("discord webhook response:", discordBody.slice(0, 500));

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
