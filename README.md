# Pro WhatsApp Approver

A real WhatsApp group approval dashboard and persistent Node.js/Baileys worker, with PostgreSQL and Docker Compose. No sample groups, mock pairing, fake approvals, or simulated production counters are included.

## Delivery status

Implemented: QR pairing, persisted linked-device sessions, reconnection with backoff, admin-group sync, per-group future-request automation, historical queue snapshots, exact custom targets, multi-group job creation, capacity checks up to 1,024 members, pause/resume/cancel, ambiguous-result review, durable job recovery, activity log, CSV export, and authenticated API.

Automated verification uses PostgreSQL-compatible SQL through PGlite and a controlled WhatsApp transport fixture. These are tests, never the production transport. Real WhatsApp pairing and live approvals have **not** been verified in this environment. Docker/PostgreSQL container execution must be checked on the destination VPS. Do not call this live until the acceptance checklist below passes.

Baileys is an unofficial linked-device client. WhatsApp can change protocol behavior or restrict accounts. This implementation does not use the official WhatsApp Business Cloud API.

## Deploy on the existing Hostinger VPS

Requires Docker Engine + Compose v2, an HTTPS domain pointing to the VPS, and your existing shared reverse proxy. This app defaults to loopback port **18081**, leaving 18080 alone.

1. Put this complete source tree in `/root/pro-whatsapp-approver` (clone the eventual GitHub repository or extract the source ZIP).
2. Copy `.env.example` to `.env`. Generate **two separate secrets** with `openssl rand -hex 32`: one for `ADMIN_API_KEY`, one for `POSTGRES_PASSWORD`. Use hex for the database password so it is safe inside the database URL. Set `DASHBOARD_ORIGINS` to your app's exact HTTPS origin, plus the private hosted dashboard origin if using it. Never commit `.env`.
3. Run:

   ```sh
   cd /root/pro-whatsapp-approver
   docker compose up -d --build
   docker compose ps
   docker compose logs --tail=100 app
   curl --fail http://127.0.0.1:18081/api/health
   ```

4. Add a site block to your **existing host Caddy** configuration, replacing this example domain:

   ```caddy
   approver.example.com {
       encode zstd gzip
       reverse_proxy 127.0.0.1:18081
   }
   ```

   Validate and reload your existing Caddy deployment using its normal process. If Caddy is itself inside Docker, `127.0.0.1` refers to the Caddy container, so it cannot reach this host-bound port. Attach the app to the existing shared Docker proxy network instead and point Caddy at that app's service alias on port 3000; do not publish the database or expose the app port globally. Match the actual network name on your VPS rather than guessing it. Keep your current proxy and other projects intact.

5. Open the dashboard (served by the VPS app as well as the private hosted copy). Choose Connect WhatsApp, enter your VPS HTTPS origin and `ADMIN_API_KEY`, and generate the pairing QR. Scan it in **WhatsApp → Linked devices → Link a device**.
6. Sync groups. The connected account must be an admin in every group it approves. Enable join approval in WhatsApp for groups that should collect pending requests.
7. Run the acceptance checks below on a group you control, then activate production automation.

The dashboard key is held only in tab memory and must be entered after a reload. The saved API origin is a convenience, not a credential. The persistent worker runs while the dashboard is closed. No system automatically sends welcome messages or messages to requesters.

## Approval semantics

- **Historical / Approve All:** each job snapshots the currently pending request IDs. Future requests are outside that historical job.
- **Historical / exact amount:** approve up to the requested number of **confirmed successes**; failed requests are not counted and the worker can try another request from the original snapshot. Anything above the target is left pending. If fewer requests remain eligible than the target, the job pauses with an explanation.
- **Automatic:** existing requests are synced before activation. Only requests first seen after activation enter auto jobs. Periodic reconciliation every 60 seconds recovers requests observed while disconnected. Disabling auto cancels existing auto jobs; one already in-flight approval may still finish.
- **Capacity:** refresh group metadata before every dispatch. Stop at the configured maximum (1–1,024 members). A full group pauses the job. A target of 1,024 approvals requires 1,024 free slots; admins and existing members already count toward capacity.
- **Verification:** a WhatsApp success status and verified current membership are both required before an approval increments the job. LID and phone-number aliases are recognized when supplied in metadata.
- **Uncertain response:** persist an in-flight marker before contacting WhatsApp. A timeout, missing response, failed membership check, or process restart with an in-flight item pauses the job. It is never blindly retried or credited. The operator can count it after checking membership, retry only if still pending, or exclude it from future jobs. Review actions are logged.
- **Other admins:** concurrent external actions are not controlled by this app. No client can atomically reserve WhatsApp member slots or guarantee attribution while other admins act. This service serializes its own approvals and rechecks state before each one.
- **Recovery:** database jobs and WhatsApp auth volumes survive app restarts. Pre-dispatch failures pause safely; connection drops automatically reconnect. Resume paused jobs after fixing permission/capacity issues. Pair again after session revocation.
- **Concurrency:** one service process owns a PostgreSQL advisory lock; one active/paused job per group is enforced by a database index. Do not run multiple replicas against the same session. Jobs are processed sequentially, with a minimum 1.5-second dispatch interval (default 2.5 seconds).

## Live acceptance checklist — requires your paired account

- Generate and scan a real QR. Restart the app; verify that the session restores without pairing again.
- Sync an admin group with approval mode enabled and real pending requests. Confirm pending counts and member counts against WhatsApp.
- With at least three requests waiting and free member slots, approve exactly one; confirm membership and two requests remain pending.
- Enable auto after a baseline sync. Confirm existing requests stay pending, and a new request is approved.
- Disable auto. Confirm subsequent new requests remain pending.
- Set a lower capacity at the current member count. Start a historical job and verify no approval is dispatched until capacity is raised and the job resumed.
- Pause, cancel, restart, and resume jobs. Review an ambiguous result without issuing a duplicate approval.
- Remove admin rights and revoke the linked session separately; verify clear errors and safe stopping.
- From a separate unsigned client, confirm `/api/state` and every mutation require the admin key. Confirm the allowed HTTPS dashboard can reach the API and an unlisted origin cannot read it.

## Development and tests

```sh
npm ci --ignore-scripts
npm run check
npm test
npm audit --omit=dev
```

`npm start` requires `ADMIN_API_KEY`, `DATABASE_URL`, `DASHBOARD_ORIGINS`, and a writable `AUTH_DIR` (default `/data/whatsapp`). The server automatically applies the idempotent initial SQL schema. The lockfile pins dependencies. No Redis, paid messaging API, v0, or Vercel is required.

## Operations

- Health: `/api/health` checks PostgreSQL. Detailed WhatsApp connection state is available only to authenticated admins via `/api/state`.
- Logs: `docker compose logs --tail=200 app`. User-facing event history is persisted in PostgreSQL. The API returns the latest 200 events and 100 jobs; older records remain in the database.
- Update: `git pull` then `docker compose up -d --build`. Keep `.env` and named volumes intact.
- Backup: back up PostgreSQL with `pg_dump` and the WhatsApp auth volume securely. Auth files grant linked-device access; do not share them. Use encrypted off-host backups.
- Revoke: unlink the device from WhatsApp. Rotate `ADMIN_API_KEY` in `.env` and recreate the app service when necessary.
- Reset: use Clear expired session only after unlinking/revocation, then generate a new QR. No group membership or pending requests are removed by clearing local credentials.

## Source and GitHub

The source tree is complete and can be pushed to a new dedicated GitHub repository. Repository creation and a GitHub push are not claimed until an actual destination is supplied and the push succeeds. The Sites source repository is a separate managed repository, not your GitHub account.
