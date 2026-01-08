import { createClient } from "@supabase/supabase-js";
import formidable from "formidable";
import fs from "node:fs/promises";

export const config = {
  api: { bodyParser: false },
};

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

async function getFormDataAndBlob() {
  // Prefer native (Node 18/20 on Vercel has these)
  let FormDataCtor = globalThis.FormData;
  let BlobCtor = globalThis.Blob;

  // Fallback to undici if needed
  if (!FormDataCtor || !BlobCtor) {
    try {
      const undici = await import("undici");
      FormDataCtor = FormDataCtor || undici.FormData;
      BlobCtor = BlobCtor || undici.Blob;
    } catch (_) {}
  }

  // Last fallback for Blob (rare)
  if (!BlobCtor) {
    try {
      const buf = await import("buffer");
      BlobCtor = buf.Blob;
    } catch (_) {}
  }

  return { FormDataCtor, BlobCtor };
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Method not allowed" });

  try {
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

    const { fields, files } = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => {
        if (err) reject(err);
        else resolve({ fields, files });
      });
    });

    const token = Array.isArray(fields.token) ? fields.token[0] : fields.token;
    const status = Array.isArray(fields.status) ? fields.status[0] : fields.status;
    const uploaded = Array.isArray(files.file) ? files.file[0] : files.file;

    if (!token) return res.status(400).json({ success: false, error: "Missing token" });
    if (!uploaded?.filepath) return res.status(400).json({ success: false, error: "Missing file" });

    if (uploaded.size && uploaded.size > 4 * 1024 * 1024) {
      return res.status(413).json({ success: false, error: "File too large (max 4MB)" });
    }

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

    const { FormDataCtor, BlobCtor } = await getFormDataAndBlob();
    if (!FormDataCtor || !BlobCtor) {
      return res.status(500).json({ success: false, error: "Server runtime missing FormData/Blob (need Node 18+)" });
    }

    const buf = await fs.readFile(uploaded.filepath);
    const mime = uploaded.mimetype || "image/jpeg";
    const filename = "stoney_verify.jpg";

    const fd = new FormDataCtor();

    fd.append(
      "payload_json",
      JSON.stringify({
        content: "🌿 **Verification Submission Received**",
        attachments: [{ id: 0, filename }],
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
        allowed_mentions: { parse: [] },
      })
    );

    fd.append("files[0]", new BlobCtor([buf], { type: mime }), filename);

    const discordRes = await fetch(row.webhook_url, { method: "POST", body: fd });

    if (!discordRes.ok) {
      const txt = await discordRes.text().catch(() => "");
      return res.status(502).json({
        success: false,
        error: "Discord rejected webhook",
        status: discordRes.status,
        details: txt.slice(0, 800),
      });
    }

    // Optional logging (won't break if columns don't exist)
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
    // This prevents Vercel's generic FUNCTION_INVOCATION_FAILED from being the only thing you see
    console.error("verify api error:", e);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
      details: String(e?.message || e),
    });
  }
}
