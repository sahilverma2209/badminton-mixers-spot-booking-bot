# Project End-to-End Deep Dive

## 1. Executive Summary

**Mixers Booking Script** is a local-machine automation tool that monitors the [CourtReserve](https://events.courtreserve.com) event platform for available spots in **Bellevue Badminton Club Mixer** sessions and automatically books them when a cancellation opens a slot. It solves the problem that Mixer events (badminton group play sessions) fill up instantly and have no waitlist — spots only become available when someone cancels, making manual monitoring impractical.

The system uses **Playwright** (headless Chromium) to simulate a real browser session, intercepts CourtReserve's AJAX API responses to detect availability, and drives the booking flow up to registration: **Login → Browse Events → Detect Open Slot → Register → Finalize Registration**. Payment is left for the user to complete manually (~15 minute hold). A **cron-based scheduler** polls every N minutes, and notifications are delivered via **macOS desktop alerts** and **email (Gmail/nodemailer)**.

**There is no cloud infrastructure, no CDK stacks, no deployed services, no databases, and no regional topology.** This is a single-user, single-machine Node.js script designed to run on a developer's macOS laptop (or in a `screen`/`nohup` background process).

> **Confidence: HIGH** — All source code has been read end-to-end. The project is small (4 JS files, ~700 LOC) with no hidden modules or generated code.

---

## 2. High-Level Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    Developer's macOS Machine                  │
│                                                              │
│  ┌─────────────┐     imports      ┌──────────────┐          │
│  │ scheduler.js │ ──────────────► │  booking.js   │          │
│  │ (node-cron)  │   run() every   │ (main logic)  │          │
│  │              │   N minutes     │               │          │
│  └─────────────┘                  └───────┬───────┘          │
│                                           │                  │
│                                    Playwright                │
│                                    (Chromium)                │
│                                           │                  │
│  ┌────────────────────────────────────────┼──────────────┐   │
│  │            Local File System           │              │   │
│  │  .env              auth-state.json     │              │   │
│  │  booking.log       booking-history.json│              │   │
│  │  *.png (screenshots)                   │              │   │
│  └────────────────────────────────────────┼──────────────┘   │
│                                           │                  │
│  ┌──────────────┐   ┌──────────────────┐  │                  │
│  │ macOS osascript│  │  nodemailer      │  │                  │
│  │ (notifications)│  │  (Gmail SMTP)    │  │                  │
│  └──────────────┘   └──────────────────┘  │                  │
└───────────────────────────────────────────┼──────────────────┘
                                            │ HTTPS
                         ┌──────────────────▼──────────────────┐
                         │      CourtReserve Platform          │
                         │  events.courtreserve.com            │
                         │  api2.courtreserve.com              │
                         │  (behind Cloudflare CDN)            │
                         │                                     │
                         │  ┌─────────┐  ┌──────────────┐     │
                         │  │ Stripe  │  │  New Relic    │     │
                         │  │ (payments)│ │  (telemetry)  │     │
                         │  └─────────┘  └──────────────┘     │
                         └─────────────────────────────────────┘
```

### Components at a Glance

| Component | File | Role |
|-----------|------|------|
| **Scheduler** | `scheduler.js` | Cron loop that invokes `run()` every N minutes with concurrency guard |
| **Booking Engine** | `booking.js` | Core automation: login, event discovery, availability parsing, registration, payment |
| **API Explorer** | `explore-apis.js` | Development/debugging utility — captures all HTTP traffic during a manual booking flow |
| **Captured Flow** | `captured-booking-flow.json` | Artifact from `explore-apis.js` — reference HTTP trace of a real booking |
| **Configuration** | `.env` | Credentials, org/user IDs, preferred days, intervals |

---

## 3. Infrastructure Topology

### 3.1 There Is No Cloud Infrastructure

This project has:
- **No CDK/CloudFormation/Terraform stacks**
- **No AWS/GCP/Azure resources**
- **No Lambda functions, ECS tasks, or containers**
- **No databases (RDS, DynamoDB, etc.)**
- **No queues (SQS, SNS, etc.)**
- **No API Gateway or load balancers**
- **No CI/CD pipeline**
- **No Docker configuration**

### 3.2 Local "Infrastructure"

All runtime artifacts are written to the `output/` directory to keep the project root clean:

| Resource | Type | Purpose |
|----------|------|---------|
| `.env` | Environment file (project root) | All configuration and secrets |
| `output/auth-state.json` | JSON file (auto-generated) | Playwright browser storage state (cookies/localStorage) for session persistence |
| `output/booking.log` | Append-only text file | Activity log with timestamps |
| `output/booking-history.json` | JSON file | Audit trail of all booking attempts (success/failure) |
| `output/*.png` | Screenshot files | Diagnostic screenshots captured at each flow step and on errors |

### 3.3 External Dependencies (SaaS)

| Service | Domain | Role |
|---------|--------|------|
| **CourtReserve** | `events.courtreserve.com` | Primary target — event management platform |
| **CourtReserve API** | `api2.courtreserve.com` | Secondary API host for member dashboard data |
| **Cloudflare** | CDN/WAF in front of CourtReserve | Anti-bot protection the script must bypass |
| **Stripe** | `js.stripe.com` | Payment processing (loaded as iframe on payment page) |
| **New Relic** | `bam.nr-data.net` | CourtReserve's browser telemetry (not used by the script) |
| **Gmail SMTP** | `smtp.gmail.com` | Outbound email notifications (optional) |

---

## 4. Service Components

### 4.1 `booking.js` — Main Automation Engine (~550 LOC)

This is the heart of the system. It exports `{ run, CONFIG }` and can be invoked standalone (`node booking.js`) or imported by the scheduler.

#### 4.1.1 Configuration Layer

```javascript
const CONFIG = {
  email,            // CourtReserve login email
  password,         // CourtReserve login password
  orgId,            // Organization ID (default: 7031 = Bellevue Badminton Club)
  userId,           // User's CourtReserve ID (default: 5384796)
  membershipId,     // Membership ID (default: 2346339)
  eventTypeIds,     // Array of event category IDs to monitor
  preferredDays,    // Array of day names (e.g., ["tuesday"])
  headless,         // Boolean — run Chromium visibly or headless
  enableNotifications, // Boolean — macOS + email notifications
  maxWeeksAhead,    // Max future weeks to consider (default: 4)
  dryRun,           // Boolean — stop before actually booking (--dry-run flag)
};
```

Source: `.env` file via `dotenv`, with sensible defaults hardcoded.

#### 4.1.2 Core Functions

| Function | Purpose |
|----------|---------|
| `run()` | Top-level orchestrator: launches browser → login → check events → close |
| `login(page)` | Navigates to CourtReserve, fills credentials, handles Cloudflare wait, saves auth state |
| `checkAndBookMixers(page, intercepted)` | Iterates event type IDs, navigates to event lists, filters by preferred days, checks availability |
| `parseEventCards(page)` | DOM scraper: extracts event card titles and "VIEW DATES" links from the events list page |
| `parseAvailableDates(html)` | HTML parser: extracts register URLs, dates, times, and spot counts from AJAX response |
| `bookSpot(page, spot, eventName, intercepted)` | Navigates to registration URL or clicks REGISTER button |
| `fallbackDomCheck(page, eventName, intercepted)` | DOM-based fallback when API interception misses data |
| `handleSignUpAndPayment(page, eventName, dateInfo, intercepted)` | **Core booking flow**: verifies SignUp page → clicks Finalize Registration → handles payment redirect |
| `setupResponseInterceptor(page)` | Attaches Playwright response listeners to capture AJAX API responses |
| `notify(title, message)` | Dual notification: macOS `osascript` + email via nodemailer |
| `sendEmail(subject, body)` | Gmail SMTP email with HTML formatting |
| `recordBooking(...)` | Appends to `booking-history.json` audit log |
| `isDateWithinRange(dateStr)` | Filters events beyond `maxWeeksAhead` |

#### 4.1.3 Browser Automation Strategy

The script uses **Playwright with Chromium** (not a simple HTTP client) because:

1. **Cloudflare Protection**: CourtReserve sits behind Cloudflare's anti-bot system. A real browser with proper user-agent and JavaScript execution is needed.
2. **AJAX-Heavy UI**: CourtReserve loads most content via AJAX calls (jQuery). The event list, dates, signup form, and payment form are all dynamically loaded.
3. **Session Management**: Playwright's `storageState` API persists cookies/localStorage to `auth-state.json`, avoiding re-login on every run.

### 4.2 `scheduler.js` — Cron Loop (~50 LOC)

A thin wrapper around `booking.js`:

1. Imports `{ run, CONFIG }` from `booking.js`
2. Reads `CHECK_INTERVAL_MINUTES` from environment (default: 5)
3. Runs `run()` immediately on startup
4. Schedules `run()` via `node-cron` at `*/N * * * *` (every N minutes)
5. **Concurrency guard**: `isRunning` flag prevents overlapping executions if a run takes longer than the interval
6. **Graceful shutdown**: Handles `SIGINT` and `SIGTERM`

### 4.3 `explore-apis.js` — API Discovery Tool (~170 LOC)

A **development-time utility** (not part of the production booking flow) that:

1. Launches a **visible** (non-headless) Chromium browser
2. Attaches request/response interceptors that log ALL CourtReserve HTTP traffic
3. Replays a manual booking flow step by step:
   - Load site → Navigate to Renton events → Find Tuesday Mixer → Click REGISTER → Click Finalize → Click Pay
4. Saves all captured requests/responses to `captured-booking-flow.json`
5. This artifact was used to reverse-engineer CourtReserve's API contracts for building the automated `booking.js`

### 4.4 `captured-booking-flow.json` — API Trace Artifact

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
┌──────────┐     ┌──────────────┐     ┌───────────────────────┐
│ scheduler │────►│  booking.js  │────►│    CourtReserve        │
│  (cron)   │     │   run()      │     │  events.courtreserve   │
└──────────┘     └──────┬───────┘     └───────────┬───────────┘
                        │                         │
  STEP 1: Launch Browser (Playwright/Chromium)    │
                        │                         │
  STEP 2: Login ────────┼── GET / ───────────────►│
                        │◄─ Login page HTML ──────│
                        │── POST credentials ────►│
                        │◄─ Redirect to Portal ───│
                        │── Save auth-state.json  │
                        │                         │
  STEP 3: Browse ───────┼── GET /Events/List/7031 │
  Events                │   ?evTypeId=19756 ─────►│
                        │◄─ Events list HTML ─────│
                        │                         │
  STEP 4: Check ────────┼── GET Event Details ───►│
  Each Mixer            │   (click "DATES" tab)   │
                        │                         │
  STEP 5: Intercept ────┼◄─ AJAX: ApiLoadEvents ──│
  API Responses         │◄─ AJAX: GetAdditional   │
                        │   Dates (HTML w/ slots)  │
                        │                         │
  STEP 6: Parse ────────┤  parseAvailableDates()  │
  Availability          │  → finds "REGISTER"     │
                        │    links in HTML         │
                        │                         │
  ═══ IF SPOT FOUND ════╪══════════════════════════╪═══
                        │                         │
  STEP 7: Register ─────┼── GET /Events/SignUp ───►│
                        │   ToEvent/7031?eventId   │
                        │   =X&reservationId=Y ──►│
                        │◄─ SignUp page HTML ──────│
                        │                         │
  STEP 8: Load ─────────┼◄─ AJAX: EventApi_SignUp │
  Registration Form     │   ToEvent_Get (27KB) ───│
                        │                         │
  STEP 9: Finalize ─────┼── POST EventApi_SignUp  │
  Registration          │   ToEvent_DropIn_Post ─►│
                        │   (form data w/ CSRF    │
                        │    token, member info,   │
                        │    event details) ──────►│
                        │◄─ Redirect JS ──────────│
                        │                         │
  STEP 10: Registered ──┤  → Redirected to payment│
                        │    page (not automated)  │
                        │                         │
  STEP 11: Notify ──────┤  → macOS notification   │
                        │  → Email notification    │
                        │  → booking-history.json  │
                        │  → booking.log           │
                        │                         │
  STEP 12: Save ────────┤  → auth-state.json      │
  State & Close         │  → Close browser         │
```

### 5.2 Data Lifecycle Detail

| Phase | Data Source | Transform | Storage |
|-------|-----------|-----------|---------|
| Config Load | `.env` file | `dotenv` parsing, CSV splitting for arrays | In-memory `CONFIG` object |
| Session Restore | `auth-state.json` | Playwright `storageState` | Browser context cookies/localStorage |
| Event Discovery | CourtReserve `/Events/List` page | `parseEventCards()` — DOM query for `.dates-list-link` elements | In-memory array |
| Day Filtering | Event card titles | String matching against `CONFIG.preferredDays` | In-memory filtered array |
| Availability Detection | AJAX `Event_GetAdditionalDates` response | `parseAvailableDates()` — regex for `EventAction=Register` URLs | In-memory `available[]` |
| Date Range Filter | Parsed date strings | `isDateWithinRange()` — compare to `maxWeeksAhead` | In-memory filtered array |
| Registration | Form POST to `EventApi_SignUpToEvent_DropIn_Post` | Browser form submission with CSRF token | Server-side (CourtReserve) |
| Payment | **Manual** — user completes within 15 min hold | Not automated | Server-side (Stripe + CourtReserve) |
| Booking Record | Success/failure result | `recordBooking()` → append to JSON array | `booking-history.json` |
| Activity Log | Every step's log message | Timestamped string formatting | `booking.log` + stdout |
| Screenshots | Browser viewport at key moments | Playwright `.screenshot()` | `*.png` files |
| Session Save | Browser cookies/localStorage | Playwright `storageState()` | `auth-state.json` |

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
- **Session Persistence**: Playwright's `storageState` saves all cookies and localStorage to `auth-state.json`
- **Session Restore**: On subsequent runs, the saved state is loaded into the browser context, avoiding re-login
- **CSRF Protection**: CourtReserve uses `__RequestVerificationToken` anti-forgery tokens in forms (handled automatically by Playwright's form submission)
- **Cloudflare Challenge**: Handled by running a real Chromium browser (Playwright) rather than raw HTTP requests

---

## 7. Deployment Regions

### Not Applicable

This is a **single-machine, local-execution script**. There is no:
- Multi-region deployment
- Active-active or active-passive architecture
- Regional routing
- Failover strategy
- Data residency concerns

The script runs on the developer's macOS machine (evidenced by `osascript` notifications, the Bellevue/Renton WA geography of the badminton clubs, and the `America/Los_Angeles` timezone in logging).

### Potential Remote Execution

The README mentions running in background via `nohup` or `screen`/`tmux`, implying it's designed for a single always-on machine. There's no evidence of cloud deployment (no Dockerfile, no `Procfile`, no serverless config).

---

## 8. Failure Handling

### 8.1 Error Recovery

| Scenario | Handling |
|----------|----------|
| **Login failure** | Throws error with "invalid credentials" message; screenshot saved |
| **Cloudflare block** | 10-second initial wait; README suggests `HEADLESS=false` as workaround |
| **Session expired** | Script attempts login; user can delete `auth-state.json` for fresh session |
| **Event not found** | Logs "No Mixer events matching preferred days"; continues to next event type |
| **No REGISTER buttons** | Logs status (N Register, N Full); moves to next event |
| **Registration error** | Checks for `.validation-summary-errors`; logs error text; screenshots |
| **SweetAlert modal** | Checks for `.swal2-container` text; detects "full" or "error" messages |
| **Payment page not loading** | Dual strategy: waits for intercepted AJAX content OR spinner disappearance (20s timeout) |
| **Fatal exception** | Caught at top level in `run()`; browser closed; error notification sent |

### 8.2 Concurrency Guard

The scheduler uses an `isRunning` boolean flag to prevent overlapping executions:

```javascript
if (isRunning) {
  log('Previous check still running, skipping this cycle.');
  return;
}
```

### 8.3 Retry Strategy

- **No automatic retries on failure** within a single run
- **Implicit retry via scheduler**: the cron loop will retry on the next cycle (every N minutes)
- **No exponential backoff**
- **No circuit breaker**

### 8.4 Logging & Observability

| Output | Location | Format |
|--------|----------|--------|
| Activity log | `booking.log` + stdout | `[timestamp] [LEVEL] message` |
| Booking audit | `booking-history.json` | JSON array of `{eventName, date, success, timestamp, ...}` |
| Debug screenshots | `*.png` files | Full-page screenshots at: login, signup form, payment page, errors, success |
| API traces | Intercepted in memory | Logged to console during run |

### 8.5 Notifications (Alerting)

| Channel | Trigger | Implementation |
|---------|---------|----------------|
| macOS Desktop | Spot found, booking success/failure, errors | `osascript` command (silently fails if not on macOS) |
| Email (Gmail) | Same triggers | `nodemailer` with Gmail SMTP; requires `NOTIFY_EMAIL_USER`, `NOTIFY_EMAIL_PASS`, `NOTIFY_EMAIL_TO` in `.env` |

---

## 9. Security Model

### 9.1 Credential Storage

| Secret | Storage | Risk |
|--------|---------|------|
| CourtReserve email/password | `.env` file (plaintext) | **HIGH** — no encryption; mitigated only by `.gitignore` excluding `.env` |
| Gmail app password | `.env` file (plaintext) | **HIGH** — same as above |
| Session cookies | `auth-state.json` (plaintext JSON) | **MEDIUM** — contains full browser session; excluded from git |
| CSRF tokens | In-memory only | **LOW** — ephemeral |
| Payment card info | **Not stored locally** — handled by Stripe/CourtReserve | **LOW** — card is saved server-side on CourtReserve's Stripe account |

### 9.2 `.gitignore` Protection

The entire `output/` directory and secrets are excluded from version control:
```
.env
output/
captured-apis.json
```

### 9.3 Network Security

- All communication over **HTTPS** (TLS)
- CourtReserve behind **Cloudflare** (WAF + DDoS protection)
- The script uses a spoofed **user-agent** mimicking Chrome 120 on macOS
- **No API keys or tokens** are used — authentication is purely cookie-based

### 9.4 Access Boundaries

- Script has access to **one user's account only** (the configured credentials)
- Cannot access other users' data or bookings
- Payment uses the user's **pre-saved card on Stripe** — script does not handle raw card numbers

---

## 10. Unknowns / Risks

### 10.1 Unknowns

| Item | Confidence | Notes |
|------|-----------|-------|
| **Stripe payment flow details** | MEDIUM | The script clicks a Pay button but doesn't know the exact Stripe API calls; it relies on browser-level interaction |
| **CourtReserve rate limiting** | LOW | No evidence the script handles HTTP 429 or IP-based rate limiting; 3-5 minute intervals may be safe but unconfirmed |
| **Cloudflare bot detection evolution** | LOW | Cloudflare may update its bot detection, potentially blocking Playwright; the current `webdriverDetected: true` in New Relic traces suggests CourtReserve can see it's automated |
| **CourtReserve TOS compliance** | UNKNOWN | Automated booking may violate CourtReserve's Terms of Service |
| **Hold time behavior** | MEDIUM | The captured data shows `HoldTimeForReservation: 15` (minutes); if payment isn't completed within 15 minutes, the registration may be released |

### 10.2 Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Credentials in plaintext** | HIGH | Use a secrets manager or OS keychain; currently only protected by `.gitignore` |
| **WebDriver detection** | MEDIUM | New Relic traces show `webdriverDetected: true`; CourtReserve could block automated access |
| **DOM/API changes breaking the script** | HIGH | The script relies on specific CSS selectors, URL patterns, and HTML structure; any CourtReserve UI update could break it |
| **Double-booking** | LOW | No deduplication check; if the script runs and a spot opens, it will book without checking if the user already has a booking for that date |
| **Financial risk** | LOW | The script only registers; payment is manual. No automatic charges. |
| **Screenshot disk usage** | LOW | Screenshots accumulate on disk without cleanup; each run can produce multiple PNG files |

### 10.3 Dead Code / Unused Features

| Item | Status |
|------|--------|
| `explore-apis.js` | Development utility only; not part of the production flow |
| `captured-booking-flow.json` | Reference artifact; not read by any production code |
| Multiple payment button selectors (20+) | Many are defensive/speculative; only a few will match in practice |

---

## 11. Appendix

### A. Textual Sequence Diagram — Happy Path Booking

```
Scheduler           booking.js          Chromium/Playwright      CourtReserve
   │                    │                       │                      │
   │──run()────────────►│                       │                      │
   │                    │──launch()─────────────►│                      │
   │                    │                       │──GET /─────────────►  │
   │                    │                       │◄──login page──────── │
   │                    │                       │──POST login──────►   │
   │                    │                       │◄──session cookie──── │
   │                    │◄─login success────────│                      │
   │                    │                       │                      │
   │                    │──navigate events──────►│──GET /Events/List──►│
   │                    │                       │◄──HTML page──────── │
   │                    │◄─parseEventCards()─────│                      │
   │                    │                       │                      │
   │                    │──navigate dates────────►│──GET /Events/Details►│
   │                    │  (for each mixer)      │◄──HTML + AJAX──────│
   │                    │                       │                      │
   │                    │  [response interceptor captures              │
   │                    │   Event_GetAdditionalDates]                  │
   │                    │                       │                      │
   │                    │──parseAvailableDates()──│                     │
   │                    │  → REGISTER URL found!  │                     │
   │                    │                       │                      │
   │                    │──notify("Spot Found!")──│                     │
   │                    │                       │                      │
   │                    │──navigate register──────►│──GET /SignUpToEvent►│
   │                    │                       │◄──SignUp page HTML───│
   │                    │                       │◄──AJAX form content──│
   │                    │                       │                      │
   │                    │──click Finalize─────────►│──POST DropIn_Post─►│
   │                    │                       │◄──redirect to payment─│
   │                    │                       │                      │
   │                    │──recordBooking()────────│  (payment is manual)│
   │                    │──notify("Registered!")───│                     │
   │                    │──save auth state────────│                     │
   │                    │──close browser──────────►│                     │
   │◄─return bookings───│                       │                      │
   │                    │                       │                      │
   │──schedule next─────│ (wait N minutes)       │                      │
```

### B. Dependency Tree

```
mixers-booking-script@1.0.0
├── dotenv@17.4.2          — Environment variable loading from .env
├── node-cron@4.2.1        — Cron expression scheduler
├── nodemailer@8.0.6       — Email sending (Gmail SMTP)
└── playwright@1.59.1      — Browser automation (bundles Chromium)
    └── (chromium binary)   — ~150MB headless browser
```

### C. npm Scripts

| Script | Command | Purpose |
|--------|---------|---------|
| `npm run check` | `node booking.js` | Single headless check |
| `npm run debug` | `HEADLESS=false node booking.js` | Single check with visible browser |
| `npm run dry-run` | `HEADLESS=false node booking.js --dry-run` | Visible browser, stops before booking |
| `npm run dry-run:headless` | `node booking.js --dry-run` | Headless, stops before booking |
| `npm start` | `node scheduler.js` | Start continuous polling |

### D. Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CR_EMAIL` | **Yes** | — | CourtReserve login email |
| `CR_PASSWORD` | **Yes** | — | CourtReserve login password |
| `ORG_ID` | No | `7031` | Organization ID |
| `USER_ID` | No | `5384796` | User's CourtReserve ID |
| `MEMBERSHIP_ID` | No | `2346339` | Membership ID |
| `EVENT_TYPE_IDS` | No | `19756` | Comma-separated event type IDs |
| `PREFERRED_DAYS` | No | `tuesday` | Comma-separated day names |
| `CHECK_INTERVAL_MINUTES` | No | `5` | Minutes between scheduler checks |
| `MAX_WEEKS_AHEAD` | No | `4` | Max weeks into the future to book |
| `HEADLESS` | No | `true` | Run browser without GUI |
| `ENABLE_NOTIFICATIONS` | No | `true` | Enable macOS + email notifications |
| `NOTIFY_EMAIL_USER` | No | — | Gmail address for sending notifications |
| `NOTIFY_EMAIL_PASS` | No | — | Gmail app password |
| `NOTIFY_EMAIL_TO` | No | — | Recipient email address |

### E. File Artifacts Generated at Runtime

All runtime artifacts are written to the `output/` directory:

| File | Created By | Lifecycle |
|------|-----------|-----------|
| `output/auth-state.json` | `booking.js` after login | Overwritten each run; deleted to force re-login |
| `output/booking.log` | `booking.js` + `scheduler.js` | Appended every run; grows unbounded |
| `output/booking-history.json` | `booking.js` on booking attempt | Appended on each booking; grows unbounded |
| `output/error-*-{timestamp}.png` | `booking.js` on failures only | Accumulates (only created when something goes wrong) |

**Screenshot policy:** Only failure/error screenshots are saved to avoid disk accumulation over long-running scheduler sessions. Error screenshots include: `error-book-*`, `error-flow-*`, `error-no-finalize-*`, `error-no-redirect-*`, `error-registration-*`, `error-unexpected-*`, `debug-login-fail.png`, and `debug-not-signup-*`.
