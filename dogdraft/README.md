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
| Player's Best in Show call is right | +10 |
| Underdog: 2 or fewer players picked the breed | that breed's points x2 |

Ties: more group winners picked, then whoever entered first.

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
npm test                      # 23 API and scoring tests on in-memory Postgres
node tests/dev-server.mjs     # local site at http://localhost:3000 (admin password: dev-admin-password)
```
