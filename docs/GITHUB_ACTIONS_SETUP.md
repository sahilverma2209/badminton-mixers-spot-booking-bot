# GitHub Actions Setup Guide

This guide explains how to run the Mixers Booking Script automatically in the cloud using GitHub Actions — **for free, with no server to manage**.

---

## How It Works

- A free external cron service ([cron-job.org](https://cron-job.org)) triggers the workflow every 5 minutes via GitHub's API
- GitHub Actions runs `node src/booking.js` (a single check) each time it's triggered
- This replaces `scheduler.js` — the external cron + GitHub Actions is the scheduler now
- Each run spins up a fresh Ubuntu machine, installs dependencies, runs the check, and shuts down
- Your credentials are stored as **encrypted GitHub Secrets** (never visible in logs or code)
- If a spot is found and booked, you get an email notification
- You have ~15 minutes to complete payment manually on CourtReserve

> **Why not use GitHub's built-in cron?** GitHub's `schedule` trigger is "best effort" — for low-activity repos, runs are routinely delayed by 30 minutes to 2+ hours. An external cron service calling `workflow_dispatch` is the only way to get reliable short-interval scheduling.

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

### 5. Set Up External Cron Trigger (Required for reliable 5-min intervals)

GitHub's built-in cron is unreliable for short intervals. Follow these steps to set up a free external cron service that triggers your workflow reliably every 5 minutes.

#### 5a. Create a GitHub Personal Access Token (PAT)

You have two options:

**Option A: Fine-grained token (recommended — more secure, but expires)**

1. Go to [github.com/settings/tokens?type=beta](https://github.com/settings/tokens?type=beta)
2. Click **"Generate new token"**
3. Configure:
   - **Token name**: `mixers-booking-cron`
   - **Expiration**: **1 year** (maximum allowed — set a calendar reminder to rotate it)
   - **Repository access**: Select **"Only select repositories"** → choose your repo
   - **Permissions** → **Repository permissions** → **Actions**: **Read and write**
4. Click **"Generate token"**
5. **Copy the token** — you won't see it again!

> 🔒 This is the most secure option — the token only has Actions access to a single repo. The downside is you need to regenerate it when it expires (max 1 year).

**Option B: Classic token (no expiration — set-and-forget)**

1. Go to [github.com/settings/tokens](https://github.com/settings/tokens) (classic tokens page)
2. Click **"Generate new token"** → **"Generate new token (classic)"**
3. Configure:
   - **Note**: `mixers-booking-cron`
   - **Expiration**: **No expiration**
   - **Scopes**: Check **`repo`** (Full control of private repositories)
4. Click **"Generate token"**
5. **Copy the token** — you won't see it again!

> ⚠️ This token has broader access (`repo` scope covers all your repos), but it never expires — good for a personal project where you don't want maintenance overhead.

#### 5b. Sign Up for cron-job.org

1. Go to [cron-job.org](https://cron-job.org) and create a free account
2. No credit card required — the free tier is more than sufficient

#### 5c. Create the Cron Job

1. Click **"CREATE CRONJOB"** in the dashboard
2. Fill in the fields:

| Field | Value |
|-------|-------|
| **Title** | `Mixers Booking Trigger` |
| **URL** | `https://api.github.com/repos/{OWNER}/{REPO}/actions/workflows/booking.yml/dispatches` |
| **Schedule** | Every **5 minutes** (use the "Every" dropdown) |
| **Request method** | `POST` |

> Replace `{OWNER}` with your GitHub username (e.g., `sahilverma2209`) and `{REPO}` with your repo name (e.g., `badminton-mixers-spot-booking-bot`).

3. Under **Advanced** → **Headers**, add these headers:

| Header | Value |
|--------|-------|
| `Authorization` | `Bearer YOUR_GITHUB_PAT_HERE` |
| `Accept` | `application/vnd.github.v3+json` |
| `Content-Type` | `application/json` |

4. Under **Advanced** → **Request body**, set:
```json
{"ref":"master"}
```

> ⚠️ Make sure this matches your repo's default branch name. Most repos use `main` or `master` — check your repo's settings if unsure.

5. Click **"CREATE"**

#### 5d. Test It

1. In cron-job.org, click the **"Test run"** button on your new job
2. Go to your GitHub repo → **Actions** tab
3. You should see a new workflow run triggered within seconds
4. If it shows a **✅ green check**, everything is working!

### 6. Done! ✅

The external cron will now trigger your workflow every 5 minutes reliably. You can also:

- **Trigger manually**: Go to Actions tab → "Mixer Booking Check" → "Run workflow"
- **View run logs**: Actions tab → click on any run to see full output
- **Debug failures**: Failed runs upload screenshots as downloadable artifacts

> **Fallback**: The workflow also has a built-in GitHub cron that runs every 2 hours as a safety net, in case cron-job.org is ever down.

---

## Free Tier Budget

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
1. **Pause the external cron**: Log into [cron-job.org](https://cron-job.org) and disable or delete the cron job
2. **Disable the GitHub workflow** (optional): Go to **Actions** tab → **Mixer Booking Check** → **"..."** menu → **Disable workflow**

Or simply delete the `booking.yml` file from the repo.

---

## Comparison: Local vs GitHub Actions

| Feature | Local (`npm start`) | GitHub Actions |
|---------|-------------------|----------------|
| Scheduler | `scheduler.js` + node-cron | External cron (cron-job.org) → `workflow_dispatch` |
| Interval | Any (default 5 min) | Every 5 min (reliable via external cron) |
| Session persistence | `auth-state.json` saved between runs | Fresh login each run (~10s overhead) |
| macOS notifications | ✅ Desktop alerts | ❌ Not available (email only) |
| Email notifications | ✅ | ✅ |
| Secrets storage | `.env` file (plaintext) | GitHub Encrypted Secrets |
| Screenshots | Saved to `output/` | Uploaded as artifacts on failure |
| Requires laptop running | ✅ Yes | ❌ No — runs in the cloud |

---

## Troubleshooting

### Workflow not being triggered by cron-job.org
- Log into [cron-job.org](https://cron-job.org) and check the job's **History** tab for HTTP response codes
- **HTTP 204**: Success — the workflow was triggered
- **HTTP 401/403**: Your GitHub PAT is invalid or expired — generate a new one (Step 5a) and update the cron job header
- **HTTP 404**: Check the URL — make sure `{OWNER}`, `{REPO}`, and `booking.yml` are correct
- **HTTP 422**: The `ref` in the request body doesn't match a branch — make sure `{"ref":"main"}` matches your default branch name

### GitHub PAT expired
- Fine-grained tokens expire after the period you set (e.g., 90 days)
- Generate a new token (Step 5a) and update the `Authorization` header in cron-job.org
- Set a calendar reminder to rotate before expiry

### Workflow not running on the fallback cron schedule
- Make sure the workflow file is on the `main` (or default) branch
- GitHub disables scheduled workflows on repos with no activity for 60 days — push a commit or run manually to re-enable

### Login failures
- Double-check `CR_EMAIL` and `CR_PASSWORD` secrets (update them if you changed your password)
- CourtReserve's Cloudflare protection may occasionally block headless browsers — usually resolves on the next run

### Email notifications not sending
- Verify `NOTIFY_EMAIL_USER`, `NOTIFY_EMAIL_PASS`, and `NOTIFY_EMAIL_TO` are all set
- Make sure you're using a [Gmail App Password](https://support.google.com/accounts/answer/185833), not your regular Gmail password
