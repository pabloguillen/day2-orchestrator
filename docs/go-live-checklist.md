# Going live: checklist

What's left before day2 runs in production. Nothing here is urgent.
day2 keeps working locally on your own machine in the meantime. The details
for each step are in [deploy-hetzner.md](deploy-hetzner.md).

## 1. Decide the address

For example `app.yourdomain.com`. Every account below needs it.

## 2. Rent the server

Hetzner Cloud, about €5.49/month ([guide §1](deploy-hetzner.md#1-create-the-server)).

- [ ] A **CX23** with **Ubuntu 24.04** and your SSH key
- [ ] A firewall allowing only ports **22, 80 and 443**
- [ ] At your domain provider, a DNS **A record** pointing your address at the server's IP

## 3. Create the accounts for signing in

Each one gives you values for the settings file ([guide §3](deploy-hetzner.md#3-ways-to-sign-in)).

- [ ] **Email sending:** sign up with Postmark, Brevo or Amazon SES and verify
      your domain there. You get an SMTP address and password. This is the
      most important one, because it works for everyone.
      → `SMTP_URL`, `MAIL_FROM`
- [ ] **Google sign-in** (optional): create an OAuth client in Google Cloud.
      It takes about 10 minutes.
      → `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- [ ] **GitHub App:** create it on GitHub with the settings from the guide's table.
      → `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_CLIENT_ID`,
      `GITHUB_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`
- [ ] **Anthropic API key**, for the agent work.
      → `ANTHROPIC_API_KEY`

## 4. Set up the server

About 20 minutes. Log in by SSH and follow sections
[2](deploy-hetzner.md#2-prepare-it), [4](deploy-hetzner.md#4-get-the-code-and-fill-in-the-settings)
and [5](deploy-hetzner.md#5-check-it-works) of the guide.

- [ ] Install Docker and apply the one system setting the agent sandbox needs
- [ ] Download both repos (orchestrator and console, side by side)
- [ ] Copy `deploy/.env.example` to `deploy/.env` and fill in the values from
      step 3. Do this on the server only, never in a chat.
- [ ] Run `docker compose up -d --build`

## 5. Check it works

- [ ] Open your address and sign in by email link, Google and GitHub
- [ ] Connect a repo
- [ ] Run the one-line sandbox check from the guide
