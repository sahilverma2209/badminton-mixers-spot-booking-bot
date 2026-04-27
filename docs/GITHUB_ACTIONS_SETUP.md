# GitHub Actions Setup Guide

This guide explains how to run the Mixers Booking Script automatically in the cloud using GitHub Actions — **for free, with no server to manage**.

---

## How It Works

- GitHub Actions runs `node src/booking.js` (a single check) every 15 minutes
- This replaces `scheduler.js` — GitHub's cron is the scheduler now
- Each run spins up a fresh Ubuntu machine, installs dependencies, runs the check, and shuts down
- Your credentials are stored as **encrypted GitHub Secrets** (never visible in logs or code)
- If a spot is found and booked, you get an email notification
- You have ~15 minutes to complete payment manually on CourtReserve

---

## Setup Steps (5 minutes)

### 1. Create a Private GitHub Repo

1. Go to [github.com/new](https://github.com/new) (log in with your **personal** account)
2. Name it `mixers-booking-script` (or anything you like)
3. Set visibility to **Private**
4. Do **not** initialize with README (you'll upload your own files)
5. Click **Create repository**

### 2. Upload Your Code

On the new repo page, click **"uploading an existing file"** and drag/drop these files:

```
Files to upload:
├── .github/
│   └── workflows/
│       └── booking.yml        ← the workflow file
├── docs/
│   ├── DEEP_DIVE.md
│   └── GITHUB_ACTIONS_SETUP.md
├── src/
│   ├── booking.js
│   └── scheduler.js
├── .gitignore
├── package.json
├── package-lock.json
└── README.md
```

> ⚠️ **DO NOT upload**: `.env`, `output/`, `node_modules/`, or `auth-state.json`
> These are in `.gitignore` for a reason — secrets and generated files stay local.

Commit directly to `main`.

### 3. Add Secrets

Go to your repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

Add these **required** secrets:

| Secret Name | Value | Required? |
|-------------|-------|-----------|
| `CR_EMAIL` | Your CourtReserve login email | ✅ Yes |
| `CR_PASSWORD` | Your CourtReserve password | ✅ Yes |

Add these for **email notifications** (highly recommended — this is how you'll know a booking was made):

| Secret Name | Value | Required? |
|-------------|-------|-----------|
| `NOTIFY_EMAIL_USER` | Your Gmail address (sender) | Recommended |
| `NOTIFY_EMAIL_PASS` | Gmail App Password ([how to create](https://support.google.com/accounts/answer/185833)) | Recommended |
| `NOTIFY_EMAIL_TO` | Email to receive notifications | Recommended |

### 4. Add Variables (Optional)

If you need to override defaults, go to **Settings** → **Secrets and variables** → **Actions** → **Variables** tab → **New repository variable**

| Variable Name | Default | Description |
|---------------|---------|-------------|
| `ORG_ID` | `7031` | CourtReserve Organization ID |
| `USER_ID` | `5384796` | Your CourtReserve User ID |
| `MEMBERSHIP_ID` | `2346339` | Your Membership ID |
| `EVENT_CONFIGS` | `19756:tuesday` | Event types & days (format: `19756:tuesday,thursday;54834:monday`) |
| `MAX_WEEKS_AHEAD` | `8` | How far ahead to look for events |

> 💡 **Secrets vs Variables**: Use **Secrets** for sensitive values (passwords, emails). Use **Variables** for non-sensitive configuration. Variables are visible in logs; Secrets are always masked.

### 5. Done! ✅

The workflow will automatically start running on the cron schedule. You can also:

- **Trigger manually**: Go to Actions tab → "Mixer Booking Check" → "Run workflow"
- **View run logs**: Actions tab → click on any run to see full output
- **Debug failures**: Failed runs upload screenshots as downloadable artifacts

---

## Adjusting the Schedule

Edit `.github/workflows/booking.yml` and change the cron expression:

```yaml
schedule:
  - cron: '*/15 * * * *'   # Every 15 minutes (default)
  # - cron: '*/30 * * * *' # Every 30 minutes
  # - cron: '*/5 * * * *'  # Every 5 minutes (uses more free minutes)
```

> **Note**: GitHub Actions cron uses **UTC timezone** and may be delayed by a few minutes during peak times. This is normal and fine for checking cancellation openings.

### Free Tier Budget

| Interval | Runs/Day | ~Minutes/Day | ~Minutes/Month | Within Free Tier (2000 min)? |
|----------|----------|-------------|----------------|------------------------------|
| Every 30 min | 48 | ~96 | ~2,880 | ⚠️ Tight — consider public repo |
| Every 15 min | 96 | ~192 | ~5,760 | ❌ Exceeds — use public repo (unlimited) |
| Every 5 min | 288 | ~576 | ~17,280 | ❌ Exceeds — use public repo (unlimited) |

> **Private repos**: 2,000 free minutes/month. **Public repos**: unlimited free minutes.
> Your secrets are **always encrypted** regardless of repo visibility — public repos are safe for this use case.

---

## Monitoring

### Check if it's running
Go to **Actions** tab in your GitHub repo. You'll see a list of all runs with ✅ (success) or ❌ (failure).

### View logs
Click on any run → click on the `check-and-book` job → expand the "Run booking check" step to see full script output.

### Debug failures
Failed runs automatically upload screenshots from the `output/` directory as downloadable artifacts (kept for 3 days).

---

## Disabling the Scheduler

To stop the automated runs:
1. Go to **Actions** tab → **Mixer Booking Check** (left sidebar)
2. Click the **"..."** menu → **Disable workflow**

Or simply delete the `booking.yml` file from the repo.

---

## Comparison: Local vs GitHub Actions

| Feature | Local (`npm start`) | GitHub Actions |
|---------|-------------------|----------------|
| Scheduler | `scheduler.js` + node-cron | GitHub cron trigger |
| Interval | Any (default 5 min) | 5-30 min (recommend 15) |
| Session persistence | `auth-state.json` saved between runs | Fresh login each run (~10s overhead) |
| macOS notifications | ✅ Desktop alerts | ❌ Not available (email only) |
| Email notifications | ✅ | ✅ |
| Secrets storage | `.env` file (plaintext) | GitHub Encrypted Secrets |
| Screenshots | Saved to `output/` | Uploaded as artifacts on failure |
| Requires laptop running | ✅ Yes | ❌ No — runs in the cloud |

---

## Troubleshooting

### Workflow not running on schedule
- Make sure the workflow file is on the `main` (or default) branch
- GitHub disables scheduled workflows on repos with no activity for 60 days — push a commit or run manually to re-enable

### Login failures
- Double-check `CR_EMAIL` and `CR_PASSWORD` secrets (update them if you changed your password)
- CourtReserve's Cloudflare protection may occasionally block headless browsers — usually resolves on the next run

### Email notifications not sending
- Verify `NOTIFY_EMAIL_USER`, `NOTIFY_EMAIL_PASS`, and `NOTIFY_EMAIL_TO` are all set
- Make sure you're using a [Gmail App Password](https://support.google.com/accounts/answer/185833), not your regular Gmail password
