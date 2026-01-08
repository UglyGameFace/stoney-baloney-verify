const { createClient } = require("@supabase/supabase-js");
const { formidable } = require("formidable");
const fs = require("fs");
const https = require("https");
const FormData = require("form-data");

function setCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function readStreamBody(stream) {
  return new Promise((resolve) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

async function formGetLength(fd) {
  return new Promise((resolve, reject) => {
    fd.getLength((err, len) => (err ? reject(err) : resolve(len)));
  });
}

async function postWebhook(url, fd) {
  const u = new URL(url);
  const len = await formGetLength(fd);
  const opts = {
    method: "POST",
    hostname: u.hostname,
    path: u.pathname + (u.search || ""),
    headers: { ...fd.getHeaders(), "Content-Length": len },
    timeout: 20000,
  };
  return new Promise((resolve, reject) => {
    const req = https.request(opts, async (resp) => {
      const body = await readStreamBody(resp);
      resolve({ status: resp.statusCode || 0, body });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Webhook timeout")));
    fd.pipe(req);
  });
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")
    return res.status(405).json({ success: false, error: "Method not allowed" });

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey)
    return res
      .status(500)
      .json({ success: false, error: "Missing Supabase env vars" });

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  const form = formidable({
    multiples: false,
    keepExtensions: true,
    maxFileSize: 4 * 1024 * 1024,
  });

  form.parse(req, async (err, fields, files) => {
    let temp = null;
    try {
      if (err)
        return res
          .status(400)
          .json({ success: false, error: "Form parse error", details: err });

      const token = Array.isArray(fields.token) ? fields.token[0] : fields.token;
      const status = Array.isArray(fields.status)
        ? fields.status[0]
        : fields.status;
      const uploaded = Array.isArray(files.file) ? files.file[0] : files.file;

      if (!token) return res.status(400).json({ success: false, error: "Missing token" });
      if (!uploaded?.filepath)
        return res.status(400).json({ success: false, error: "Missing file" });

      temp = uploaded.filepath;

      const { data: row, error: readErr } = await supabase
        .from("verification_tokens")
        .select("webhook_url, expires_at, used, user_id")
        .eq("token", token)
        .single();

      if (readErr || !row)
        return res.status(400).json({ success: false, error: "Invalid token" });
      if (row.used)
        return res.status(400).json({ success: false, error: "Token already used" });

      if (row.expires_at && Date.now() > new Date(row.expires_at).getTime())
        return res.status(400).json({ success: false, error: "Token expired" });

      const buf = fs.readFileSync(temp);
      const fd = new FormData();
      const filename = "stoney_verify.jpg";
      const payload = {
        username: "StoneyVerify",
        content:
          "🌿 **Verification Submission Received**\n" +
          (row.user_id ? `User: <@${row.user_id}>\n` : "") +
          `AI: ${status || "UNKNOWN"}\n` +
          `token: ${token}\nStaff: check the image, then use the Approve/Reject panel.`,
        embeds: [
          {
            title: "Stoney Verify Submission",
            description: `AI Status: ${status || "UNKNOWN"}\nToken: ${token}`,
            image: { url: `attachment://${filename}` },
            footer: { text: `token: ${token}` },
            timestamp: new Date().toISOString(),
          },
        ],
        attachments: [{ id: 0, filename }],
      };

      fd.append("payload_json", JSON.stringify(payload));
      fd.append("files[0]", buf, { filename, contentType: uploaded.mimetype });

      const webhookRes = await postWebhook(`${row.webhook_url}?wait=true`, fd);
      if (webhookRes.status < 200 || webhookRes.status >= 300)
        return res.status(502).json({
          success: false,
          error: "Webhook post failed",
          status: webhookRes.status,
          details: webhookRes.body.slice(0, 900),
        });

      await supabase
        .from("verification_tokens")
        .update({
          submitted: true,
          submitted_at: new Date().toISOString(),
          ai_status: status || null,
        })
        .eq("token", token);

      return res.status(200).json({ success: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ success: false, error: e.message });
    } finally {
      if (temp) fs.unlink(temp, () => {});
    }
  });
};

module.exports.config = { api: { bodyParser: false } };
