<!-- git -c user.name="Sahil" -c user.email="sahilverma.0922@gmail.com" push personal master -->

# Project End-to-End Deep Dive

## 1. Executive Summary

**Mixers Booking Script** is an automation tool that monitors the [CourtReserve](https://events.courtreserve.com) event platform for available spots in **Bellevue Badminton Club Mixer** sessions and automatically books them when a cancellation opens a slot. It solves the problem that Mixer events (badminton group play sessions) fill up instantly and have no waitlist — spots only become available when someone cancels, making manual monitoring impractical.

The system uses **Playwright** (headless Chromium) to simulate a real browser session, intercepts CourtReserve's AJAX API responses to detect availability, and drives the booking flow up to registration: **Login → Browse Events → Detect Open Slot → Register → Finalize Registration**. Payment is left for the user to complete manually (~15 minute hold). Scheduling is handled by **GitHub Actions** cron workflows that run `node src/booking.js` on a recurring interval. Notifications are delivered via **email (Gmail/nodemailer)**; macOS desktop alerts are also supported when running locally.

**The primary deployment target is GitHub Actions (Ubuntu runners).** The script can also be run locally on a developer's machine for debugging. There are no custom cloud infrastructure stacks, no databases, and no deployed services beyond the GitHub Actions workflow.

---

## 2. High-Level Architecture

```
┌──────────────────────────────────────────────────────────────┐
│              GitHub Actions (ubuntu-latest)                    │
│              .github/workflows/booking.yml                    │
│                                                              │
│  ┌─────────────────────────┐                                 │
│  │ Workflow: cron schedule  │   ┌──────────────┐             │
│  │ (every N minutes)       │──►│  booking.js   │             │
│  │ OR manual dispatch      │   │ (main logic)  │             │
│  └─────────────────────────┘   └───────┬───────┘             │
│                                        │                     │
│  Secrets & Variables:           Playwright                    │
│  CR_EMAIL, CR_PASSWORD,         (Chromium)                   │
│  NOTIFY_EMAIL_*, etc.                  │                     │
│                                        │                     │
│  ┌─────────────────────────────────────┼─────────────────┐   │
│  │         Ephemeral File System       │                 │   │
│  │  output/booking.log                 │                 │   │
│  │  output/booking-history.json        │                 │   │
│  │  output/*.png (screenshots)         │                 │   │
│  │  (all discarded after each run)     │                 │   │
│  └─────────────────────────────────────┼─────────────────┘   │
│                                        │                     │
│  ┌──────────────────┐                  │                     │
│  │  nodemailer       │                 │                     │
│  │  (Gmail SMTP)     │                 │                     │
│  └──────────────────┘                  │                     │
└────────────────────────────────────────┼─────────────────────┘
                                         │ HTTPS
                         ┌───────────────▼─────────────────────┐
                         │      CourtReserve Platform          │
                         │  events.courtreserve.com            │
                         │  api2.courtreserve.com              │
                         │  (behind Cloudflare CDN)            │
                         │                                     │
                         │  ┌─────────┐  ┌──────────────┐     │
                         │  │ Stripe  │  │  New Relic    │     │
                         │  │(payments)│  │  (telemetry)  │     │
                         │  └─────────┘  └──────────────┘     │
                         └─────────────────────────────────────┘

                    ┌──────────────────────────────────────┐
                    │   LOCAL (optional, for debugging)     │
                    │                                      │
                    │   npm run check / npm run debug       │
                    │   → node src/booking.js               │
                    │   → Playwright (Chromium)             │
                    │   → macOS osascript (notifications)   │
                    │   → .env (credentials)                │
                    │   → output/ (persistent across runs)  │
                    └──────────────────────────────────────┘
```

### Components at a Glance

| Component | File | Role |
|-----------|------|------|
| **GitHub Actions Workflow** | `.github/workflows/booking.yml` | Cron-based scheduler: triggers `node src/booking.js` every N minutes on Ubuntu runners |
| **Booking Engine** | `src/booking.js` | Core automation: login, event discovery, availability parsing, registration, notifications |
| **Scheduler (deprecated)** | `src/scheduler.js` | Legacy local cron loop using `node-cron`; **not actively used** — replaced by GitHub Actions |
| **API Explorer** | `docs/explore-apis.js` | Development/debugging utility — captures all HTTP traffic during a manual booking flow |
| **Captured Flow** | `docs/captured-booking-flow.json` | Artifact from `explore-apis.js` — reference HTTP trace of a real booking |
| **Configuration** | `.env` (local) / GitHub Secrets & Variables (cloud) | Credentials, org/user IDs, event configs, intervals |

---

## 3. Infrastructure Topology

### 3.1 GitHub Actions (Primary Deployment)

The script runs as a **GitHub Actions scheduled workflow** (`.github/workflows/booking.yml`):

- **Runner**: `ubuntu-latest` (ephemeral, fresh each run)
- **Trigger**: Cron schedule (`*/5 * * * *` — every 5 minutes, configurable) + manual `workflow_dispatch`
- **Concurrency**: `concurrency.group: booking-check` with `cancel-in-progress: false` prevents overlapping runs
- **Timeout**: 10 minutes per run
- **Credentials**: Stored as encrypted GitHub Secrets (never exposed in logs)
- **Failure artifacts**: On failure, screenshots from `output/` are uploaded as downloadable artifacts (retained 3 days)

### 3.2 Runtime Artifacts

All runtime artifacts are written to the `output/` directory. In GitHub Actions, these are **ephemeral** (discarded after each run unless uploaded as artifacts on failure). When running locally, they persist across runs but are reset at the start of each run.

| Resource | Type | Purpose | Lifecycle |
|----------|------|---------|-----------|
| `.env` | Environment file (local only) | All configuration and secrets | Not used in GitHub Actions (secrets/variables instead) |
| `output/auth-state.json` | JSON file | Playwright browser storage state (cookies/localStorage) for session persistence | **Local only** — fresh login each run in GitHub Actions |
| `output/booking.log` | Text file | Activity log with timestamps | **Overwritten** at the start of each run |
| `output/booking-history.json` | JSON file | Audit trail of booking attempts during this run | **Reset** at the start of each run |
| `output/*.png` | Screenshot files | Diagnostic screenshots on errors | **Cleaned up** at the start of each run; uploaded as GitHub Actions artifacts on failure |

### 3.3 External Dependencies (SaaS)

| Service | Domain | Role |
|---------|--------|------|
| **GitHub Actions** | `github.com` | Scheduled execution of booking checks |
| **CourtReserve** | `events.courtreserve.com` | Primary target — event management platform |
| **CourtReserve API** | `api2.courtreserve.com` | Secondary API host for member dashboard data |
| **Cloudflare** | CDN/WAF in front of CourtReserve | Anti-bot protection the script must bypass |
| **Stripe** | `js.stripe.com` | Payment processing (loaded as iframe on payment page) |
| **New Relic** | `bam.nr-data.net` | CourtReserve's browser telemetry (not used by the script) |
| **Gmail SMTP** | `smtp.gmail.com` | Outbound email notifications (optional) |

---

## 4. Service Components

### 4.1 `src/booking.js` — Main Automation Engine (~550 LOC)

This is the heart of the system. It exports `{ run, CONFIG }` and is invoked directly as `node src/booking.js` (by GitHub Actions or local npm scripts).

#### 4.1.1 Configuration Layer

```javascript
const CONFIG = {
  email,              // CourtReserve login email
  password,           // CourtReserve login password
  orgId,              // Organization ID (default: 7031 = Bellevue Badminton Club)
  userId,             // User's CourtReserve ID (default: 5384796)
  membershipId,       // Membership ID (default: 2346339)
  eventConfigs,       // Object: { eventTypeId: [days] } — parsed from EVENT_CONFIGS or legacy vars
  headless,           // Boolean — run Chromium visibly or headless
  enableNotifications,// Boolean — macOS + email notifications
  maxWeeksAhead,      // Max future weeks to consider (default: 4)
  dryRun,             // Boolean — stop before actually booking (--dry-run flag)
};
```
#### 4.1.2 Core Functions

| Function | Purpose |
|----------|---------|
| `run()` | Top-level orchestrator: resets output files, launches browser → login → check events → close |
| `parseEventConfigs()` | Parses `EVENT_CONFIGS` env var (or falls back to legacy `EVENT_TYPE_IDS` + `PREFERRED_DAYS`) |
| `login(page)` | Navigates to CourtReserve, fills credentials, handles Cloudflare wait, saves auth state |
| `checkAndBookMixers(page, intercepted)` | Iterates event configs, navigates to event lists, filters by preferred days, checks availability |
| `parseEventCards(page)` | DOM scraper: extracts event card titles and "VIEW DATES" links from the events list page |
| `parseAvailableDates(html)` | HTML parser: extracts register URLs, dates, times, and spot counts from AJAX response |
| `bookSpot(page, spot, eventName, intercepted)` | Navigates to registration URL or clicks REGISTER button |
| `fallbackDomCheck(page, eventName, intercepted)` | DOM-based fallback when API interception misses data |
| `handleSignUpAndPayment(page, eventName, dateInfo, intercepted)` | **Core booking flow**: verifies SignUp page → clicks Finalize Registration → handles payment redirect |
| `setupResponseInterceptor(page)` | Attaches Playwright response listeners to capture AJAX API responses |
| `notify(title, message)` | Dual notification: macOS `osascript` (silently fails if not on macOS) + email via nodemailer |
| `sendEmail(subject, body)` | Gmail SMTP email with HTML formatting |
| `recordBooking(...)` | Records booking attempt to `booking-history.json` |
| `loadBookingHistory()` / `saveBookingHistory()` | Read/write the booking history JSON file |
| `formatRegisteredSubject(eventName, dateInfo)` | Formats email subject as `"{Location} Mixer {date} Registered"` |
| `isDateWithinRange(dateStr)` | Filters events beyond `maxWeeksAhead` |

#### 4.1.3 Browser Automation Strategy

The script uses **Playwright with Chromium** (not a simple HTTP client) because:

1. **Cloudflare Protection**: CourtReserve sits behind Cloudflare's anti-bot system. A real browser with proper user-agent and JavaScript execution is needed.
2. **AJAX-Heavy UI**: CourtReserve loads most content via AJAX calls (jQuery). The event list, dates, signup form, and payment form are all dynamically loaded.
3. **Session Management**: Playwright's `storageState` API persists cookies/localStorage to `auth-state.json`, avoiding re-login on subsequent local runs. In GitHub Actions, a fresh login occurs each run (no persistent state).

### 4.2 `.github/workflows/booking.yml` — GitHub Actions Scheduler

The **primary scheduling mechanism**. Key features:

1. **Cron trigger**: `*/5 * * * *` (every 5 minutes, UTC) — configurable in the YAML
2. **Manual trigger**: `workflow_dispatch` allows on-demand runs from the GitHub Actions tab
3. **Concurrency guard**: `concurrency.group: booking-check` with `cancel-in-progress: false` prevents overlapping runs (equivalent to the `isRunning` flag in the deprecated scheduler.js)
4. **Environment**: Sets up Node.js 20, installs dependencies (`npm ci`), installs Playwright Chromium, then runs `node src/booking.js`
5. **Secrets/Variables**: Credentials from GitHub Secrets, optional config from GitHub Variables
6. **Failure handling**: Uploads `output/*.png` screenshots as artifacts on failure (retained 3 days)

### 4.3 `src/scheduler.js` — Legacy Local Scheduler (DEPRECATED, ~50 LOC)

**Not actively used.** The file header explicitly states: *"Currently not used; scheduling is done via GitHub workflows."*

A thin wrapper around `booking.js` that used `node-cron` for local cron-based scheduling:
1. Imports `{ run, CONFIG }` from `booking.js`
2. Reads `CHECK_INTERVAL_MINUTES` from environment (default: 5)
3. Runs `run()` immediately on startup
4. Schedules `run()` via `node-cron` at `*/N * * * *`
5. **Concurrency guard**: `isRunning` flag prevents overlapping executions
6. **Graceful shutdown**: Handles `SIGINT` and `SIGTERM`

This file is kept in the repository in case local scheduling is needed in the future, but the `npm start` script that invokes it is a legacy command.

### 4.4 `docs/explore-apis.js` — API Discovery Tool (~170 LOC)

A **development-time utility** (not part of the production booking flow) that:

1. Launches a **visible** (non-headless) Chromium browser
2. Attaches request/response interceptors that log ALL CourtReserve HTTP traffic
3. Replays a manual booking flow step by step:
   - Load site → Navigate to Renton events → Find Tuesday Mixer → Click REGISTER → Click Finalize → Click Pay
4. Saves all captured requests/responses to `captured-booking-flow.json`
5. This artifact was used to reverse-engineer CourtReserve's API contracts for building the automated `booking.js`

### 4.5 `docs/captured-booking-flow.json` — API Trace Artifact

A JSON file containing the HTTP requests and responses captured during a real booking session. Key observations from the captured data:

- The flow targets **Organization 7031** (Bellevue Badminton Club)
- Event type **19756** = Renton Organized Play
- The specific booking was for **"Renton Mixer: Tuesday 6:30pm -- UBR REQUIRED"**
- Event ID: `1723437`, Reservation ID: `45283243`
- The event had **24 max members**, **$16.50 per occurrence** + tax
- Payment is processed via Stripe

---

## 5. End-to-End Data Flow

### 5.1 Complete Booking Sequence

```
GitHub Actions          booking.js          Chromium/Playwright      CourtReserve
(or local run)              │                       │                      │
   │                        │                       │                      │
   │──node src/booking.js──►│                       │                      │
   │                        │──reset output files───│                      │
   │                        │──launch()─────────────►│                      │
   │                        │                       │──GET /─────────────►  │
   │                        │                       │◄──login page──────── │
   │                        │                       │──POST credentials──►  │
   │                        │                       │◄──session cookie───── │
   │                        │◄─login success────────│                      │
   │                        │                       │                      │
   │                        │──navigate events──────►│──GET /Events/List──►│
   │                        │  (for each eventConfig)│◄──HTML page──────── │
   │                        │◄─parseEventCards()─────│                      │
   │                        │                       │                      │
   │                        │──navigate dates────────►│──GET /Events/Details►│
   │                        │  (for each mixer)      │◄──HTML + AJAX──────│
   │                        │                       │                      │
   │                        │  [response interceptor captures              │
   │                        │   Event_GetAdditionalDates]                  │
   │                        │                       │                      │
   │                        │──parseAvailableDates()──│                     │
   │                        │  → REGISTER URL found!  │                     │
   │                        │                       │                      │
   │                        │──navigate register──────►│──GET /SignUpToEvent►│
   │                        │                       │◄──SignUp page HTML───│
   │                        │                       │◄──AJAX form content──│
   │                        │                       │                      │
   │                        │──click Finalize─────────►│──POST DropIn_Post─►│
   │                        │                       │◄──redirect to payment─│
   │                        │                       │                      │
   │                        │──recordBooking()────────│  (payment is manual)│
   │                        │──notify("Registered!")───│                     │
   │                        │──save auth state────────│  (local only)       │
   │                        │──close browser──────────►│                     │
   │◄─return bookings───────│                       │                      │
   │                        │                       │                      │
   │  (GitHub Actions run ends; next cron trigger)   │                      │
```

### 5.2 Data Lifecycle Detail

| Phase | Data Source | Transform | Storage |
|-------|-----------|-----------|---------|
| Config Load | `.env` file (local) or GitHub Secrets/Variables (cloud) | `dotenv` parsing, `parseEventConfigs()` | In-memory `CONFIG` object |
| Session Restore | `auth-state.json` (local only) | Playwright `storageState` | Browser context cookies/localStorage |
| Event Discovery | CourtReserve `/Events/List` page | `parseEventCards()` — DOM query for `.dates-list-link` elements | In-memory array |
| Day Filtering | Event card titles | String matching against per-event-type `preferredDays` from `CONFIG.eventConfigs` | In-memory filtered array |
| Availability Detection | AJAX `Event_GetAdditionalDates` response | `parseAvailableDates()` — regex for `EventAction=Register` URLs | In-memory `available[]` |
| Date Range Filter | Parsed date strings | `isDateWithinRange()` — compare to `maxWeeksAhead` | In-memory filtered array |
| Registration | Form POST to `EventApi_SignUpToEvent_DropIn_Post` | Browser form submission with CSRF token | Server-side (CourtReserve) |
| Payment | **Manual** — user completes within 15 min hold | Not automated | Server-side (Stripe + CourtReserve) |
| Booking Record | Success/failure result | `recordBooking()` → write to JSON | `booking-history.json` (reset each run) |
| Activity Log | Every step's log message | Timestamped string formatting | `booking.log` (overwritten each run) + stdout |
| Screenshots | Browser viewport on errors | Playwright `.screenshot()` | `output/*.png` files (cleaned up at start of each run; uploaded as GitHub Actions artifacts on failure) |
| Session Save | Browser cookies/localStorage | Playwright `storageState()` | `auth-state.json` (local only; not used in GitHub Actions) |

---

## 6. API Contracts

### 6.1 CourtReserve APIs Called (Outbound)

#### 6.1.1 Event List Page
- **URL**: `GET https://events.courtreserve.com/Online/Events/List/{orgId}?evTypeId={evTypeId}`
- **Purpose**: Load the event category page showing all recurring events
- **Response**: Full HTML page with event cards
- **Auth**: Cookie-based session

#### 6.1.2 Event Details / Additional Dates (AJAX, intercepted)
- **URL**: `GET https://events.courtreserve.com/Online/EventsApi/Event_GetAdditionalDates?eventId={eventId}&...`
- **Purpose**: Load upcoming dates for a recurring event with availability status
- **Response**: HTML fragment containing date rows, each with REGISTER or FULL status
- **Key Data**: Register URLs with `EventAction=Register`, spot counts, dates/times

#### 6.1.3 Event Details API (AJAX, intercepted)
- **URL**: `GET https://events.courtreserve.com/Online/EventsApi/ApiDetails?number={eventNumber}&...`
- **Purpose**: Full event details (used by the CourtReserve frontend)
- **Response**: HTML fragment (~40KB)

#### 6.1.4 Sign-Up Page
- **URL**: `GET https://events.courtreserve.com/Online/Events/SignUpToEvent/{orgId}?eventId={eventId}&reservationId={reservationId}&reservationNumber={reservationNumber}`
- **Purpose**: Load the registration page for a specific event occurrence
- **Response**: HTML page (shell), actual form loaded via AJAX

#### 6.1.5 Sign-Up Form (AJAX)
- **URL**: `GET https://events.courtreserve.com/Online/EventsApi/EventApi_SignUpToEvent_Get?id={orgId}&eventId={eventId}&reservationId={reservationId}&reservationNumber={reservationNumber}&...`
- **Purpose**: Load the actual registration form HTML
- **Response**: HTML fragment (~27KB) containing a `<form id="Eventsignup-form">` with:
  - CSRF token (`__RequestVerificationToken`)
  - Member info (pre-filled)
  - Event details
  - "Finalize Registration" button

#### 6.1.6 Finalize Registration (POST) ⭐ Critical
- **URL**: `POST https://events.courtreserve.com//Online/EventsApi/EventApi_SignUpToEvent_DropIn_Post/{orgId}?uiCulture=en-US`
- **Content-Type**: `application/x-www-form-urlencoded`
- **Key Form Fields** (from captured flow):
  | Field | Example Value |
  |-------|---------------|
  | `__RequestVerificationToken` | CSRF token |
  | `RequestData` | Encrypted/encoded session data |
  | `CurrentMember.Id` | `5384796` |
  | `CurrentMember.LastName` | `Verma` |
  | `CurrentMember.FirstName` | `Sahil` |
  | `CurrentMember.OrganizationMemberId` | `4093491` |
  | `EventId` | `1723437` |
  | `EventName` | `Renton Mixer: Tuesday 6:30pm -- UBR REQUIRED` |
  | `EventTypeId` | `19756` |
  | `MaxMembers` | `24` |
  | `SelectedReservation.Id` | `45283243` |
  | `SelectedReservation.Number` | `XHHHPH57031170` |
  | `SelectedReservation.Start` | `5/12/2026 6:30:00 PM` |
  | `SelectedReservation.End` | `5/12/2026 8:30:00 PM` |
  | `RequireOnlinePayment` | `True` |
  | `HoldTimeForReservation` | `15` (minutes) |
  | `OccurrenceCost` | `16.5` |
  | `IsTaxable` | `True` |
- **Response**: JavaScript redirect to payment page (via `succesEventSignUp` callback)
- **Response Size**: ~4.8KB

#### 6.1.7 Payment Page
- **URL**: `GET https://events.courtreserve.com/Online/Payments/ProcessPayment/{orgId}?evAction=4`
- **Purpose**: Shell page for payment processing
- **Note**: Takes ~4.6s server response time (from captured data)

#### 6.1.8 Payment Content (AJAX)
- **URL**: `GET https://events.courtreserve.com/Online/Payments/ProcessPayment/{orgId}?resId=&evAction=4&...&loadHtmlContent=true`
- **Purpose**: Load the actual payment form with saved card info and Pay button
- **Response**: HTML fragment with Stripe elements

#### 6.1.9 Member Dashboard (AJAX, background)
- **URL**: `GET https://api2.courtreserve.com/Online/Utils/Member_GetDashboardData?orgId={orgId}&userId={userId}&membershipId={membershipId}&...`
- **Purpose**: Background check for unpaid reservations, announcements, etc.
- **Response**: `{"isValid":true,"hasUnPaidReservations":false,...}` (260 bytes)
- **Note**: This call goes to `api2.courtreserve.com` (separate host from the main site)

### 6.2 Third-Party Services (Called by CourtReserve, not by the script)

| Service | Purpose | Note |
|---------|---------|------|
| **Stripe** (`js.stripe.com/v3/`) | Payment processing iframe | Script interacts via Playwright clicking, not direct API calls |
| **New Relic** (`bam.nr-data.net`) | Browser performance monitoring | CourtReserve's telemetry; script doesn't use it |
| **Cloudflare RUM** (`cdn-cgi/rum`) | Real User Monitoring | Cloudflare analytics; automatic in browser |
| **Azure Blob Storage** (`tgcstorage.blob.core.windows.net`) | Organization logo/images | Static asset hosting |
| **ASP.NET SignalR** (`/signalr/hubs`) | Real-time notifications hub | CourtReserve's real-time features |

### 6.3 Authentication Model

- **Type**: Cookie-based session (ASP.NET)
- **Login**: Form POST with email/password to standard ASP.NET MVC login endpoint
- **Session Persistence (local)**: Playwright's `storageState` saves all cookies and localStorage to `auth-state.json`; on subsequent local runs, the saved state is loaded to avoid re-login
- **Session Persistence (GitHub Actions)**: None — each run performs a fresh login since there is no persistent storage between workflow runs
- **CSRF Protection**: CourtReserve uses `__RequestVerificationToken` anti-forgery tokens in forms (handled automatically by Playwright's form submission)
- **Cloudflare Challenge**: Handled by running a real Chromium browser (Playwright) rather than raw HTTP requests

---

## 7. Deployment

### 7.1 GitHub Actions (Primary)

The script is deployed as a **GitHub Actions scheduled workflow**:

- **Runner**: `ubuntu-latest` (ephemeral VM)
- **Schedule**: Cron-based (`*/5 * * * *` by default, configurable in `booking.yml`)
- **Trigger**: Automatic (cron) + manual (`workflow_dispatch` via GitHub Actions UI)
- **Credentials**: GitHub Encrypted Secrets (never exposed in logs or code)
- **No persistent state**: Each run starts fresh — no `auth-state.json`, no session carry-over
- **Failure artifacts**: Screenshots uploaded as downloadable GitHub Actions artifacts (retained 3 days)
- **macOS notifications**: Silently skipped (not available on Ubuntu runners); email notifications are the primary alerting channel

See `docs/GITHUB_ACTIONS_SETUP.md` for the full setup guide.

### 7.2 Local Execution (Optional, for debugging)

The script can still be run locally via `npm run check`, `npm run debug`, or `npm run dry-run`. When run locally:

- Reads credentials from `.env` file
- Persists session to `output/auth-state.json` for faster subsequent runs
- Supports macOS desktop notifications via `osascript`
- The legacy `npm start` command invokes `src/scheduler.js` for local cron-based polling (deprecated in favor of GitHub Actions)

---
## 8 Notifications (Alerting)

| Channel | Trigger | Implementation | Availability |
|---------|---------|----------------|--------------|
| Email (Gmail) | Spot found & registered, booking errors, no spots found | `nodemailer` with Gmail SMTP; requires `NOTIFY_EMAIL_USER`, `NOTIFY_EMAIL_PASS`, `NOTIFY_EMAIL_TO` | GitHub Actions ✅ + Local ✅ |
| macOS Desktop | Same triggers | `osascript` command (silently fails if not on macOS) | Local only ✅ (silently skipped in GitHub Actions) |

---

## 9. Security Model

### 9.1 Credential Storage

| Secret | Storage (GitHub Actions) | Storage (Local) | Risk |
|--------|-------------------------|-----------------|------|
| CourtReserve email/password | GitHub Encrypted Secrets | `.env` file (plaintext) | **LOW** (cloud) / **HIGH** (local — no encryption; mitigated only by not committing `.env`) |
| Gmail app password | GitHub Encrypted Secrets | `.env` file (plaintext) | **LOW** (cloud) / **HIGH** (local — same as above) |
| Session cookies | Not persisted (fresh login each run) | `auth-state.json` (plaintext JSON) | **N/A** (cloud) / **MEDIUM** (local — contains full browser session) |
| CSRF tokens | In-memory only | In-memory only | **LOW** — ephemeral |
| Payment card info | **Not stored locally** — handled by Stripe/CourtReserve | Same | **LOW** — card is saved server-side on CourtReserve's Stripe account |

### 9.2 `.gitignore` Protection

The following are excluded from version control:
```
node_modules/
output/
```


---

---

## 11. Appendix

### A. Textual Sequence Diagram — Happy Path Booking

```
GitHub Actions       booking.js          Chromium/Playwright      CourtReserve
(cron trigger)           │                       │                      │
   │                     │                       │                      │
   │─node src/booking.js►│                       │                      │
   │                     │──reset output files───│                      │
   │                     │──launch()─────────────►│                      │
   │                     │                       │──GET /─────────────►  │
   │                     │                       │◄──login page──────── │
   │                     │                       │──POST login──────►   │
   │                     │                       │◄──session cookie──── │
   │                     │◄─login success────────│                      │
   │                     │                       │                      │
   │                     │──navigate events──────►│──GET /Events/List──►│
   │                     │  (per eventConfig)    │◄──HTML page──────── │
   │                     │◄─parseEventCards()─────│                      │
   │                     │                       │                      │
   │                     │──navigate dates────────►│──GET /Events/Details►│
   │                     │  (for each mixer)      │◄──HTML + AJAX──────│
   │                     │                       │                      │
   │                     │  [response interceptor captures              │
   │                     │   Event_GetAdditionalDates]                  │
   │                     │                       │                      │
   │                     │──parseAvailableDates()──│                     │
   │                     │  → REGISTER URL found!  │                     │
   │                     │                       │                      │
   │                     │──navigate register──────►│──GET /SignUpToEvent►│
   │                     │                       │◄──SignUp page HTML───│
   │                     │                       │◄──AJAX form content──│
   │                     │                       │                      │
   │                     │──click Finalize─────────►│──POST DropIn_Post─►│
   │                     │                       │◄──redirect to payment─│
   │                     │                       │                      │
   │                     │──recordBooking()────────│  (payment is manual)│
   │                     │──notify("Registered!")───│                     │
   │                     │──close browser──────────►│                     │
   │◄─exit 0─────────────│                       │                      │
   │                     │                       │                      │
   │  (workflow ends; next cron trigger in N min) │                      │
```

### B. Dependency Tree

```
mixers-booking-script@1.0.0
├── dotenv@17.4.2          — Environment variable loading from .env
├── node-cron@4.2.1        — Cron expression scheduler (used by deprecated scheduler.js only)
├── nodemailer@8.0.6       — Email sending (Gmail SMTP)
└── playwright@1.59.1      — Browser automation (bundles Chromium)
    └── (chromium binary)   — ~150MB headless browser
```

### C. npm Scripts

| Script | Command | Purpose |
|--------|---------|---------|
| `npm run check` | `node src/booking.js` | Single headless check |
| `npm run debug` | `HEADLESS=false node src/booking.js` | Single check with visible browser |
| `npm run dry-run` | `HEADLESS=false node src/booking.js --dry-run` | Visible browser, stops before booking |
| `npm run dry-run:headless` | `node src/booking.js --dry-run` | Headless, stops before booking |
| `npm start` | `node src/scheduler.js` | Start local cron polling **(deprecated — use GitHub Actions instead)** |

### D. Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CR_EMAIL` | **Yes** | — | CourtReserve login email |
| `CR_PASSWORD` | **Yes** | — | CourtReserve login password |
| `ORG_ID` | No | `7031` | Organization ID |
| `USER_ID` | No | `5384796` | User's CourtReserve ID |
| `MEMBERSHIP_ID` | No | `2346339` | Membership ID |
| `EVENT_CONFIGS` | No | — | Per-event-type day config. Format: `19756:tuesday,thursday;54834:monday,wednesday,friday` |
| `EVENT_TYPE_IDS` | No | `54834` | *(Legacy fallback)* Comma-separated event type IDs. Used only if `EVENT_CONFIGS` is not set. |
| `PREFERRED_DAYS` | No | `monday` | *(Legacy fallback)* Comma-separated day names. Used only if `EVENT_CONFIGS` is not set. |
| `CHECK_INTERVAL_MINUTES` | No | `5` | Minutes between scheduler checks (used by deprecated `scheduler.js` only; GitHub Actions uses the cron expression in `booking.yml`) |
| `MAX_WEEKS_AHEAD` | No | `8` | Max weeks into the future to book |
| `HEADLESS` | No | `true` | Run browser without GUI |
| `ENABLE_NOTIFICATIONS` | No | `true` | Enable email + macOS notifications |
| `NOTIFY_EMAIL_USER` | No | — | Gmail address for sending notifications |
| `NOTIFY_EMAIL_PASS` | No | — | Gmail app password |
| `NOTIFY_EMAIL_TO` | No | — | Recipient email address |

### E. File Artifacts Generated at Runtime

All runtime artifacts are written to the `output/` directory:

| File | Created By | Lifecycle |
|------|-----------|-----------|
| `output/auth-state.json` | `booking.js` after login | **Local only**: overwritten each run; deleted to force re-login. Not created in GitHub Actions. |
| `output/booking.log` | `booking.js` | **Overwritten** at the start of each run (first log entry uses `writeFileSync`, subsequent use `appendFileSync`) |
| `output/booking-history.json` | `booking.js` on booking attempt | **Reset** at the start of each run (initialized to `{ bookings: [] }`) |
| `output/error-*-{timestamp}.png` | `booking.js` on failures only | **Cleaned up** at the start of each run. In GitHub Actions, uploaded as downloadable artifacts on failure (retained 3 days). |

### F. GitHub Actions Workflow Configuration

Key settings in `.github/workflows/booking.yml`:

| Setting | Value | Notes |
|---------|-------|-------|
| **Trigger (cron)** | `*/5 * * * *` | Every 5 minutes (UTC); adjustable |
| **Trigger (manual)** | `workflow_dispatch` | Run on-demand from Actions tab |
| **Runner** | `ubuntu-latest` | Ephemeral VM |
| **Node.js** | `20` | With npm cache |
| **Timeout** | `10 minutes` | Per job |
| **Concurrency group** | `booking-check` | `cancel-in-progress: false` — queues, does not cancel |
| **Required secrets** | `CR_EMAIL`, `CR_PASSWORD` | Login credentials |
| **Optional secrets** | `NOTIFY_EMAIL_USER`, `NOTIFY_EMAIL_PASS`, `NOTIFY_EMAIL_TO` | Email notifications |
| **Optional variables** | `ORG_ID`, `USER_ID`, `MEMBERSHIP_ID`, `EVENT_CONFIGS`, `MAX_WEEKS_AHEAD` | Config overrides |
| **Failure artifacts** | `output/*.png` | Uploaded on failure, retained 3 days |
