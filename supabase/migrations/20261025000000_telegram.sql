-- TS on Supabase: «TS в Telegram» for the owner (Edge Function `telegram` is the bot's webhook).
-- Supabase only: the self-hosted cloud (apps/cloud, SQLite) has no Telegram bot.
-- Every table is for the service connection of the functions only: RLS on, no policies, no grants.

-- A chat linked to an owner: alerts (by the owner's push rules) and the evening summary go there.
-- chat_id is text: Telegram ids of groups do not fit in 32 bits. One chat belongs to one owner;
-- an owner may link several chats (own phone, a partner, a group). muted = 1 pauses messages (/mute).
CREATE TABLE IF NOT EXISTS public.owner_telegram (
  chat_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES public.owners(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  muted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_owner_telegram_owner ON public.owner_telegram (owner_id);

-- One-time link codes from the cabinet («Получать в Telegram»): only sha256 of the code is stored,
-- valid for 15 minutes, used once (used_at). Old rows are deleted when new codes are made.
CREATE TABLE IF NOT EXISTS public.telegram_link_codes (
  code_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES public.owners(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  used_at BIGINT
);
CREATE INDEX IF NOT EXISTS ix_telegram_link_codes_owner ON public.telegram_link_codes (owner_id);

-- The evening summary went to this chat about this club on this local day: sent once.
CREATE TABLE IF NOT EXISTS public.telegram_digests (
  chat_id TEXT NOT NULL,
  club_id TEXT NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  sent_at BIGINT NOT NULL,
  PRIMARY KEY (chat_id, club_id, day)
);

ALTER TABLE public.owner_telegram ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_link_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_digests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.owner_telegram, public.telegram_link_codes, public.telegram_digests FROM PUBLIC, anon, authenticated;
