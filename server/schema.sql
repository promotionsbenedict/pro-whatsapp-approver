CREATE TABLE IF NOT EXISTS groups (
 id text PRIMARY KEY, name text NOT NULL, member_count integer NOT NULL DEFAULT 0,
 capacity integer NOT NULL DEFAULT 1024, is_admin boolean NOT NULL DEFAULT false,
 auto_enabled boolean NOT NULL DEFAULT false, auto_since timestamptz,
 baseline_at timestamptz, synced_at timestamptz, error text
);
CREATE TABLE IF NOT EXISTS requests (
 group_id text REFERENCES groups(id), jid text, first_seen timestamptz NOT NULL DEFAULT now(),
 requested_at timestamptz, status text NOT NULL DEFAULT 'pending',
 PRIMARY KEY(group_id,jid)
);
CREATE TABLE IF NOT EXISTS jobs (
 id uuid PRIMARY KEY, group_id text REFERENCES groups(id), kind text NOT NULL,
 target integer NOT NULL CHECK(target > 0), confirmed integer NOT NULL DEFAULT 0,
 status text NOT NULL DEFAULT 'queued', reason text, created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_job ON jobs(group_id) WHERE status IN ('queued','running','paused');
CREATE TABLE IF NOT EXISTS job_items (
 job_id uuid REFERENCES jobs(id), jid text, ordinal integer NOT NULL,
 status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
 PRIMARY KEY(job_id,jid)
);
CREATE TABLE IF NOT EXISTS activity (
 id bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(),
 level text NOT NULL, event text NOT NULL, group_id text, job_id uuid, detail text NOT NULL
);
