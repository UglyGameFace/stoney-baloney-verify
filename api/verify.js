const { createClient } = require("@supabase/supabase-js");
const formidable = require("formidable");
const fs = require("fs");

// ---- CORS ----
function setCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function pickFirst(v) {
  return Array.isArray(v) ? v[0] : v;
}

function extFromMime(mime = "") {
  const m = String(mime).toLowerCase();
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  if (m.includes("png")) return "png";
  if (m.includes("webp")) return "webp";
  return "bin";
}

module.exports = async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Basic sanity check: must be multipart for uploads
  const ct = String(req.headers["content-type"] || "");
  if (!ct.toLowerCase().includes("multipart/form-data")) {
    return res.status(400).json({ error: "Expected multipart/form-data" });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return res.status(500).json({ error: "Server missing Supabase env vars" });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // IMPORTANT: size limits (Discord + sanity)
  // If your IDs are bigger than this, they should be compressed client-side (we already do).
  const form = formidable({
    multiples: false,
    keepExtensions: true,
    maxFileSize: 8 * 1024 * 1024, // 8MB
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

      const token = pickFirst(fields.token);
      const status = pickFirst(fields.status);

      // incoming field name from index.html is "file"
      const uploaded = pickFirst(files.file);

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
      if (!row.webhook_url) return res.status(500).json({ error: "Missing webhook_url for token" });

      // used === DECIDED (approve/deny), NOT uploaded
      if (row.used) return res.status(400).json({ error: "Token already decided" });

      // 2) Expiry
      if (row.expires_at) {
        const expMs = new Date(row.expires_at).getTime();
        if (Number.isFinite(expMs) && Date.now() > expMs) {
          return res.status(400).json({ error: "Token expired" });
        }
      }

      // 3) Read uploaded file from temp
      const buf = fs.readFileSync(tempPath);
      const mime = uploaded.mimetype || "application/octet-stream";

      // Guard: sometimes upload can be empty/corrupt
      if (!buf || buf.length < 100) {
        return res.status(400).json({ error: "Uploaded file looks empty/corrupt" });
      }

      // ✅ Node 18+/Vercel: FormData + Blob should exist globally
      if (typeof FormData === "undefined" || typeof Blob === "undefined") {
        return res.status(500).json({
          error: "Server runtime missing FormData/Blob. Ensure Vercel function is Node.js 18+ (not Edge).",
        });
      }

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
              footer: { text: `token: ${token}` },
              timestamp: new Date().toISOString(),
            },
          ],
        })
      );

      // ✅ Correct filename + extension based on mime (your index sends jpg now)
      const ext = extFromMime(mime);
      const filename = `stoney_verify.${ext}`;

      // ✅ Discord expects: files[0]
      fd.append("files[0]", new Blob([buf], { type: mime }), filename);

      const discordRes = await fetch(row.webhook_url, {
        method: "POST",
        body: fd,
        // DO NOT set Content-Type manually; fetch will set multipart boundary
      });

      const discordText = await discordRes.text().catch(() => "");

      if (!discordRes.ok) {
        return res.status(502).json({
          error: "Discord rejected webhook",
          status: discordRes.status,
          details: discordText.slice(0, 600),
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
