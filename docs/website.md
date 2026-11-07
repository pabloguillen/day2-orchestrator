# gora8.com, the public website

A small static site in `site/`: the home page, Impressum, privacy policy and
terms. It's hosted on Cloudflare Pages, where your gora8.com domain already is.
No cookies, no analytics, no third-party requests (Inter is served from the
site itself).

| File | What |
|---|---|
| `site/index.html` | Home: logo, one sentence, contact |
| `site/impressum.html` | Impressum (German, § 5 DDG) |
| `site/privacy.html` | Privacy policy, including the Google "Limited Use" statement Google's verification needs |
| `site/terms.html` | Terms of service |
| `site/style.css` | Ink on cream, same identity as the console |
| `site/_headers` | Security headers for Cloudflare Pages |

## 1. Details

Filled in for Pablo Guillen (sole proprietor), Gürtelstraße 35, 10247 Berlin.
Update the Impressum when you get a VAT ID (USt-IdNr.) or register a company,
and the privacy page's provider list when a server host and an email provider
are chosen. Have the privacy policy and terms checked by a lawyer before real
customers sign up.

Email addresses in the pages are wrapped in `<!--email_off-->` …
`<!--/email_off-->`. Without that, Cloudflare's Email Address Obfuscation
turns them into "[email protected]", and the decoding script it relies on
is blocked by the site's security headers. Keep the markers on any new
address.

## 2. Publish to Cloudflare Pages

Wrangler is the Cloudflare tool `deploy/inbox/setup.sh` already uses, so
you're logged in.

First time only:
```
cd ~/Projects/day2/day2/orchestrator && npx wrangler pages project create gora8-site --production-branch main
```

Every time the site changes:
```
cd ~/Projects/day2/day2/orchestrator && npx wrangler pages deploy site --project-name gora8-site --branch main
```

It prints an address like `https://gora8-site.pages.dev`. Open it to check.

## 3. Put it on gora8.com

1. Open **https://dash.cloudflare.com** → **Workers & Pages** → **gora8-site**.
2. Tab **Custom domains** → **Set up a custom domain**.
3. Enter `gora8.com` → **Continue** → **Activate domain**. Cloudflare adds the
   DNS record itself, because the domain is already in your account. If
   gora8.com already has an A or CNAME record (for example a parking page),
   Cloudflare asks to replace it: say yes.
4. Optional: repeat with `www.gora8.com`.
5. After a few minutes, https://gora8.com shows the site. `app.gora8.com` (the
   tunnel to your Mac) is not touched.

## 4. hello@gora8.com (free forwarding)

1. Cloudflare dashboard → click the domain **gora8.com** → **Email** →
   **Email Routing** → **Get started**.
2. **Custom address:** `hello` → **Destination:** your normal email address →
   **Create and continue**.
3. Cloudflare emails your normal address a confirmation link: click it.
4. Back in Cloudflare, click **Add records and enable**. It adds the MX and
   SPF records for you.
5. Test it: send an email to hello@gora8.com from another account.

This only receives. To also send as hello@gora8.com, you need a mail
provider (for example Google Workspace, Fastmail or Zoho) later. For Meta's
and Google's verification, receiving is enough.

## 5. Then the verifications

- **Meta Business verification** ([operator-setup.md](operator-setup.md),
  step 2e): website `https://gora8.com`; confirm by email to hello@gora8.com
  (it arrives in your normal inbox) or by phone.
- **Google verification** (operator-setup.md step 1h): home page
  `https://gora8.com`, privacy policy `https://gora8.com/privacy`, terms
  `https://gora8.com/terms`. Prove you own gora8.com in Google Search Console
  with a DNS TXT record (add it in Cloudflare → gora8.com → DNS).
