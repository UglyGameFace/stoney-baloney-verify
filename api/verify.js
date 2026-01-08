"use strict";

const { createClient } = require("@supabase/supabase-js");
const formidable = require("formidable");
const fs = require("fs");

// ---- Runtime helpers (Node/Vercel) ----
let undici = null;
try {
  undici = require("undici");
} catch (_) {}

const fetchFn = global.fetch || undici?.fetch;
const FormDataCtor = global.FormData || undici?.FormData;
const BlobCtor = global.Blob || undici?.Blob;

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

  // If fetch/FormData/Blob aren't available, the function will crash later.
  // Return a clean error instead.
  if (!fetchFn || !FormDataCtor || !BlobCtor) {
    return res.status(500).json({
      success: false,
      error: "Server runtime missing fetch/FormData/Blob. Ensure Node runtime is 18+ on Vercel.",
    });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return res.status(500).json({ success: false, error: "Server missing Supabase env vars" });
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
      if (!uploaded) return res.status(400).json({ success: false, error: "Missing file" });

      // Formidable v3 uses `filepath`. Older configs used `path`.
      tempPath = uploaded.filepath || uploaded.path || null;
      if (!tempPath) return res.status(400).json({ success: false, error: "Missing uploaded file path" });

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

      // 3) Build Discord multipart (THIS is what makes the image show in the embed)
      const buf = fs.readFileSync(tempPath);
      const mime = uploaded.mimetype || "image/jpeg";

      const filename = "stoney_verify.jpg";
      const fd = new FormDataCtor();

      fd.append(
        "payload_json",
        JSON.stringify({
          content: "🌿 **Verification Submission Received**",
          allowed_mentions: { parse: [] },
          attachments: [{ id: 0, filename, description: "User upload" }],
          embeds: [
            {
              title: "Stoney Verify Submission",
              description:
                `**Status:** ${status || "UNKNOWN"}\n` +
                `**Token:** \`${token}\`\n\n` +
                "Staff: use the Approve/Reject buttons inside the ticket.",
              image: { url: `attachment://${filename}` },
              footer: { text: `token: ${token}` },
              timestamp: new Date().toISOString(),
            },
          ],
        })
      );

      fd.append("files[0]", new BlobCtor([buf], { type: mime }), filename);

      const discordRes = await fetchFn(row.webhook_url, { method: "POST", body: fd });

      if (!discordRes.ok) {
        const txt = await discordRes.text().catch(() => "");
        return res.status(502).json({
          success: false,
          error: "Discord rejected webhook",
          status: discordRes.status,
          details: txt.slice(0, 900),
        });
      }

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

// Next.js API routes need this to allow formidable
module.exports.config = {
  api: { bodyParser: false },
};
