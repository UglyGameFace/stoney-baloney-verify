import os
import re
import secrets
from datetime import datetime, timedelta, timezone

import discord
from discord.ext import commands
from supabase import create_client

# =========================
# ENV VARS (from Discloud)
# =========================
DISCORD_TOKEN = os.getenv("DISCORD_BOT_TOKEN")
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
VERIFY_SITE_URL = os.getenv("VERIFY_SITE_URL", "").rstrip("/")
TICKET_CATEGORY_ID = int(os.getenv("TICKET_CATEGORY_ID", "0"))
TOKEN_TTL_MINUTES = int(os.getenv("TOKEN_TTL_MINUTES", "20"))

VERIFIED_ROLE_ID = int(os.getenv("VERIFIED_ROLE_ID", "0"))
RESIDENT_ROLE_ID = int(os.getenv("RESIDENT_ROLE_ID", "0"))

if not DISCORD_TOKEN:
    raise RuntimeError("Missing DISCORD_BOT_TOKEN env var")
if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
    raise RuntimeError("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env var")
if not VERIFY_SITE_URL:
    raise RuntimeError("Missing VERIFY_SITE_URL env var (ex: https://stoney-baloney-verify.vercel.app)")
if not TICKET_CATEGORY_ID:
    raise RuntimeError("Missing/invalid TICKET_CATEGORY_ID env var")
if not VERIFIED_ROLE_ID or not RESIDENT_ROLE_ID:
    raise RuntimeError("Missing VERIFIED_ROLE_ID and/or RESIDENT_ROLE_ID env var")

supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

# =========================
# DISCORD INTENTS
# =========================
intents = discord.Intents.default()
intents.guilds = True
intents.members = True          # needed to add roles reliably
intents.reactions = True
intents.messages = True         # needed for reaction events + fetching messages

bot = commands.Bot(command_prefix="!", intents=intents)

TOKEN_RE = re.compile(r"Token:\s*`([^`]+)`", re.IGNORECASE)

def make_token() -> str:
    return secrets.token_urlsafe(18)

def is_staff(member: discord.Member) -> bool:
    # "Manage Roles" or "Administrator" is a good default
    return member.guild_permissions.manage_roles or member.guild_permissions.administrator

async def find_ticket_owner(channel: discord.TextChannel) -> discord.Member | None:
    """
    TicketTool channels usually have overwrites for exactly 1 non-staff user.
    We'll pick the first member overwrite that can view the channel and is not a bot.
    """
    try:
        for target, overwrite in channel.overwrites.items():
            if isinstance(target, discord.Member) and not target.bot:
                if overwrite.view_channel is True:
                    return target
    except Exception:
        pass
    return None

@bot.event
async def on_ready():
    print(f"✅ Stoney Verify Helper online as {bot.user} (guilds={len(bot.guilds)})")
    print(f"🔎 Watching category_id={TICKET_CATEGORY_ID} | ttl={TOKEN_TTL_MINUTES}min | site={VERIFY_SITE_URL}")
    print(f"🎭 Roles: verified={VERIFIED_ROLE_ID} resident={RESIDENT_ROLE_ID}")

@bot.event
async def on_guild_channel_create(channel):
    # Only text channels
    if not isinstance(channel, discord.TextChannel):
        return

    # Must be inside the target category
    if not channel.category or channel.category.id != TICKET_CATEGORY_ID:
        return

    # Ticket Tool channels typically start with "ticket"
    if not channel.name.lower().startswith("ticket"):
        return

    try:
        webhook = await channel.create_webhook(name="StoneyVerify")

        token = make_token()
        expires_at = datetime.now(timezone.utc) + timedelta(minutes=TOKEN_TTL_MINUTES)

        # Store mapping (extra fields are fine even if you ignore them later)
        supabase.table("verification_tokens").insert({
            "token": token,
            "webhook_url": webhook.url,
            "expires_at": expires_at.isoformat(),
            "used": False,
        }).execute()

        link = f"{VERIFY_SITE_URL}/?token={token}"

        await channel.send(
            "🌿 **Verification Required**\n\n"
            "Use the secure link below to upload your ID.\n"
            "You may redact private information before submitting.\n\n"
            f"🔗 {link}\n\n"
            f"⏳ Link expires in **{TOKEN_TTL_MINUTES} minutes**.\n"
            "⚠️ Roles are granted **only after staff approval**."
        )

        print(f"✅ Ticket detected: #{channel.name} | token={token}")

    except Exception as e:
        print(f"❌ Error setting up verification in channel={channel.id}: {e}")

@bot.event
async def on_raw_reaction_add(payload: discord.RawReactionActionEvent):
    """
    Staff approves/denies by reacting on the Submission message posted by /api/verify.
    ✅ = approve + grant roles
    ❌ = deny (no roles)
    """
    if payload.guild_id is None:
        return
    if payload.user_id == bot.user.id:
        return

    emoji = str(payload.emoji)
    if emoji not in ("✅", "❌"):
        return

    guild = bot.get_guild(payload.guild_id)
    if not guild:
        return

    channel = guild.get_channel(payload.channel_id)
    if not isinstance(channel, discord.TextChannel):
        return

    # Ensure it's in the correct ticket category
    if not channel.category or channel.category.id != TICKET_CATEGORY_ID:
        return

    try:
        member = guild.get_member(payload.user_id) or await guild.fetch_member(payload.user_id)
        if not isinstance(member, discord.Member):
            return
        if not is_staff(member):
            return  # only staff can approve/deny

        msg = await channel.fetch_message(payload.message_id)

        # Must be our submission message
        if "Verification Submission" not in (msg.content or ""):
            return

        m = TOKEN_RE.search(msg.content or "")
        if not m:
            return
        token = m.group(1).strip()

        # Check token row
        {#}  # placeholder to avoid syntax highlighting weirdness
        data = supabase.from_("verification_tokens").select("used, expires_at").eq("token", token).single().execute()
        row = data.data if hasattr(data, "data") else None

        if not row:
            await channel.send("❌ Token not found in database.")
            return

        if row.get("used"):
            await channel.send("⚠️ This token was already decided/used.")
            return

        # Expiry check
        exp = row.get("expires_at")
        if exp:
            exp_ms = datetime.fromisoformat(exp.replace("Z", "+00:00")).timestamp() * 1000
            if exp_ms and (datetime.now(timezone.utc).timestamp() * 1000) > exp_ms:
                supabase.from_("verification_tokens").update({"used": True}).eq("token", token).execute()
                await channel.send("⏳ Token expired — have the user re-open verification.")
                return

        if emoji == "❌":
            supabase.from_("verification_tokens").update({
                "used": True,
                "decision": "DENIED",
                "decided_at": datetime.now(timezone.utc).isoformat(),
                "decided_by": str(payload.user_id),
            }).eq("token", token).execute()

            await channel.send("❌ **Denied.** No roles granted. (Token closed)")
            return

        # ✅ APPROVE:
        ticket_owner = await find_ticket_owner(channel)
        if not ticket_owner:
            await channel.send("⚠️ Could not auto-detect ticket owner. (TicketTool overwrite missing)")
            return

        verified_role = guild.get_role(VERIFIED_ROLE_ID)
        resident_role = guild.get_role(RESIDENT_ROLE_ID)

        if not verified_role or not resident_role:
            await channel.send("❌ Missing role(s). Check VERIFIED_ROLE_ID / RESIDENT_ROLE_ID.")
            return

        # Grant both roles
        await ticket_owner.add_roles(resident_role, verified_role, reason="Stoney Verify approved by staff")

        supabase.from_("verification_tokens").update({
            "used": True,
            "decision": "APPROVED",
            "decided_at": datetime.now(timezone.utc).isoformat(),
            "decided_by": str(payload.user_id),
            "approved_user_id": str(ticket_owner.id),
        }).eq("token", token).execute()

        await channel.send(f"✅ **Approved.** Granted roles to {ticket_owner.mention}: {resident_role.mention} + {verified_role.mention}")

    except Exception as e:
        print("❌ Reaction handler error:", e)

bot.run(DISCORD_TOKEN)
