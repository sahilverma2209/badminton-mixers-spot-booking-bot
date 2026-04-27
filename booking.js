const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// ─── Configuration ───────────────────────────────────────────────
// Parse EVENT_CONFIGS (new format: "19756:tuesday,thursday;54834:monday,wednesday,friday")
// Falls back to legacy EVENT_TYPE_IDS + PREFERRED_DAYS if EVENT_CONFIGS is not set
function parseEventConfigs() {
  const raw = process.env.EVENT_CONFIGS;
  if (raw) {
    const configs = {};
    raw.split(';').forEach(entry => {
      const [id, days] = entry.trim().split(':');
      if (id && days) {
        configs[id.trim()] = days.split(',').map(d => d.trim().toLowerCase());
      }
    });
    return configs;
  }
  // Legacy fallback
  const ids = (process.env.EVENT_TYPE_IDS || '19756').split(',').map(s => s.trim());
  const days = (process.env.PREFERRED_DAYS || 'tuesday').split(',').map(s => s.trim().toLowerCase());
  const configs = {};
  ids.forEach(id => { configs[id] = days; });
  return configs;
}

const CONFIG = {
  email: process.env.CR_EMAIL,
  password: process.env.CR_PASSWORD,
  orgId: process.env.ORG_ID || '7031',
  userId: process.env.USER_ID || '5384796',
  membershipId: process.env.MEMBERSHIP_ID || '2346339',
  eventConfigs: parseEventConfigs(), // { eventTypeId: [days] }
  headless: process.env.HEADLESS !== 'false',
  enableNotifications: process.env.ENABLE_NOTIFICATIONS !== 'false',
  maxWeeksAhead: parseInt(process.env.MAX_WEEKS_AHEAD || '4', 10),
  dryRun: process.argv.includes('--dry-run'),
};

const BASE_URL = 'https://events.courtreserve.com';
const OUTPUT_DIR = path.join(__dirname, 'output');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
const STATE_FILE = path.join(OUTPUT_DIR, 'auth-state.json');
const LOG_FILE = path.join(OUTPUT_DIR, 'booking.log');
const HISTORY_FILE = path.join(OUTPUT_DIR, 'booking-history.json');

// ─── Logging ─────────────────────────────────────────────────────
let logInitialized = false;
function log(message, level = 'INFO') {
  const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
  const line = `[${timestamp}] [${level}] ${message}`;
  console.log(line);
  if (!logInitialized) {
    fs.writeFileSync(LOG_FILE, line + '\n');       // Overwrite on first log of the run
    logInitialized = true;
  } else {
    fs.appendFileSync(LOG_FILE, line + '\n');
  }
}

// ─── Notifications (macOS + Email) ───────────────────────────────
function notify(title, message) {
  if (!CONFIG.enableNotifications) return;

  // macOS desktop notification (only works locally)
  try {
    const { execSync } = require('child_process');
    const sanitize = (str) => str.replace(/["\\\n\r']/g, ' ').substring(0, 200);
    execSync(`osascript -e 'display notification "${sanitize(message)}" with title "${sanitize(title)}" sound name "Glass"'`);
  } catch (e) {
    // Silently fail - expected when running headless/remote
  }

  // Email notification
  sendEmail(title, message).catch(e => {
    log(`Email notification failed: ${e.message}`, 'WARN');
  });
}

async function sendEmail(subject, body) {
  const emailUser = process.env.NOTIFY_EMAIL_USER;
  const emailPass = process.env.NOTIFY_EMAIL_PASS;
  const emailTo = process.env.NOTIFY_EMAIL_TO;

  if (!emailUser || !emailPass || !emailTo) return; // Email not configured, skip silently

  try {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: emailUser, pass: emailPass },
    });

    await transporter.sendMail({
      from: `"Mixer Booking Bot" <${emailUser}>`,
      to: emailTo,
      subject: `🏸 ${subject}`,
      text: body,
      html: `<div style="font-family:sans-serif;padding:20px;">
        <h2>${subject}</h2>
        <p style="font-size:16px;">${body}</p>
        <hr>
        <p style="color:#888;font-size:12px;">Sent by Mixer Booking Script at ${new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })}</p>
      </div>`,
    });

    log(`📧 Email sent to ${emailTo}: ${subject}`);
  } catch (e) {
    throw e; // Let the caller handle it
  }
}

// ─── Booking History (audit log) ─────────────────────────────────
function loadBookingHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    }
  } catch (e) {
    log(`Failed to load booking history: ${e.message}`, 'WARN');
  }
  return { bookings: [] };
}

function saveBookingHistory(history) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

function recordBooking(eventName, dateStr, success, details = {}) {
  const history = loadBookingHistory();
  history.bookings.push({
    eventName,
    date: dateStr,
    success,
    timestamp: new Date().toISOString(),
    ...details,
  });
  saveBookingHistory(history);
}

// ─── Format email subject: "{Location} Mixer {date} Registered" ─
function formatRegisteredSubject(eventName, dateInfo) {
  const locMatch = eventName.match(/^(\w+)\s+Mixer/i);
  const location = locMatch ? locMatch[1] : 'Mixer';
  return `${location} Mixer ${dateInfo} Registered`;
}

// ─── Date Filtering ──────────────────────────────────────────────
function isDateWithinRange(dateStr) {
  try {
    const eventDate = new Date(dateStr);
    if (isNaN(eventDate.getTime())) return true; // Can't parse → don't filter out
    const now = new Date();
    const maxDate = new Date(now.getTime() + CONFIG.maxWeeksAhead * 7 * 24 * 60 * 60 * 1000);
    return eventDate >= now && eventDate <= maxDate;
  } catch {
    return true; // If parsing fails, don't filter out
  }
}

// ─── API Response Interceptor ────────────────────────────────────
function setupResponseInterceptor(page) {
  const captured = {
    eventsList: null,
    eventDates: {},
    eventDetails: {},
    signUpResponse: null,
  };

  page.on('response', async (response) => {
    const url = response.url();
    try {
      if (url.includes('/Online/EventsApi/ApiLoadEvents') && response.status() === 200) {
        const text = await response.text();
        captured.eventsList = text;
        log(`  📡 Intercepted ApiLoadEvents (${text.length} bytes)`);
      }

      if (url.includes('/Online/EventsApi/Event_GetAdditionalDates') && response.status() === 200) {
        const text = await response.text();
        const eventIdMatch = url.match(/eventId=(\d+)/);
        const eventId = eventIdMatch ? eventIdMatch[1] : 'unknown';
        captured.eventDates[eventId] = text;
        log(`  📡 Intercepted Event_GetAdditionalDates for eventId=${eventId} (${text.length} bytes)`);
      }

      if (url.includes('/Online/EventsApi/ApiDetails') && response.status() === 200) {
        const text = await response.text();
        const numberMatch = url.match(/number=([^&]+)/);
        const eventNumber = numberMatch ? numberMatch[1] : 'unknown';
        captured.eventDetails[eventNumber] = text;
        log(`  📡 Intercepted ApiDetails for ${eventNumber} (${text.length} bytes)`);
      }

      // Intercept the Finalize Registration POST response
      if (url.includes('/EventApi_SignUpToEvent_DropIn_Post') && response.status() === 200) {
        const text = await response.text();
        captured.signUpResponse = text;
        log(`  📡 Intercepted SignUp POST response (${text.length} bytes)`);
      }
    } catch (err) {
      // Response body may not be available if navigated away
    }
  });

  return captured;
}

// ─── Parse availability from Event_GetAdditionalDates HTML ───────
function parseAvailableDates(html) {
  const available = [];
  if (!html) return available;

  // Find all register links with href containing "EventAction=Register"
  const registerPattern = /href="([^"]*EventAction=Register[^"]*)"/gi;
  let match;
  while ((match = registerPattern.exec(html)) !== null) {
    const registerUrl = match[1].replace(/&amp;/g, '&');
    const before = html.substring(Math.max(0, match.index - 2000), match.index);

    // Extract date
    const datePatterns = [
      /(\w{3},\s+\w{3}\s+\d{1,2},\s+\d{4})/g,
      /(\d{1,2}\/\d{1,2}\/\d{4})/g,
    ];
    let dateStr = 'Unknown date';
    for (const dp of datePatterns) {
      const dates = [...before.matchAll(dp)];
      if (dates.length > 0) {
        dateStr = dates[dates.length - 1][1];
        break;
      }
    }

    // Extract time
    const timeMatch = before.match(/(\d{1,2}:\d{2}\s*(?:AM|PM)\s*-\s*\d{1,2}:\d{2}\s*(?:AM|PM))/i);
    const timeStr = timeMatch ? timeMatch[1] : '';

    // Extract spots info
    const spotsMatch = before.match(/(\d+)\s*(?:\/\s*\d+)?\s*Spots?\s*(Filled|Left|Available)/i);
    const spotsInfo = spotsMatch ? spotsMatch[0] : '';

    available.push({ registerUrl, date: dateStr, time: timeStr, spots: spotsInfo });
  }

  return available;
}

// ─── Parse event cards from the events list page ─────────────────
function parseEventCards(page) {
  return page.evaluate(() => {
    const events = [];
    const dateLinks = document.querySelectorAll('a.dates-list-link, a[href*="tab=dates"]');
    dateLinks.forEach(link => {
      const href = link.getAttribute('href') || '';
      let container = link.closest('.fn-event-item') || link.closest('.fj_post') || link.parentElement?.parentElement?.parentElement;
      let title = 'Unknown';
      if (container) {
        const h4 = container.querySelector('h4, h3, .details h4');
        if (h4) title = h4.textContent.trim();
      }
      events.push({ title, href });
    });
    return events;
  });
}

// ─── Login ───────────────────────────────────────────────────────
async function login(page) {
  log('Navigating to login page...');
  await page.goto(`${BASE_URL}`, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Smart wait: look for either the login form or a portal URL (already logged in)
  log('Waiting for login form or session restore...');
  const loginFormOrPortal = await Promise.race([
    page.waitForSelector('input[placeholder*="example"], input[placeholder*="email"], input[name="UserNameOrEmail"], input[name="Email"]', { state: 'visible', timeout: 30000 }).then(() => 'login-form'),
    page.waitForURL(/\/(Portal|Announcements|Events)\//, { timeout: 30000 }).then(() => 'already-logged-in'),
  ]).catch(() => 'timeout');

  const currentUrl = page.url();
  log(`Current URL: ${currentUrl} (detected: ${loginFormOrPortal})`);

  if (loginFormOrPortal === 'already-logged-in' || currentUrl.includes('/Online/Portal/Index') || currentUrl.includes('/Online/Announcements')) {
    log('Already logged in (session restored)!');
    return true;
  }

  log('Filling credentials...');
  const emailLocator = page.locator('input[placeholder*="example"], input[placeholder*="email"], input[name="UserNameOrEmail"], input[name="Email"]').first();
  await emailLocator.fill(CONFIG.email);

  const passwordLocator = page.locator('input[type="password"]').first();
  await passwordLocator.waitFor({ state: 'visible', timeout: 10000 });
  await passwordLocator.fill(CONFIG.password);

  const loginLocator = page.locator('button:has-text("Login"), input[type="submit"], button[type="submit"]').first();
  await loginLocator.waitFor({ state: 'visible', timeout: 10000 });
  log('Clicking login button...');
  await loginLocator.click();

  // Smart wait: wait for URL to change away from Login page
  log('Waiting for login to complete...');
  await page.waitForURL(url => !url.toString().includes('/Login'), { timeout: 30000 }).catch(() => {});

  const postLoginUrl = page.url();
  log(`Post-login URL: ${postLoginUrl}`);

  const bodyText = await page.textContent('body').catch(() => '');
  if (bodyText.includes('Invalid') || bodyText.includes('incorrect')) {
    throw new Error('Login failed - invalid credentials');
  }

  if (postLoginUrl.includes('Login') && !bodyText.includes('Sahil')) {
    await page.screenshot({ path: path.join(OUTPUT_DIR, 'debug-login-fail.png') });
    throw new Error('Login did not navigate away from login page');
  }

  log('Login successful!');
  await page.context().storageState({ path: STATE_FILE });
  log('Auth state saved for future sessions.');
  return true;
}

// ─── Check Events for Availability ──────────────────────────────
async function checkAndBookMixers(page, intercepted) {
  const bookingsMade = [];

  for (const [evTypeId, preferredDays] of Object.entries(CONFIG.eventConfigs)) {
    log(`Checking events for type ID: ${evTypeId} (days: ${preferredDays.join(', ')})...`);
    const eventsUrl = `${BASE_URL}/Online/Events/List/${CONFIG.orgId}?evTypeId=${evTypeId}`;
    await page.goto(eventsUrl, { waitUntil: 'networkidle', timeout: 60000 });
    // Smart wait: wait for event card links to appear
    await page.waitForSelector('a.dates-list-link, a[href*="tab=dates"], .fn-event-item', { timeout: 10000 }).catch(() => {});

    const eventCards = await parseEventCards(page);
    log(`Found ${eventCards.length} event cards with date links`);

    // Filter to Mixer events on this location's preferred days
    const mixerEvents = eventCards.filter(ev => {
      const titleLower = ev.title.toLowerCase();
      if (!titleLower.includes('mixer')) return false;
      return preferredDays.some(day => titleLower.includes(day));
    });

    log(`Filtered to ${mixerEvents.length} Mixer events matching days: ${preferredDays.join(', ')}`);

    for (const event of mixerEvents) {
      log(`\n  Processing: ${event.title}`);

      if (!event.href) {
        log(`  ⚠️ No dates link found, skipping`);
        continue;
      }

      const detailUrl = event.href.startsWith('http') ? event.href : `${BASE_URL}${event.href}`;
      log(`  Navigating to: ${detailUrl}`);

      // Clear previous intercepted dates
      for (const key in intercepted.eventDates) delete intercepted.eventDates[key];

      await page.goto(detailUrl, { waitUntil: 'networkidle', timeout: 60000 });

      // Click DATES tab if needed
      const datesTab = page.locator('text=DATES').first();
      if (await datesTab.isVisible().catch(() => false)) {
        await datesTab.click();
      }

      // Smart wait: wait for the intercepted dates API response (up to 8s)
      for (let i = 0; i < 16 && Object.keys(intercepted.eventDates).length === 0; i++) {
        await page.waitForTimeout(500);
      }

      // Check intercepted API response for available dates
      const eventIds = Object.keys(intercepted.eventDates);
      if (eventIds.length === 0) {
        log(`  No dates API response intercepted. Falling back to DOM check...`);
        const result = await fallbackDomCheck(page, event.title, intercepted);
        if (result) bookingsMade.push(result);
      } else {
        for (const eventId of eventIds) {
          const datesHtml = intercepted.eventDates[eventId];
          const availableDates = parseAvailableDates(datesHtml);

          // Filter by date range
          const filteredDates = availableDates.filter(d => {
            if (!isDateWithinRange(d.date)) {
              log(`    ⏭️ Skipping ${d.date} (beyond ${CONFIG.maxWeeksAhead} weeks)`);
              return false;
            }
            return true;
          });

          if (filteredDates.length > 0) {
            log(`  🎉 FOUND ${filteredDates.length} AVAILABLE SPOTS (after filtering)!`);
            filteredDates.forEach((d, i) => {
              log(`    [${i + 1}] ${d.date} ${d.time} ${d.spots}`);
            });

            // Book the first available spot
            const spot = filteredDates[0];
            log(`  🔥 ATTEMPTING TO BOOK: ${spot.date} ${spot.time}`);
            // No notification here — only notify on successful registration

            const result = await bookSpot(page, spot, event.title, intercepted);
            if (result) bookingsMade.push(result);
          } else {
            const registerCount = await page.locator('a:has-text("REGISTER")').count();
            const fullCount = await page.locator('text=Full').count();
            log(`  Status: ${registerCount} Register buttons, ${fullCount} Full dates`);

            if (registerCount > 0 && filteredDates.length === 0 && availableDates.length > 0) {
              log(`  All available spots are outside the ${CONFIG.maxWeeksAhead}-week date range.`);
            } else if (registerCount > 0) {
              log(`  🎉 Found ${registerCount} REGISTER button(s) in DOM!`);
              const result = await fallbackDomCheck(page, event.title, intercepted);
              if (result) bookingsMade.push(result);
            } else {
              log(`  No available spots found.`);
            }
          }
        }
      }

      // Go back to events list
      await page.goto(eventsUrl, { waitUntil: 'networkidle', timeout: 60000 });
    }
  }

  return bookingsMade;
}

// ─── Book a specific spot using the register URL ─────────────────
async function bookSpot(page, spot, eventName, intercepted) {
  try {
    if (spot.registerUrl) {
      const fullUrl = spot.registerUrl.startsWith('http') ? spot.registerUrl : `${BASE_URL}${spot.registerUrl}`;
      log(`  Navigating to registration URL...`);
      await page.goto(fullUrl, { waitUntil: 'networkidle', timeout: 30000 });
    } else {
      const registerBtn = page.locator('a:has-text("REGISTER"), button:has-text("REGISTER")').first();
      if (await registerBtn.isVisible().catch(() => false)) {
        await registerBtn.click();
        await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
      }
    }

    // Smart wait: wait for SignUp page URL
    await page.waitForURL(/SignUpToEvent/, { timeout: 10000 }).catch(() => {});
    return await handleSignUpAndPayment(page, eventName, `${spot.date} ${spot.time}`, intercepted);
  } catch (err) {
    log(`  ❌ Book spot error: ${err.message}`, 'ERROR');
    await page.screenshot({ path: path.join(OUTPUT_DIR, `error-book-${Date.now()}.png`), fullPage: true }).catch(() => {});
    return null;
  }
}

// ─── Fallback DOM-based check ────────────────────────────────────
async function fallbackDomCheck(page, eventName, intercepted) {
  const registerButtons = await page.$$('a:has-text("REGISTER"), button:has-text("REGISTER")');
  const actualRegisterButtons = [];
  for (const btn of registerButtons) {
    const text = await btn.textContent();
    if (text.trim().toUpperCase() === 'REGISTER') {
      actualRegisterButtons.push(btn);
    }
  }

  if (actualRegisterButtons.length === 0) {
    log(`  No REGISTER buttons found in DOM`);
    return null;
  }

  log(`  🎉 Found ${actualRegisterButtons.length} REGISTER button(s) via DOM fallback`);

  let dateInfo = '';
  try {
    dateInfo = await actualRegisterButtons[0].evaluate(el => {
      const parent = el.closest('[class*="card"]') || el.closest('tr') || el.parentElement?.parentElement;
      return parent ? parent.textContent.trim().substring(0, 150) : '';
    });
  } catch {}

  log(`  📅 Date info: ${dateInfo}`);
  // No notification here — only notify on successful registration

  await actualRegisterButtons[0].scrollIntoViewIfNeeded().catch(() => {});
  await actualRegisterButtons[0].click().catch(async () => {
    await actualRegisterButtons[0].evaluate(el => el.click());
  });

  // Wait for navigation to SignUp page
  await page.waitForURL(/SignUpToEvent/, { timeout: 15000 }).catch(() => {});

  return await handleSignUpAndPayment(page, eventName, dateInfo, intercepted);
}

// ═══════════════════════════════════════════════════════════════════
// ─── CORE BOOKING FLOW: SignUp → Finalize Registration ───────────
// ═══════════════════════════════════════════════════════════════════
// After clicking Finalize Registration, the script stops. The user
// has ~15 minutes to complete payment manually on CourtReserve.
async function handleSignUpAndPayment(page, eventName, dateInfo, intercepted) {
  try {
    const currentUrl = page.url();
    log(`  📍 Current URL: ${currentUrl}`);

    // ── STEP 1: We should be on the SignUp page ──────────────────
    if (!currentUrl.includes('/Events/SignUpToEvent/')) {
      log(`  ⚠️ Not on SignUp page. URL: ${currentUrl}`, 'WARN');
      await page.screenshot({ path: path.join(OUTPUT_DIR, `debug-not-signup-${Date.now()}.png`), fullPage: true });
      return null;
    }

    log(`  ✅ On SignUp page. Waiting for registration form to load...`);

    // Wait for the AJAX content to load (EventApi_SignUpToEvent_Get)
    await page.waitForSelector('#Eventsignup-form, #main-eventSignup-container .form-container', {
      state: 'visible',
      timeout: 20000,
    }).catch(() => {
      log(`  ⚠️ Form selector not found, waiting extra time...`, 'WARN');
    });

    // Verify we see the event name on the page
    const pageText = await page.textContent('body').catch(() => '');
    if (pageText.includes('Mixer') || pageText.includes('mixer')) {
      log(`  ✅ Registration form loaded. Event info visible on page.`);
    } else {
      log(`  ⚠️ Page content may not have fully loaded.`, 'WARN');
    }

    // ── DRY RUN CHECK ────────────────────────────────────────────
    if (CONFIG.dryRun) {
      log(`  🏃 DRY RUN MODE - Stopping before Finalize Registration.`);
      log(`  Would have booked: ${eventName} - ${dateInfo}`);
      notify('🏃 Dry Run', `Would book ${eventName} - ${dateInfo}`);
      return { eventName, dateInfo, success: false, dryRun: true };
    }

    // ── STEP 2: Click "Finalize Registration" button ─────────────
    log(`  🔄 Looking for "Finalize Registration" button...`);

    const finalizeBtn = page.locator([
      'form#Eventsignup-form button.btn-submit',
      'button.btn-submit.ss-p-btn',
      'button:has-text("Finalize Registration")',
      'button:has-text("Finalize")',
    ].join(', ')).first();

    const finalizeBtnVisible = await finalizeBtn.isVisible().catch(() => false);
    if (!finalizeBtnVisible) {
      log(`  ❌ "Finalize Registration" button not found!`, 'ERROR');
      await page.screenshot({ path: path.join(OUTPUT_DIR, `error-no-finalize-${Date.now()}.png`), fullPage: true });
      return null;
    }

    log(`  ✅ Found "Finalize Registration" button. Clicking...`);
    await finalizeBtn.scrollIntoViewIfNeeded().catch(() => {});
    intercepted.signUpResponse = null;

    // Click and wait for redirect to payment page
    await Promise.all([
      page.waitForURL(/ProcessPayment/, { timeout: 20000 }).catch(() => {}),
      finalizeBtn.click(),
    ]);

    const postFinalizeUrl = page.url();
    log(`  📍 Post-finalize URL: ${postFinalizeUrl}`);

    // ── STEP 3: Determine outcome ────────────────────────────────
    // Redirect to payment page = registration succeeded (payment is manual)
    if (postFinalizeUrl.includes('/Payments/ProcessPayment')) {
      log(`  ✅ 🎉 Registration successful! Redirected to payment page.`);
      log(`  ⏰ Complete payment manually within ~15 minutes.`);
      recordBooking(eventName, dateInfo, true);
      const subj = formatRegisteredSubject(eventName, dateInfo);
      notify(subj, `Registered for ${eventName} - ${dateInfo}. Complete payment within 15 minutes!`);
      return { eventName, dateInfo, success: true };
    }

    if (postFinalizeUrl.includes('/Events/SignUpToEvent')) {
      // Still on signup page — check for errors
      const errorText = await page.textContent('.validation-summary-errors, .alert-danger, .error-message').catch(() => '');
      if (errorText && errorText.trim()) {
        log(`  ❌ Registration error: ${errorText.trim()}`, 'ERROR');
        await page.screenshot({ path: path.join(OUTPUT_DIR, `error-registration-${Date.now()}.png`), fullPage: true });
        return null;
      }

      // Poll for JS redirect (up to 6s)
      log(`  ⏳ Still on signup page, polling for redirect...`);
      await page.waitForURL(/ProcessPayment/, { timeout: 6000 }).catch(() => {});

      const retryUrl = page.url();
      if (retryUrl.includes('/Payments/ProcessPayment')) {
        log(`  ✅ 🎉 Registration successful! Redirected to payment page.`);
        log(`  ⏰ Complete payment manually within ~15 minutes.`);
        recordBooking(eventName, dateInfo, true);
        const subj2 = formatRegisteredSubject(eventName, dateInfo);
        notify(subj2, `Registered for ${eventName} - ${dateInfo}. Complete payment within 15 minutes!`);
        return { eventName, dateInfo, success: true };
      }

      // Check for SweetAlert modal errors
      const swalText = await page.textContent('.swal2-container, .sweet-alert, .remodal-wrapper').catch(() => '');
      if (swalText) {
        log(`  📋 Modal/Alert text: ${swalText.substring(0, 200).replace(/\s+/g, ' ')}`);
        if (swalText.toLowerCase().includes('error') || swalText.toLowerCase().includes('full')) {
          log(`  ❌ Registration failed (event may be full now)`, 'ERROR');
          return null;
        }
      }

      log(`  ⚠️ Did not redirect to payment. Current URL: ${retryUrl}`, 'WARN');
      await page.screenshot({ path: path.join(OUTPUT_DIR, `error-no-redirect-${Date.now()}.png`), fullPage: true });
      return null;
    }

    // Unexpected URL — check if it's a success page
    log(`  ⚠️ Unexpected URL after finalize: ${postFinalizeUrl}`, 'WARN');
    const bodyText = await page.textContent('body').catch(() => '');
    if (bodyText.includes('successfully') || bodyText.includes('Thank you')) {
      log(`  ✅ Appears to be a success page!`);
      recordBooking(eventName, dateInfo, true, { url: postFinalizeUrl });
      const subj3 = formatRegisteredSubject(eventName, dateInfo);
      notify(subj3, `Booked ${eventName} - ${dateInfo}!`);
      return { eventName, dateInfo, success: true };
    }

    await page.screenshot({ path: path.join(OUTPUT_DIR, `error-unexpected-${Date.now()}.png`), fullPage: true });
    return null;
  } catch (err) {
    log(`  ❌ SignUp flow error: ${err.message}`, 'ERROR');
    log(`  Stack: ${err.stack}`, 'ERROR');
    await page.screenshot({ path: path.join(OUTPUT_DIR, `error-flow-${Date.now()}.png`), fullPage: true }).catch(() => {});
    notify('❌ Mixer Booking Error', `Error: ${err.message}`);
    return null;
  }
}

// ─── Main Run Function ───────────────────────────────────────────
async function run() {
  const startTime = Date.now();

  // Reset output files for this run (only keep last run's data)
  saveBookingHistory({ bookings: [] });
  // Clean up old screenshots from previous runs
  try {
    const oldFiles = fs.readdirSync(OUTPUT_DIR).filter(f => f.endsWith('.png'));
    oldFiles.forEach(f => fs.unlinkSync(path.join(OUTPUT_DIR, f)));
  } catch (e) { /* ignore */ }

  log('═══════════════════════════════════════════════════');
  log('🏸 Mixers Booking Script - Starting check...');
  if (CONFIG.dryRun) log('🏃 DRY RUN MODE - will NOT complete bookings');
  for (const [id, days] of Object.entries(CONFIG.eventConfigs)) {
    log(`📅 Event type ${id}: ${days.join(', ')}`);
  }
  log(`📅 Max weeks ahead: ${CONFIG.maxWeeksAhead}`);
  log(`🖥️ Headless: ${CONFIG.headless}`);
  log('═══════════════════════════════════════════════════');

  let browser;
  try {
    const launchOptions = {
      headless: CONFIG.headless,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    };

    let contextOptions = {};
    if (fs.existsSync(STATE_FILE)) {
      log('Restoring previous auth session...');
      contextOptions.storageState = STATE_FILE;
    }

    browser = await chromium.launch(launchOptions);
    const context = await browser.newContext({
      ...contextOptions,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });

    const page = await context.newPage();

    // Set up API response interceptor
    const intercepted = setupResponseInterceptor(page);

    // Login
    await login(page);

    // Check and book
    const bookings = await checkAndBookMixers(page, intercepted);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    if (bookings.length > 0) {
      log(`\n🎉 Made ${bookings.length} booking(s) this run! (${elapsed}s)`);
      bookings.forEach(b => {
        const status = b.dryRun ? '🏃 DRY RUN' : '✅ REGISTERED';
        log(`  ${status} ${b.eventName} - ${b.dateInfo}`);
      });
    } else {
      log(`No available spots found this time. (${elapsed}s)`);
    }

    // Save state
    await context.storageState({ path: STATE_FILE });
    await browser.close();
    log('Browser closed. Run complete.');

    return bookings;
  } catch (err) {
    log(`Fatal error: ${err.message}`, 'ERROR');
    log(err.stack, 'ERROR');
    notify('❌ Mixer Script Error', `Fatal: ${err.message}`);
    if (browser) await browser.close().catch(() => {});
    return [];
  }
}

// ─── Export for scheduler and direct run ─────────────────────────
module.exports = { run, CONFIG };

if (require.main === module) {
  run().then((bookings) => {
    log('Single run complete.');
    if (CONFIG.dryRun) {
      log('(This was a dry run - no actual bookings were made)');
    }
  }).catch(err => {
    log(`Unhandled error: ${err.message}`, 'ERROR');
    process.exit(1);
  });
}
