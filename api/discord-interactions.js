// api/interactions.js
const crypto = require("crypto");
const https = require("https");
const { createClient } = require("@supabase/supabase-js");

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Discord public key (hex 32 bytes) -> SPKI DER for ed25519
function discordPublicKeyToKeyObject(hexKey) {
  const raw = Buffer.from(hexKey, "hex");
  if (raw.length !== 32) throw new Error("DISCORD_PUBLIC_KEY must be 32-byte hex");
  const prefix = Buffer.from("302a300506032b6570032100", "hex"); // ASN.1 header for ed25519
  const spki = Buffer.concat([prefix, raw]);
  return crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
}

function verifyDiscordSignature({ publicKeyHex, signatureHex, timestamp, rawBody }) {
  const keyObj = discordPublicKeyToKeyObject(publicKeyHex);
  const sig = Buffer.from(signatureHex, "hex");
  const msg = Buffer.concat([Buffer.from(timestamp, "utf8"), rawBody]);
  return crypto.verify(null, msg, keyObj, sig);
}

function discordReq(method, path, botToken) {
  const opts = {
    method,
    hostname: "discord.com",
    path: `/api/v10${path}`,
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
      "Content-Length": 0,
    },
    timeout: 15000,
  };

  return new Promise((resolve, reject) => {
    const req = https.request(opts, (resp) => {
      const chunks = [];
      resp.on("data", (c) => chunks.push(c));
      resp.on("end", () => {
        resolve({
          status: resp.statusCode || 0,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("timeout", () => req.destroy(new Error("Discord API timeout")));
    req.on("error", reject);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  const publicKey = process.env.DISCORD_PUBLIC_KEY;
  const botToken = process.env.DISCORD_BOT_TOKEN;

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const verifiedRoleId = process.env.DISCORD_VERIFIED_ROLE_ID;
  const residentRoleId = process.env.DISCORD_RESIDENT_ROLE_ID;

  const staffRoleIds = (process.env.DISCORD_STAFF_ROLE_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!publicKey) return res.status(500).send("Missing DISCORD_PUBLIC_KEY");
  if (!botToken) return res.status(500).send("Missing DISCORD_BOT_TOKEN");
  if (!supabaseUrl || !serviceRoleKey) return res.status(500).send("Missing Supabase env vars");
  if (!verifiedRoleId || !residentRoleId) return res.status(500).send("Missing role env vars");
  if (!staffRoleIds.length) return res.status(500).send("Missing DISCORD_STAFF_ROLE_IDS");

  const sig = req.headers["x-signature-ed25519"];
  const ts = req.headers["x-signature-timestamp"];
  if (!sig || !ts) return res.status(401).send("Missing signature headers");

  const rawBody = await readRawBody(req);

  const ok = verifyDiscordSignature({
    publicKeyHex: publicKey,
    signatureHex: sig,
    timestamp: ts,
    rawBody,
  });
  if (!ok) return res.status(401).send("Bad signature");

  const interaction = JSON.parse(rawBody.toString("utf8"));

  // PING from Discord to validate endpoint
  if (interaction.type === 1) {
    return res.status(200).json({ type: 1 });
  }

  // Only handle button interactions
  if (interaction.type !== 3) {
    return res.status(200).json({ type: 4, data: { content: "Unhandled interaction type.", flags: 64 } });
  }

  const customId = interaction.data?.custom_id || "";
  const parts = customId.split(":"); // verify:approve:TOKEN
  if (parts.length !== 3 || parts[0] !== "verify") {
    return res.status(200).json({ type: 4, data: { content: "Invalid button.", flags: 64 } });
  }

  const action = parts[1]; // approve | deny
  const token = parts[2];

  // Staff gate
  const clickerRoles = interaction.member?.roles || [];
  const isStaff = clickerRoles.some((r) => staffRoleIds.includes(r));
  if (!isStaff) {
    return res.status(200).json({ type: 4, data: { content: "❌ You are not allowed to do that.", flags: 64 } });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  const { data: row, error: readErr } = await supabase
    .from("verification_tokens")
    .select("token, user_id, used")
    .eq("token", token)
    .single();

  if (readErr || !row) {
    return res.status(200).json({ type: 4, data: { content: "Token not found.", flags: 64 } });
  }
  if (row.used) {
    return res.status(200).json({ type: 4, data: { content: "Already decided.", flags: 64 } });
  }

  const guildId = interaction.guild_id;
  const userId = row.user_id;

  try {
    if (action === "approve") {
      // ✅ grant roles
      const [r1, r2] = await Promise.all([
        discordReq("PUT", `/guilds/${guildId}/members/${userId}/roles/${verifiedRoleId}`, botToken),
        discordReq("PUT", `/guilds/${guildId}/members/${userId}/roles/${residentRoleId}`, botToken),
      ]);

      if (r1.status < 200 || r1.status >= 300) throw new Error(`Role add failed (verified): ${r1.body}`);
      if (r2.status < 200 || r2.status >= 300) throw new Error(`Role add failed (resident): ${r2.body}`);

      await supabase
        .from("verification_tokens")
        .update({
          used: true,
          decision: "approved",
          decided_at: new Date().toISOString(),
          decided_by: interaction.member?.user?.id || null,
        })
        .eq("token", token);

      return res.status(200).json({
        type: 7,
        data: {
          content: `✅ **APPROVED** by <@${interaction.member.user.id}> — roles granted to <@${userId}>`,
          embeds: interaction.message?.embeds || [],
          components: [
            {
              type: 1,
              components: [
                { type: 2, style: 3, label: "APPROVED", custom_id: "noop_a", disabled: true },
                { type: 2, style: 4, label: "DENY", custom_id: "noop_d", disabled: true },
              ],
            },
          ],
        },
      });
    }

    if (action === "deny") {
      await supabase
        .from("verification_tokens")
        .update({
          used: true,
          decision: "denied",
          decided_at: new Date().toISOString(),
          decided_by: interaction.member?.user?.id || null,
        })
        .eq("token", token);

      return res.status(200).json({
        type: 7,
        data: {
          content: `❌ **DENIED** by <@${interaction.member.user.id}> — user: <@${userId}>`,
          embeds: interaction.message?.embeds || [],
          components: [
            {
              type: 1,
              components: [
                { type: 2, style: 3, label: "APPROVE", custom_id: "noop_a", disabled: true },
                { type: 2, style: 4, label: "DENIED", custom_id: "noop_d", disabled: true },
              ],
            },
          ],
        },
      });
    }

    return res.status(200).json({ type: 4, data: { content: "Unknown action.", flags: 64 } });
  } catch (e) {
    return res.status(200).json({
      type: 4,
      data: { content: `❌ Error: ${String(e.message || e).slice(0, 1800)}`, flags: 64 },
    });
  }
};

module.exports.config = { api: { bodyParser: false } };
