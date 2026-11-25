# Fantasy Dog Draft

A small party game for the National Dog Show on Thanksgiving. Players pick 3 breeds in each of the 7 groups and score points as their breeds place. Everyone watches a live leaderboard with animations.

- Player site: `/`
- Results Desk (admin): `/admin`

## Scoring

| Event | Points |
|---|---|
| Wins its group | 6 |
| 2nd / 3rd / 4th in group (optional, leave blank for 0) | 3 / 2 / 1 |
| Reserve Best in Show (added to its group win) | 10 |
| Best in Show (added to its group win) | 15 |
| Any of the player's 3 Best in Show calls (ranked 1st-3rd) wins | +10 (once) |
| Underdog: you're the only player who picked the breed | that breed's points x2 |

Ties: more group winners picked, then whoever entered first.

Entries saved before the 3-call change keep their single call and still score with it. When those players load their picks, a pop-up asks them to add 2 more calls before saving.

## One-time setup (about 10 minutes)

### 1. Put the code on GitHub
1. Unzip this folder and open it in VS Code.
2. Open the Source Control panel and click **Publish to GitHub**. Choose a **private** repository.

### 2. Create the Vercel project
1. In Vercel, click **Add New > Project** and import the repo.
2. Framework Preset: **Other**. Leave the build settings alone (`vercel.json` handles them).
3. Open **Environment Variables** and add one:
   - `ADMIN_PASSWORD` = a password you choose (8+ characters). You use this to log in at `/admin`.
4. Click **Deploy**.

### 3. Add the database
1. In the project, open the **Storage** tab and click **Create Database**.
2. Choose **Neon** (serverless Postgres), keep the free plan, and connect it to this project for all environments.
3. Go to **Deployments**, open the menu on the latest deployment, and click **Redeploy**. The app needs the redeploy to pick up the new `DATABASE_URL`.

Tables are created automatically the first time someone loads the site.

### 4. Add your domain
1. Go to **Settings > Domains** and add `dogdraft.ethan-carn.work`.
2. Your DNS for `ethan-carn.work` is at Cloudflare. In Cloudflare, add the record Vercel shows. It is usually a CNAME named `dogdraft` that points to `cname.vercel-dns.com`. Set the proxy status to **DNS only** (grey cloud).
3. Wait for Vercel to show the domain as Valid.

## Testing before Thanksgiving

1. Enter a test entry or two on the site.
2. To test the live show without waiting for the lock, add an environment variable `LOCK_AT` with a past time (for example `2026-11-01T00:00:00Z`) and redeploy.
3. At `/admin`, announce a couple of winners and watch the game tab on another device.
4. When you're done:
   - delete `LOCK_AT` and redeploy
   - click **Reset results** in `/admin` (type RESET)
   - remove the test players

Picks lock by default at **noon Mountain Time on Thursday, Nov 26, 2026**. To change that, set `LOCK_AT` to any ISO time. For example, `2026-11-26T17:00:00Z` is noon Eastern.

## On Thanksgiving

- Keep `/admin` open on your phone and the game on the TV.
- As each group winner is announced, pick it and press **Announce**. Every screen updates within about 5 seconds.
- 2nd to 4th place are optional. You can pre-enter them with **Save hidden**, then press **Reveal** when you're ready.
- Finish with Reserve Best in Show, then Best in Show.

## Sign-in

The first page is a sign-in screen with two options: **Sign in with Google**, or **name + 4-digit PIN**. Players stay signed in on that device for 60 days through a secure, HttpOnly cookie. Signing in takes them straight to their picks.

- Entries made before sign-in existed sign in with the same name and PIN.
- If someone uses Google and an entry with the same name already exists, they enter that entry's PIN once to connect Google to it. After that, Google signs them straight in.
- If someone uses Google and no entry has their Google name, the site asks **"Have you already entered?"** *Yes* lets them type the name and PIN of their existing entry (for example "Sam" when Google says "Samuel") to connect it. *No, I'm new* creates their entry. This prevents accidental second teams.
- Players who haven't saved picks yet don't appear on the leaderboard. On `/admin` they show as "signed in, no picks yet".

### Turning on the Google button (one-time, about 10 minutes)

The Google button stays hidden until `GOOGLE_CLIENT_ID` is set. Name + PIN works either way.

1. Go to https://console.cloud.google.com and create a project, for example "Dog Draft".
2. Open **Google Auth Platform**. Under **Branding**, enter an app name (for example "Fantasy Dog Draft") and your email. Under **Audience**, choose **External**, then click **Publish app** so it's **In production**. If you leave it in "Testing", only test users you list can sign in. The site only asks for name and email, so Google doesn't need to review it.
3. Under **Clients**, choose **Create client**, then **Web application**. Under **Authorized JavaScript origins**, add:
   - `https://dogdraft.ethan-carn.work`
   - `https://dog-draft-dogdraft.vercel.app`

   No redirect URIs are needed.
4. Copy the **Client ID**. It ends in `.apps.googleusercontent.com`. The client ID isn't a secret; it's fine for it to be public.
5. In Vercel, go to **Settings > Environment Variables**, add `GOOGLE_CLIENT_ID` with that value, and redeploy.

## One entry per person

The first time a browser saves an entry, the site remembers that device. The same browser can then only edit that entry. It can't create a second one under a different name. Editing still works from any device with the right name and PIN.

This can be bypassed by clearing cookies, using a private window, or using another device. Check the player list on `/admin` before the lock, and use **Remove** for any duplicates. Two people who share one phone need to enter from separate devices.

## Anti-bot protection

These limits are invisible to normal players:

| Protection | Limit |
|---|---|
| Saves/loads per connection (IP) | 40 per 15 minutes |
| Attempts on one name (blocks PIN guessing) | 10 per 15 minutes |
| New entries per connection | 20 per hour (a whole party shares one Wi-Fi) |
| New entries site-wide | 60 per hour |
| Total players | 100 |
| Hidden "honeypot" field | Saves that fill it in are rejected |
| Admin login | 10 per 15 minutes |

To change a limit, edit `LIMITS` in `api/picks.js`. A CAPTCHA isn't used. For a private game this size it would add friction without much benefit. If a real attack ever happens, turn on Vercel's **Attack Challenge Mode** under the project's Firewall tab. It's one switch and needs no code.

## How it's built

- Static HTML/CSS/JS in `public/` with no framework and no build step.
- Vercel Functions in `api/`, with shared logic in `lib/`.
- Neon Postgres. Every query is parameterized.
- Security:
  - PINs are hashed with scrypt.
  - The admin session is an HMAC-signed HttpOnly, SameSite=Strict cookie.
  - Writes require JSON from the same origin.
  - Rate limits are stored in Postgres.
  - The pick lock and the 3-per-group rule are enforced on the server.
  - Hidden results are never sent to players.
  - The CSP allows scripts from this site only.
  - All names are rendered as text, never as HTML.
- Breed photos come from each breed's Wikipedia lead image through `/api/img`, which the CDN caches for a week.

## Development

```
npm install
npm test                      # API, scoring, and sign-in tests on in-memory Postgres
node tests/dev-server.mjs     # local site at http://localhost:3000 (admin password: dev-admin-password)
DEV_FAKE_GOOGLE=1 node tests/dev-server.mjs   # same, with test Google tokens at /__dev/gtoken
```
