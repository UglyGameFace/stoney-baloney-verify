const crypto = require("crypto");
const https = require("https");
const { createClient } = require("@supabase/supabase-js");

function readRaw(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function discordPublicKeyToKeyObject(hexKey) {
  // SPKI DER prefix for Ed25519 public key
  const der = Buffer.from("302a300506032b6570032100" + hexKey, "hex");
  return crypto.createPublicKey({ key: der, format: "der", type: "spki" });
}

function verifyDiscordSignature({ publicKeyHex, signatureHex, timestamp, rawBody }) {
  const keyObj = discordPublicKeyToKeyObject(publicKeyHex);
  const msg = Buffer.from(timestamp + rawBody);
  const sig = Buffer.from(signatureHex, "hex");
  return crypto.verify(null, msg, keyObj, sig);
}

function discordPut(botToken, path) {
  const options = {
    method: "PUT",
    hostname: "discord.com",
    path: `/api/v10${path}`,
    headers: { Authorization: `Bot ${botToken}`, "Content-Length": "0" },
    timeout: 15000,
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (resp) => {
      // 204 is success for role add
      resolve(resp.statusCode || 0);
    });
    req.on("timeout", () => req.destroy(new Error("Discord timeout")));
    req.on("error", reject);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY; // from Discord Dev Portal
  const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
  const VERIFIED_ROLE_ID = process.env.DISCORD_VERIFIED_ROLE_ID;
  const RESIDENT_ROLE_ID = process.env.DISCORD_RESIDENT_ROLE_ID;

  // comma-separated staff roles: "123,456"
  const STAFF_ROLE_IDS = (process.env.DISCORD_STAFF_ROLE_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!PUBLIC_KEY || !BOT_TOKEN || !VERIFIED_ROLE_ID || !RESIDENT_ROLE_ID || STAFF_ROLE_IDS.length === 0) {
    return res.status(500).json({ error: "Missing Discord env vars (PUBLIC_KEY/BOT_TOKEN/ROLE_IDS/STAFF_ROLE_IDS)" });
  }
  if (!supabaseUrl || !serviceRoleKey) return res.status(500).json({ error: "Missing Supabase env vars" });

  const rawBody = await readRaw(req);
  const sig = req.headers["x-signature-ed25519"];
  const ts = req.headers["x-signature-timestamp"];

  if (!sig || !ts) return res.status(401).send("Missing signature headers");

  const ok = verifyDiscordSignature({
    publicKeyHex: PUBLIC_KEY,
    signatureHex: String(sig),
    timestamp: String(ts),
    rawBody,
  });
  if (!ok) return res.status(401).send("Bad signature");

  const body = JSON.parse(rawBody);

  // Ping/Pong
  if (body.type === 1) return res.status(200).json({ type: 1 });

  // Button interaction
  if (body.type !== 3) return res.status(200).json({ type: 6 });

  const customId = body.data?.custom_id || "";
  const [ns, action, token] = customId.split(":");
  if (ns !== "verify" || !action || !token) {
    return res.status(200).json({
      type: 4,
      data: { content: "Invalid button payload.", flags: 64 },
    });
  }

  const clickerRoles = body.member?.roles || [];
  const isStaff = clickerRoles.some((r) => STAFF_ROLE_IDS.includes(r));

  if (!isStaff) {
    return res.status(200).json({
      type: 4,
      data: { content: "❌ You are not allowed to do that.", flags: 64 },
    });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  const { data: row } = await supabase
    .from("verification_tokens")
    .select("user_id, used")
    .eq("token", token)
    .single();

  if (!row?.user_id) {
    return res.status(200).json({ type: 4, data: { content: "Token not found.", flags: 64 } });
  }
  if (row.used) {
    return res.status(200).json({ type: 4, data: { content: "Already decided.", flags: 64 } });
  }

  const guildId = body.guild_id;
  const userId = row.user_id;
  const staffId = body.member?.user?.id;

  if (action === "approve") {
    // ✅ Assign roles
    const s1 = await discordPut(BOT_TOKEN, `/guilds/${guildId}/members/${userId}/roles/${VERIFIED_ROLE_ID}`);
    const s2 = await discordPut(BOT_TOKEN, `/guilds/${guildId}/members/${userId}/roles/${RESIDENT_ROLE_ID}`);

    if (![200, 201, 204].includes(s1) || ![200, 201, 204].includes(s2)) {
      return res.status(200).json({
        type: 4,
        data: { content: `Role assignment failed (codes: ${s1}, ${s2}). Check bot perms/role hierarchy.`, flags: 64 },
      });
    }

    await supabase
      .from("verification_tokens")
      .update({ used: true, decision: "approved", decided_at: new Date().toISOString(), decided_by: staffId })
      .eq("token", token);

    // Update message + disable buttons
    return res.status(200).json({
      type: 7,
      data: {
        content: `✅ **APPROVED** by <@${staffId}> — roles granted to <@${userId}>`,
        components: [
          {
            type: 1,
            components: [
              { type: 2, style: 3, label: "APPROVE", custom_id: `verify:approve:${token}`, disabled: true },
              { type: 2, style: 4, label: "DENY", custom_id: `verify:deny:${token}`, disabled: true },
            ],
          },
        ],
      },
    });
  }

  if (action === "deny") {
    await supabase
      .from("verification_tokens")
      .update({ used: true, decision: "denied", decided_at: new Date().toISOString(), decided_by: staffId })
      .eq("token", token);

    return res.status(200).json({
      type: 7,
      data: {
        content: `⛔ **DENIED** by <@${staffId}>`,
        components: [
          {
            type: 1,
            components: [
              { type: 2, style: 3, label: "APPROVE", custom_id: `verify:approve:${token}`, disabled: true },
              { type: 2, style: 4, label: "DENY", custom_id: `verify:deny:${token}`, disabled: true },
            ],
          },
        ],
      },
    });
  }

  return res.status(200).json({ type: 4, data: { content: "Unknown action.", flags: 64 } });
};

module.exports.config = { api: { bodyParser: false } };
