# Pro WhatsApp Approver

A multi-user website for automatic and historical WhatsApp group request approvals. Anyone can create an account, sign in, pair their own WhatsApp account, and manage their own groups. No server URL or shared admin key is required for ordinary users.

## User experience

1. Open the website and choose **Create account**.
2. Enter a name, email address, and password (at least 12 characters).
3. Connect your WhatsApp through **Linked devices** and the account’s pairing QR.
4. Sync your admin groups, enable automatic approvals, or start historical approval jobs.

Signing out ends the website session, while your background connection and jobs continue. **Settings → Stop background connection** stops your WhatsApp connection. Permanently revoke the linked device through WhatsApp. Each account currently supports one WhatsApp connection and multiple groups.

Account names, pairing QRs, linked-device credentials, groups, requests, jobs, reconciliation actions and activity logs are isolated by account. Users never share the original owner’s WhatsApp session. An account with no paired WhatsApp starts with an empty workspace.

## Upgrade from the original single-owner release

The original `ADMIN_API_KEY` is retained solely as an **owner migration key**, not as a shared login credential. Keep your current `.env`, named volumes, and `compose.override.yaml`.

Back up PostgreSQL before updating:

```sh
cd /root/pro-whatsapp-approver
mkdir -p /root/pro-whatsapp-approver-backups
docker compose exec -T db pg_dump -U approver -d approver > "/root/pro-whatsapp-approver-backups/before-multiuser-$(date +%Y%m%d-%H%M%S).sql"
git pull --ff-only
docker compose up -d --build
curl --fail http://127.0.0.1:18081/api/health
```

The first startup creates the account tables and moves existing approval tables into a protected `legacy` schema. It preserves rows, jobs, indexes, foreign keys and session files. No public signup gets this workspace automatically. Original jobs wait until the owner claims the workspace and explicitly reconnects.

For the original owner: choose **Create account**, expand **Moving your workspace from the original version?**, and enter the original admin key while creating your login. This claims the existing workspace and its original WhatsApp credential directory exactly once. Other users simply register without that field. If you already registered an ordinary empty account, sign out and use a separate email to claim the old workspace, or contact the operator for an account migration; the claim is deliberately not silently attached to an existing login.

The original key no longer authorizes `/api/state` or any approval operation. Do not share it. New users use their own email/password and cannot read the owner’s records.

## New Hostinger VPS deployment

Requires Node 22+ (Docker image uses Node 24), Docker Engine + Compose v2, PostgreSQL 16, and a domain pointing to the server. This app defaults to **127.0.0.1:18081**, leaving 18080 alone.

1. Clone the source. Copy `.env.example` to `.env` and set a random hex `POSTGRES_PASSWORD` plus the exact public HTTPS `DASHBOARD_ORIGINS`.
2. Run `docker compose up -d --build`.
3. If Caddy runs on the host, reverse proxy your domain to `127.0.0.1:18081`.
4. If Caddy is a Docker container, attach only the app service to its shared proxy network using an override. Keep the database on the app’s private network.

Example for the existing shared Caddy network on this VPS (stored in ignored `compose.override.yaml`):

```yaml
services:
  app:
    networks:
      default: {}
      caddy:
        aliases: [pro-whatsapp-approver]
networks:
  caddy:
    external: true
    name: prochannelhelpbot_default
```

Add this to the existing Caddyfile, validate, and reload the existing proxy:

```caddy
prowhatsappapprover.tech {
    encode zstd gzip
    reverse_proxy pro-whatsapp-approver:3000
}
```

The dashboard and API must be served on the **same HTTPS origin**. The supplied Compose configuration trusts exactly the immediate Caddy proxy hop so registration/login limits apply per visitor instead of to the whole proxy. Production sessions use Secure, HttpOnly, SameSite=Lax cookies with 30-day expiry. This release replaces the original remote-service-URL/admin-key frontend; use your VPS domain for the multi-user application. An old separately hosted frontend is not compatible with the new cookie-based API.

## Account and data security

- Passwords use scrypt with independent random salts. Only password hashes are stored.
- Browser sessions use random 256-bit tokens. Only SHA-256 token hashes are stored in PostgreSQL; raw tokens are HttpOnly cookies.
- Password changes revoke all previous website sessions. Signing out revokes the current browser session only. Restarting the service preserves unexpired sessions.
- Signups and logins are rate limited. State-changing requests require JSON and an allowed Origin; cookie requests from unlisted sites cannot perform mutations.
- Each user gets a server-generated PostgreSQL schema, a transaction-scoped search path that excludes `public`, through a shared bounded connection pool, their own worker, and a disjoint credential directory. Routes select the workspace from the authenticated server-side session, never from a client-supplied account ID.
- A guessed group/job/request ID is evaluated only in the signed-in user’s workspace. Two accounts can have the same WhatsApp group ID without sharing settings or jobs.
- New account auth paths are `/data/accounts/<account UUID>`; the original owner retains `/data/whatsapp`. Resetting one account’s credentials cannot delete another account’s directory.
- Ordinary signup does not verify email ownership and no outgoing email provider is configured. Password changes are available when signed in. Forgotten-password recovery currently requires operator assistance; automated email reset is not provided.
- Caddy exposes the application over HTTPS. PostgreSQL and the loopback service port are not exposed publicly. Do not publish `.env` or auth volumes.

One process owns the global PostgreSQL worker lock. Each account has its own serial approval worker, so one user’s long queue does not block another’s. `MAX_CONNECTED_ACCOUNTS` defaults to 20 simultaneous background WhatsApp connections to bound VPS resources; ordinary registration and login remain available when connection slots are full. Increase the limit only after checking RAM and PostgreSQL connection capacity. Run one app replica per database/session volume.

## Approval semantics

- **Automatic:** sync the baseline before activation. Only requests first seen after activation enter automatic jobs; periodic reconciliation recovers new arrivals after a disconnection. Existing historical requests remain untouched. Turning auto off cancels its queued/running jobs; one in-flight operation may finish.
- **Historical / Approve All:** snapshot the current pending queue and process eligible requests up to capacity. Future requests are outside that historical job.
- **Historical / exact amount:** stop at the requested number of confirmed successes. Failed requests do not count; the worker can select another eligible request from the original snapshot. Requests above the target stay pending. Pause with a reason if the target can no longer be reached.
- **Capacity:** refresh metadata before dispatch. Stop at the configured maximum of 1–1,024 members. Existing members and admins count toward the limit. Other admins can act concurrently; WhatsApp does not expose atomic slot reservations.
- **Verification:** count only after WhatsApp returns success and membership is verified. Recognize phone-number/LID aliases when returned by WhatsApp.
- **Uncertain result:** persist before dispatch, then pause on an ambiguous write or interrupted verification. Never blindly retry or credit an uncertain approval. The account owner can review the outcome, verify membership, retry only if still pending, or exclude the item.
- **Recovery:** jobs and credentials survive app restarts; interrupted in-flight items require review. Read-only queries and dropped connections retry with bounded backoff. Permission/capacity problems pause safely.

Baileys is an unofficial linked-device client. WhatsApp can change protocol behavior or restrict accounts. This service does not use the WhatsApp Business Cloud API. It sends no unsolicited messages to requesters.

## Verification

```sh
npm ci --ignore-scripts
npm run check
npm test
npm audit --omit=dev
```

The automated suite runs the actual route handlers, account service and tenant manager against PostgreSQL-compatible SQL through PGlite, with a controlled WhatsApp transport in tests only. It covers account signup/login/session persistence, cookie protection, password changes, logout, migration ownership, separate credential directories, identical group IDs, cross-account job read/mutation attempts, origin checks, connection slots, restart recovery, and approval targets/capacity/timeouts.

Real WhatsApp pairing and approvals require live acceptance on the destination VPS. Verify with two separate browser accounts: pair two distinct WhatsApp accounts; confirm each sees only its own groups/QR/jobs/logs; approve exactly one of at least three waiting requests; verify the remainder stay pending; enable auto and confirm only a new request is approved; then test reconnect, restart and per-account session reset. Do not describe live WhatsApp verification as complete based only on automated tests.

## Operations

- `/api/health` checks PostgreSQL and reports application version; authenticated `/api/state` reports only the current user’s connection.
- `docker compose logs --tail=100 app` shows service diagnostics. Authorization/cookie headers are redacted and auth bodies are not logged.
- Back up the whole PostgreSQL database, `.env`, and the WhatsApp named volume using encrypted storage. The database includes all account schemas; account session files grant linked-device access.
- Keep `.env`, named volumes, and the shared proxy configuration intact on updates. Do not run `docker compose down -v` when upgrading.
