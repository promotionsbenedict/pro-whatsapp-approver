CREATE TABLE IF NOT EXISTS public.app_users (
 id uuid PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE,
 password_hash text NOT NULL, schema_name text NOT NULL UNIQUE,
 legacy boolean NOT NULL DEFAULT false, wa_started boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS one_legacy_owner ON public.app_users(legacy) WHERE legacy;
CREATE TABLE IF NOT EXISTS public.app_sessions (
 token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS app_sessions_user ON public.app_sessions(user_id);
