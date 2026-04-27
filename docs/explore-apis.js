/**
 * Exploration script: Captures all API calls during the booking flow
 * Register → Finalize Registration → Pay
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const BASE_URL = 'https://events.courtreserve.com';
const STATE_FILE = path.join(__dirname, 'auth-state.json');

async function explore() {
  const capturedRequests = [];
  const capturedResponses = [];

  const browser = await chromium.launch({ headless: false });

  let contextOptions = {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  };

  if (fs.existsSync(STATE_FILE)) {
    contextOptions.storageState = STATE_FILE;
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  // Intercept ALL requests and responses
  page.on('request', (request) => {
    const url = request.url();
    // Only log CourtReserve API calls (not static assets)
    if (url.includes('courtreserve.com') && !url.match(/\.(css|js|png|jpg|gif|svg|woff|ico)(\?|$)/i)) {
      const entry = {
        timestamp: new Date().toISOString(),
        method: request.method(),
        url: url,
        headers: request.headers(),
        postData: request.postData() || null,
      };
      capturedRequests.push(entry);
      console.log(`\n📤 ${request.method()} ${url}`);
      if (request.postData()) {
        console.log(`   POST DATA: ${request.postData().substring(0, 500)}`);
      }
    }
  });

  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('courtreserve.com') && !url.match(/\.(css|js|png|jpg|gif|svg|woff|ico)(\?|$)/i)) {
      try {
        const text = await response.text();
        const entry = {
          timestamp: new Date().toISOString(),
          url: url,
          status: response.status(),
          bodyPreview: text.substring(0, 1000),
          bodyLength: text.length,
        };
        capturedResponses.push(entry);

        // Highlight API/JSON responses
        if (url.includes('/Api') || url.includes('/api') || response.headers()['content-type']?.includes('json')) {
          console.log(`\n📥 RESPONSE ${response.status()} ${url}`);
          console.log(`   BODY (first 500 chars): ${text.substring(0, 500)}`);
        }
      } catch {}
    }
  });

  // Step 1: Login if needed
  console.log('\n═══ STEP 1: Loading site ═══');
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(10000);
  console.log(`Current URL: ${page.url()}`);

  // Step 2: Go to Renton events
  console.log('\n═══ STEP 2: Navigate to Renton Mixer events ═══');
  const eventsUrl = `${BASE_URL}/Online/Events/List/7031?evTypeId=19756`;
  await page.goto(eventsUrl, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(5000);

  // Step 3: Find the Tuesday Mixer and click VIEW UPCOMING DATES
  console.log('\n═══ STEP 3: Looking for Tuesday Mixer ═══');
  
  // Find all event cards with titles
  const eventCards = await page.evaluate(() => {
    const results = [];
    const links = document.querySelectorAll('a.dates-list-link, a[href*="tab=dates"]');
    links.forEach(link => {
      let container = link.closest('.fn-event-item') || link.closest('.fj_post') || link.parentElement?.parentElement?.parentElement;
      let title = '';
      if (container) {
        const h4 = container.querySelector('h4, h3');
        if (h4) title = h4.textContent.trim();
      }
      results.push({ title, href: link.getAttribute('href') });
    });
    return results;
  });

  console.log(`Found events: ${JSON.stringify(eventCards.map(e => e.title), null, 2)}`);
  
  const tuesdayMixer = eventCards.find(e => e.title.toLowerCase().includes('tuesday') && e.title.toLowerCase().includes('mixer'));
  if (!tuesdayMixer) {
    console.log('No Tuesday Mixer found!');
    await browser.close();
    return;
  }

  console.log(`\nFound: ${tuesdayMixer.title}`);
  console.log(`Navigating to dates page...`);

  const detailUrl = tuesdayMixer.href.startsWith('http') ? tuesdayMixer.href : `${BASE_URL}${tuesdayMixer.href}`;
  await page.goto(detailUrl, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(5000);

  // Step 4: Find a REGISTER button and click it
  console.log('\n═══ STEP 4: Looking for REGISTER buttons ═══');
  
  const registerButtons = await page.$$('a:has-text("REGISTER")');
  console.log(`Found ${registerButtons.length} REGISTER buttons`);

  if (registerButtons.length === 0) {
    console.log('No REGISTER buttons found!');
    await browser.close();
    return;
  }

  // Get the href of the first register button
  const registerHref = await registerButtons[0].getAttribute('href');
  console.log(`Register href: ${registerHref}`);

  console.log('\n═══ STEP 5: Clicking REGISTER (this triggers the registration page) ═══');
  console.log('>>> CAPTURING API CALLS FROM HERE <<<\n');
  
  // Clear captured data to focus on booking flow
  capturedRequests.length = 0;
  capturedResponses.length = 0;

  await registerButtons[0].click();
  await page.waitForTimeout(8000);
  
  // Screenshot after clicking REGISTER
  await page.screenshot({ path: path.join(__dirname, 'explore-step5-register.png'), fullPage: true });
  console.log('Screenshot saved: explore-step5-register.png');

  // Step 6: Click "Finalize Registration"
  console.log('\n═══ STEP 6: Looking for Finalize Registration button ═══');
  
  const finalizeBtn = page.locator('button:has-text("Finalize"), a:has-text("Finalize"), input[value*="Finalize"]').first();
  const finalizeVisible = await finalizeBtn.isVisible().catch(() => false);
  
  if (finalizeVisible) {
    console.log('Found Finalize Registration button! Clicking...');
    await finalizeBtn.click();
    await page.waitForTimeout(8000);
    
    await page.screenshot({ path: path.join(__dirname, 'explore-step6-finalize.png'), fullPage: true });
    console.log('Screenshot saved: explore-step6-finalize.png');

    // Step 7: Look for Pay button
    console.log('\n═══ STEP 7: Looking for Pay button ═══');
    
    const payBtn = page.locator('button:has-text("Pay"), a:has-text("Pay"), input[value*="Pay"]').first();
    const payVisible = await payBtn.isVisible().catch(() => false);
    
    if (payVisible) {
      console.log('Found Pay button! Clicking...');
      await payBtn.click();
      await page.waitForTimeout(8000);
      
      await page.screenshot({ path: path.join(__dirname, 'explore-step7-pay.png'), fullPage: true });
      console.log('Screenshot saved: explore-step7-pay.png');
    } else {
      console.log('No Pay button found. Page content:');
      const bodyText = await page.textContent('body').catch(() => '');
      console.log(bodyText.substring(0, 1000));
    }
  } else {
    console.log('No Finalize Registration button found. Looking at page...');
    const bodyText = await page.textContent('body').catch(() => '');
    console.log(bodyText.substring(0, 1000));
  }

  // Save all captured API calls
  const output = {
    requests: capturedRequests,
    responses: capturedResponses,
  };

  fs.writeFileSync(
    path.join(__dirname, 'captured-booking-flow.json'),
    JSON.stringify(output, null, 2)
  );
  console.log('\n\n═══ ALL CAPTURED API CALLS SAVED TO captured-booking-flow.json ═══');
  console.log(`Total requests captured: ${capturedRequests.length}`);
  console.log(`Total responses captured: ${capturedResponses.length}`);

  // Save context
  await context.storageState({ path: STATE_FILE });
  
  // Close browser after capturing
  console.log('\n\nClosing browser...');
  await browser.close();
  console.log('Done!');
}

explore().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
