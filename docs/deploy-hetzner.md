# Running day2 in production (Hetzner, one server)

The short version, as a checklist: [go-live-checklist.md](go-live-checklist.md).

One small server runs everything with Docker Compose: Postgres, the
orchestrator API, the console, Caddy (HTTPS) and nightly backups.

```
browser ──https──▶ Caddy ──/api/*──▶ api (orchestrator, Bun) ──▶ Postgres
                         └─ else ───▶ console (TanStack Start, Bun)
                                      backup (pg_dump + day2 files, nightly)
```

Console and API share one origin, so sign-in is a plain HttpOnly cookie and
there is no CORS.

**Cost:** Hetzner CX23 (2 vCPU, 4 GB RAM, 40 GB disk), about €5.49/month incl.
IPv4. Add backups (+20%) or a Storage Box (from ~€3.20/month) for copies off
the server. Claude usage is billed separately by Anthropic.

---

## 1. Create the server

1. Hetzner Cloud console → **Add server**: location Falkenstein or Nuremberg,
   image **Ubuntu 24.04**, type **CX23**, add your SSH key, enable **Backups**
   (optional but recommended).
2. **Firewall**: allow inbound TCP 22, 80, 443 and UDP 443; nothing else.
3. DNS: an **A record** for your domain (e.g. `app.example.com`) → the server's IPv4.

## 2. Prepare it

```sh
ssh root@<server-ip>
apt-get update && apt-get -y upgrade
curl -fsSL https://get.docker.com | sh

# The agent sandbox (bubblewrap) needs unprivileged user namespaces,
# which Ubuntu 24.04 restricts by default.
echo 'kernel.apparmor_restrict_unprivileged_userns=0' > /etc/sysctl.d/60-day2-userns.conf
sysctl --system

adduser --disabled-password --gecos "" day2 && usermod -aG docker day2
```

## 3. Ways to sign in

People sign in to day2 without a day2 password, in any of three ways. Set up
the ones you want; the login page shows only those. Whichever they use, the
same verified email address leads to the same person and workspace.

| Way in | Who it's for | Needs |
|---|---|---|
| **Email link** | Anyone. A one-time link, valid 15 minutes | An SMTP account (step 3a) |
| **Google** | People with a Google or Workspace account | A Google OAuth client (step 3b) |
| **GitHub** | Developers. Also how repos get connected | day2's GitHub App (step 3c) |

Connecting repositories always goes through GitHub. Someone in the workspace
with a GitHub account does it once, and nobody else needs GitHub.

### 3a. Email (SMTP)

Use any transactional email service, for example Postmark, Amazon SES, Brevo
or Mailgun. Verify your sending domain there (SPF and DKIM) so the links don't
land in spam. Then set:

- `SMTP_URL=smtp://USER:PASSWORD@smtp.provider.com:587` (use `smtps://…:465` for TLS on connect)
- `MAIL_FROM="day2 <hello@yourdomain.com>"`

Sign-in links are rate-limited (5 per address per 15 minutes, 30 per network
address per hour). The link opens a page with a **Continue** button, so mail
scanners that open links can't use them up.

### 3b. Google

In Google Cloud console:

1. **APIs & Services → OAuth consent screen**: External. Add app name, support
   email and your domain. The scopes are `openid`, `email` and `profile`, which
   need no Google review.
2. **Credentials → Create credentials → OAuth client ID**: type **Web
   application**. Authorized redirect URI:
   `https://app.example.com/api/auth/google/callback`.
3. Copy the client ID and secret into `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
4. Publish the consent screen (it starts in "Testing", which allows only listed test users).

### 3c. day2's GitHub App

GitHub sign-in and repo access both go through one GitHub App. On GitHub:
**Settings → Developer settings → GitHub Apps → New GitHub App** (under the
organization that will own day2).

| Setting | Value |
|---|---|
| Homepage URL | `https://app.example.com` |
| Callback URL | `https://app.example.com/api/auth/github/callback` |
| Request user authorization (OAuth) during installation | **on** |
| Setup URL | leave empty (the callback above handles installs) |
| Webhook | **off** |
| Repository permissions | Contents: **Read & write** · Pull requests: **Read & write** · Issues: **Read & write** · Metadata: Read |
| Account permissions | Email addresses: Read |
| Where can it be installed | **Any account** |

Then on the App's page:

- note the **App ID**, the **slug** (from `github.com/apps/<slug>`) and the
  **Client ID**;
- **Generate a new client secret**;
- **Generate a private key** (downloads a `.pem`).

## 4. Get the code and fill in the settings

```sh
su - day2
git clone <orchestrator repo> day2-orchestrator
git clone <console repo> console          # next to it
cd day2-orchestrator/deploy
cp .env.example .env && chmod 600 .env
```

Fill in `.env`:

- `DAY2_DOMAIN`: your domain.
- `POSTGRES_PASSWORD` and `DAY2_SECRETS_KEY`: generate each with `openssl rand -base64 32`.
  **Keep a copy of `DAY2_SECRETS_KEY` somewhere safe.** Without it, stored JIRA and
  Linear connections can't be read.
- `ANTHROPIC_API_KEY`.
- The sign-in settings from step 3: `SMTP_URL` and `MAIL_FROM`, `GOOGLE_CLIENT_ID`
  and `GOOGLE_CLIENT_SECRET`, and the GitHub App values. Put the GitHub App's private key on one line:

  ```sh
  awk 'NF {sub(/\r/, ""); printf "%s\\n",$0;}' day2.private-key.pem
  ```

- `DAY2_OPERATOR_LOGINS`: your GitHub username.

Then start it:

```sh
docker compose up -d --build
docker compose logs -f api      # "[day2-api] accounts mode, listening …"
```

The API applies database migrations on start. Caddy fetches the HTTPS
certificate on the first request.

## 5. Check it works

1. Open `https://app.example.com`. You should be sent to **Sign in**. Try
   each way you set up. Email yourself a link, and check it arrives (not in spam).
2. **Add an app → GitHub → Connect GitHub**. Install the App on your account
   or organization and pick a repository. GitHub returns you to day2, and the
   repository list appears.
3. Connect the repository. day2 clones it on the server.
4. Check the agent sandbox:

   ```sh
   docker compose exec api bwrap --unshare-all --ro-bind / / true && echo sandbox ok
   ```

   If that fails, step 2's sysctl is missing. day2 refuses to run agents without the sandbox.

## How it behaves in production

- **Accounts.** The first sign-in creates a workspace on the 14-day trial.
  Owners and admins invite people by email address or GitHub username.
  Invitations by email are sent as an email, and every invitation is accepted on
  that person's next sign-in. Seats are limited by the plan. Only owners and
  admins can change billing, people, connections or remove apps.
- **Isolation.** Every request is scoped to the signed-in workspace:
  - Apps, credits and tracker connections are separate per workspace.
  - Each workspace's GitHub access uses its own short-lived App token.
  - Folders on the server can't be connected.
- **One person, several ways in.** Google, GitHub and email sign-ins with the
  same *verified* email address are the same person. An unverified address
  never joins anyone.
- **Sessions.** A random 256-bit token sits in an HttpOnly, Secure, SameSite=Lax
  cookie, and only its SHA-256 is stored. Sessions last 30 days, renewed on use.
  State-changing requests must come from day2's own origin.
- **Secrets.** JIRA and Linear tokens are stored with AES-256-GCM
  (`DAY2_SECRETS_KEY`). GitHub tokens are never stored: each is minted per use
  and expires within an hour. Errors shown to customers carry no internals; details stay
  in `docker compose logs api`.
- **Background work.** Each backlog moves on its own every
  `DAY2_BACKLOG_TICK_MINUTES`. That work runs as each workspace, paid from
  that workspace's credits.
- **Lovable app creation** stays off (`DAY2_FEATURE_CREATE_APPS=off`).

## Backups

The `backup` service runs every night at `BACKUP_HOUR` (UTC) and keeps
`BACKUP_KEEP_DAYS` days in `deploy/backups/`:

- `day2-db-*.dump`: the whole database.
- `day2-files-*.tar.gz`: day2's per-app files (backlog, growth and answers;
  the code itself is on GitHub).
- `day2-data-*.tar.gz`: day2's own state (`/data`).

Run one now: `docker compose run --rm backup /backup.sh --once`.

**Backups off the server.** Keeping backups on the same disk doesn't protect
against losing the server. Copy `deploy/backups/` to a Hetzner Storage Box
nightly, e.g. with `rclone sync` from a cron job, or at least turn on Hetzner's
server backups.

**Restore:**

```sh
docker compose stop api
docker compose exec -T postgres pg_restore -U day2 -d day2 --clean --if-exists < backups/day2-db-<stamp>.dump
# Re-connect the apps first (or re-clone them) so their folders exist, then:
docker compose run --rm -v "$PWD/backups:/backups" --entrypoint sh api -c \
  'tar -xzf /backups/day2-files-<stamp>.tar.gz -C /app/managed-repos && tar -xzf /backups/day2-data-<stamp>.tar.gz -C /data'
docker compose start api
```

## Updating

```sh
cd ~/day2-orchestrator && git pull && cd ~/console && git pull
cd ~/day2-orchestrator/deploy && docker compose up -d --build
```

Migrations run automatically, and a short restart of the API is the only downtime.

## Limits of one server

One CX23 handles a handful of workspaces. Agent runs are the heavy part
(the API container is capped at 3 GB). When that's not enough, resize the
server (CX33/CX43) in the Hetzner console. Nothing changes in day2. Several
API servers can share the database later: backlog passes already take a
database lock, so only one server runs each pass.
