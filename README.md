# 🏸 Mixers Booking Script

Automated booking script for **Bellevue Badminton Club Mixers** on CourtReserve. This script periodically checks for available spots in Mixer events and automatically books them when a cancellation opens up a slot.

## How It Works

1. **Launches a headless browser** (Playwright + Chromium)
2. **Logs into CourtReserve** with your credentials
3. **Navigates to the Mixers events page** (Redmond Organized Play)
4. **Checks each Mixer day** (Monday/Wednesday/Friday) for available dates
5. **If a spot opens up** (someone cancelled), it **auto-books** immediately
6. **Sends a macOS desktop notification** on success/failure
7. **Repeats every 3 minutes** (configurable)

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Edit .env with your credentials (already pre-filled)
nano .env

# 3. Run a single check (with visible browser for debugging)
npm run debug

# 4. Run a single check (headless)
npm run check

# 5. Start the scheduler (runs every 3 minutes)
npm start
```

## Configuration (.env)

| Variable | Description | Default |
|----------|-------------|---------|
| `CR_EMAIL` | CourtReserve login email | - |
| `CR_PASSWORD` | CourtReserve password | - |
| `ORG_ID` | Organization ID | `7031` |
| `USER_ID` | Your user ID | `5384796` |
| `MEMBERSHIP_ID` | Your membership ID | `2346339` |
| `EVENT_TYPE_IDS` | Comma-separated event type IDs | `54834` (Redmond) |
| `PREFERRED_DAYS` | Days to book | `monday,wednesday,friday` |
| `CHECK_INTERVAL_MINUTES` | Minutes between checks | `3` |
| `HEADLESS` | Run without visible browser | `true` |
| `ENABLE_NOTIFICATIONS` | macOS desktop notifications | `true` |

## Commands

| Command | Description |
|---------|-------------|
| `npm run check` | Run a single check (headless) |
| `npm run debug` | Run with visible browser (for debugging) |
| `npm start` | Start the scheduler (continuous polling) |

## Files

| File | Description |
|------|-------------|
| `booking.js` | Main automation script |
| `scheduler.js` | Cron-based scheduler |
| `.env` | Configuration (credentials, preferences) |
| `auth-state.json` | Saved browser session (auto-generated) |
| `booking.log` | Activity log |
| `captured-apis.json` | Captured API calls (for debugging) |
| `booking-*.png` | Screenshots on booking attempts |

## How Spots Become Available

The Mixers fill up fast. Spots open when someone **cancels their registration**. There's no waitlist, so it's first-come-first-served. This script checks every few minutes so you can grab a spot as soon as it opens.

## Adding More Locations

You can monitor multiple event categories by adding their IDs to `EVENT_TYPE_IDS` in `.env`:

```
# Find the evTypeId from the URL when you click a category:
# https://events.courtreserve.com/Online/Events/List/7031?evTypeId=XXXXX
EVENT_TYPE_IDS=54834,12345
```

## Troubleshooting

- **Login fails**: Make sure credentials in `.env` are correct. Try `npm run debug` to see the browser.
- **Cloudflare challenge**: The script uses a real browser so Cloudflare challenges are handled automatically. If blocked, try running with `HEADLESS=false`.
- **Session expired**: Delete `auth-state.json` and run again to force a fresh login.
- **No spots found**: This is normal! The script will keep checking. Look at `booking.log` for history.

## Running in the Cloud (GitHub Actions) ☁️

Don't want to keep your laptop running? Host it on GitHub Actions for **free**:

1. Push this repo to a **private GitHub repo** (or upload via the GitHub web UI)
2. Add your credentials as **encrypted GitHub Secrets** (Settings → Secrets → Actions)
3. The included workflow (`.github/workflows/booking.yml`) runs `node src/booking.js` every 15 minutes automatically

No server to manage, no Docker, no AWS. Secrets are encrypted and never exposed in logs.

👉 **Full setup guide**: [docs/GITHUB_ACTIONS_SETUP.md](docs/GITHUB_ACTIONS_SETUP.md)

## Running in Background (Local)

To keep it running in the background on your laptop:

```bash
# Using nohup
nohup npm start > /dev/null 2>&1 &

# Or using screen/tmux
screen -S mixer
npm start
# Press Ctrl+A then D to detach
```
