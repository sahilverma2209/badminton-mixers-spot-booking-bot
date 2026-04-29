# 🏸 Mixers Booking Script

Automated booking script for **Bellevue Badminton Club Mixers** on CourtReserve. This script periodically checks for available spots in Mixer events and automatically books them when a cancellation opens up a slot.

## How It Works

1. **Launches a headless browser** (Playwright + Chromium)
2. **Logs into CourtReserve** with your credentials
3. **Navigates to the configured event pages** (e.g., Redmond Organized Play, Renton Organized Play)
4. **Checks each Mixer day** (configurable per event type via `EVENT_CONFIGS`) for available dates
5. **If a spot opens up** (someone cancelled), it **auto-books** immediately
6. **Sends a push notification** to your phone via [ntfy.sh](https://ntfy.sh) (and/or email)
7. **You complete payment manually** on CourtReserve within ~15 minutes

Scheduling is handled by **GitHub Actions** — the workflow runs every 5 minutes (configurable) so you don't need to keep your laptop running.

## Quick Start (GitHub Actions — Recommended) ☁️

The easiest way to run this is on GitHub Actions for **free**:

1. Push this repo to a **private GitHub repo**
2. Add `CR_EMAIL` and `CR_PASSWORD` as **encrypted GitHub Secrets** (Settings → Secrets → Actions)
3. Add email notification secrets (`NOTIFY_EMAIL_USER`, `NOTIFY_EMAIL_PASS`, `NOTIFY_EMAIL_TO`) so you get notified when a booking is made
4. The included workflow (`.github/workflows/booking.yml`) runs `node src/booking.js` every 5 minutes automatically

No server to manage, no Docker, no AWS. Secrets are encrypted and never exposed in logs.

👉 **Full setup guide**: [docs/GITHUB_ACTIONS_SETUP.md](docs/GITHUB_ACTIONS_SETUP.md)

## Quick Start (Local)

```bash
# 1. Install dependencies
npm install

# 2. Edit .env with your credentials
nano .env

# 3. Run a single check (with visible browser for debugging)
npm run debug

# 4. Run a single check (headless)
npm run check

# 5. Dry run (visible browser, stops before actually booking)
npm run dry-run
```

## Configuration

### GitHub Actions (Recommended)

Credentials are stored as **GitHub Secrets**, and configuration overrides as **GitHub Variables**. See [docs/GITHUB_ACTIONS_SETUP.md](docs/GITHUB_ACTIONS_SETUP.md) for details.

### Local (.env)

| Variable | Description | Default |
|----------|-------------|---------|
| `CR_EMAIL` | CourtReserve login email | — (required) |
| `CR_PASSWORD` | CourtReserve password | — (required) |
| `ORG_ID` | Organization ID | `7031` |
| `USER_ID` | Your user ID | `5384796` |
| `MEMBERSHIP_ID` | Your membership ID | `2346339` |
| `EVENT_CONFIGS` | Per-event-type day config (see below) | — |
| `MAX_WEEKS_AHEAD` | Max weeks into the future to book | `8` |
| `HEADLESS` | Run without visible browser | `true` |
| `ENABLE_NOTIFICATIONS` | Enable all notifications | `true` |
| `NTFY_TOPIC` | [ntfy.sh](https://ntfy.sh) topic for mobile push notifications | — |
| `NTFY_SERVER` | ntfy server URL (if self-hosting) | `https://ntfy.sh` |
| `NOTIFY_NO_SPOTS` | Where to send "no spots" alerts: `push`, `email`, `both`, `none` | `push` |
| `NOTIFY_EMAIL_USER` | Gmail address for sending notifications | — |
| `NOTIFY_EMAIL_PASS` | Gmail app password ([how to create](https://support.google.com/accounts/answer/185833)) | — |
| `NOTIFY_EMAIL_TO` | Email to receive notifications | — |

**Legacy variables** (used only if `EVENT_CONFIGS` is not set):

| Variable | Description | Default |
|----------|-------------|---------|
| `EVENT_TYPE_IDS` | Comma-separated event type IDs | `54834` (Redmond) |
| `PREFERRED_DAYS` | Days to book (shared across all event types) | `monday` |

### Event Configuration

Use `EVENT_CONFIGS` to set different preferred days per event type:

```bash
# Format: eventTypeId:day1,day2;eventTypeId:day3,day4
# Redmond on Mon/Wed/Fri, Renton on Tue/Thu:
EVENT_CONFIGS=54834:monday,wednesday,friday;19756:tuesday,thursday

# Find the evTypeId from the URL when you click a category:
# https://events.courtreserve.com/Online/Events/List/7031?evTypeId=XXXXX
```

### Mobile Push Notifications (ntfy.sh)

Get push notifications on your phone instead of email floods! Uses [ntfy.sh](https://ntfy.sh) — free, no account needed.

**Setup (2 minutes):**

1. Install the ntfy app: [iOS](https://apps.apple.com/us/app/ntfy/id1625396347) / [Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy)
2. Pick a unique topic name (e.g., `my-mixer-bot-x7k2`) — anyone with the name can see messages, so make it hard to guess
3. In the app, tap **+** and subscribe to your topic
4. Set the `NTFY_TOPIC` env var (or GitHub Secret) to your topic name

**Notification routing:**

| Event | Default behavior |
|-------|-----------------|
| ✅ Booking success | Email **+** push (high priority) |
| ❌ Script errors | Email **+** push |
| 🔍 No spots found | **Push only** (low priority) — keeps your inbox clean! |
| 🏃 Dry run | Email **+** push |

Control "no spots" routing with `NOTIFY_NO_SPOTS`:
- `push` (default) — phone notification only, no email
- `email` — email only (old behavior)
- `both` — both email and push
- `none` — silent (check logs in GitHub Actions instead)

## Commands

| Command | Description |
|---------|-------------|
| `npm run check` | Run a single check (headless) |
| `npm run debug` | Run with visible browser (for debugging) |
| `npm run dry-run` | Visible browser, stops before actually booking |
| `npm run dry-run:headless` | Headless, stops before booking |
| `npm start` | Start local cron polling *(deprecated — use GitHub Actions)* |

## Files

| File | Description |
|------|-------------|
| `src/booking.js` | Main automation script |
| `src/scheduler.js` | Local cron-based scheduler *(deprecated — replaced by GitHub Actions)* |
| `.github/workflows/booking.yml` | GitHub Actions workflow (primary scheduler) |
| `.env` | Local configuration (credentials, preferences) — **do not commit** |
| `output/auth-state.json` | Saved browser session (auto-generated, local only) |
| `output/booking.log` | Activity log (overwritten each run) |
| `output/booking-history.json` | Booking audit trail (reset each run) |
| `output/error-*.png` | Error screenshots (cleaned up each run; uploaded as GitHub Actions artifacts on failure) |
| `docs/GITHUB_ACTIONS_SETUP.md` | Full GitHub Actions setup guide |
| `docs/DEEP_DIVE.md` | Detailed technical deep dive |

## How Spots Become Available

The Mixers fill up fast. Spots open when someone **cancels their registration**. There's no waitlist, so it's first-come-first-served. This script checks every few minutes so you can grab a spot as soon as it opens.

## Troubleshooting

- **Login fails**: Make sure credentials in `.env` (or GitHub Secrets) are correct. Try `npm run debug` locally to see the browser.
- **Cloudflare challenge**: The script uses a real browser so Cloudflare challenges are handled automatically. If blocked, try running locally with `HEADLESS=false`.
- **Session expired** (local): Delete `output/auth-state.json` and run again to force a fresh login. GitHub Actions always does a fresh login.
- **No spots found**: This is normal! The script will keep checking on the next scheduled run. Check the GitHub Actions logs or local `output/booking.log` for history.
- **GitHub Actions workflow not running**: Make sure the workflow file is on the `main` branch. GitHub disables scheduled workflows on repos with no activity for 60 days.

## Running Locally in Background

If you prefer running locally instead of GitHub Actions:

```bash
# Using nohup (runs deprecated scheduler.js with node-cron)
nohup npm start > /dev/null 2>&1 &

# Or using screen/tmux
screen -S mixer
npm start
# Press Ctrl+A then D to detach
```

> **Note**: `npm start` uses the deprecated `src/scheduler.js` with `node-cron`. GitHub Actions is the recommended approach — it's free, doesn't require your laptop to stay on, and stores credentials securely.
