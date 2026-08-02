# Deploying to SmarterASP.NET (iisnode)

App **and** database run on SmarterASP. The database is already provisioned and
migrated (`db_ab7950_farmacademy`); this covers getting the Node app live.

All the app's dependencies are **pure JavaScript** (no native compilation), so
`node_modules` is portable — you can upload it directly and skip running `npm`
on the host (the more reliable path on shared hosting).

## 0. What you need
- Your SmarterASP hosting login (control panel + FTP).
- The site's URL (temporary `*.xtempurl.com` / `*.smarterasp.net`, or a custom domain).
- Node.js 18+ selected for the site.

## 1. Create the Node.js site (once)
In the SmarterASP control panel:
1. **Websites → (your site)** — this is the same account as your SQL database.
2. Set the **Node.js version to 18+** (SmarterASP has a Node version selector).
3. The site root is typically `wwwroot`. The app's entry is `src/server.js`, wired
   up by `web.config` — no separate "startup file" setting needed beyond that.

## 2. Fill in web.config (secrets live here, never in the repo)
Copy `web.config.example` → `web.config` and set every `<appSettings>` value:
- `APP_BASE_URL` = your real `https://…` URL (no trailing slash)
- `SESSION_SECRET` = the long random string provided separately
- `DB_*` = the SmarterASP SQL values (same as local `.env`)
- `STRIPE_SECRET_KEY` = `sk_test_…` for now (swap to `sk_live_…` at go-live)
- `STRIPE_WEBHOOK_SECRET` = filled in step 6
- `DB_ENCRYPT=true`, `DB_TRUST_SERVER_CERT=true`

`web.config` is gitignored — it is uploaded to the host, never committed.

## 3. Upload the files
Upload the project to the site root (`wwwroot`), **including `node_modules`** but
**excluding** `.git`, `.env`, `iisnode/`, and any scratch files. Two ways:
- **Zip + extract (recommended):** upload the provided `deploy.zip` via the control-panel
  **File Manager**, then **Extract** it in place. One transfer instead of ~10k files.
- **FTP:** point FileZilla at the site's FTP and drag the folder up (slower —
  `node_modules` is ~10k files).

If you'd rather NOT upload `node_modules`: upload everything else, then use the
panel's Node.js **npm install** action (run `npm install --omit=dev`). Slower and
occasionally flaky on shared hosting, which is why bundling is preferred.

## 4. First load
Browse to your URL. `web.config` routes all traffic to `src/server.js` via iisnode
and forces HTTPS.
- Success → you land on the parent login (`/portal/login`); go to `/admin/login`.
- Error → read `iisnode/*.txt` logs in the File Manager; most first-boot failures
  are a wrong `DB_*` value or a missing appSetting. `loggingEnabled` is on for this.

## 5. SSL (required — login cookies are secure-only in production)
Enable **Let's Encrypt** for the domain in the SmarterASP SSL section (a couple of
clicks, free). The app redirects HTTP→HTTPS, so the cert must be valid first.

## 6. Stripe webhook (after SSL is live)
1. Stripe Dashboard (test mode) → **Developers → Webhooks → Add endpoint**.
2. URL: `https://<your-domain>/webhooks/stripe`
3. Events: `invoice.paid`, `invoice.payment_failed`, `charge.refunded`.
4. Copy the endpoint's **Signing secret** (`whsec_…`) into `web.config`
   `STRIPE_WEBHOOK_SECRET`, then recycle the app (touch `web.config`).

## 7. Verify
- Admin login works (`chris@keylitix.com`).
- Roster loads with the current (test) data.
- Create a plan on a test family → check the Stripe test dashboard.
- Send a test event from the Stripe webhook page → confirm it reaches the ledger.

## Go-live (later)
1. Clear the test families (one command — keeps admin + tuition rate).
2. Swap `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` to **live** values and add a
   live-mode webhook endpoint.
3. Office brings in real families (New family / Import CSV).

## Operational
- iisnode recycles the app pool on idle — the app holds no in-memory state
  (sessions are in SQL), so this is safe; expect an occasional slow cold start.
- Schedule an offsite SQL backup and test a restore once.
