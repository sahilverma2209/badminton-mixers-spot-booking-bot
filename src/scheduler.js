// Optional scheduler.js 
// Currently not used; scheduling is done via github workflows: .github/workflows/booking.yml
// more info here: https://github.com/sahilverma2209/badminton-mixers-spot-booking-bot/blob/master/docs/GITHUB_ACTIONS_SETUP.md
// Leaving this in case needed in the future
const cron = require('node-cron');
const { run, CONFIG } = require('./booking.js');
const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = path.join(__dirname, '..', 'output');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
const LOG_FILE = path.join(OUTPUT_DIR, 'booking.log');

function log(message) {
  const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
  const line = `[${timestamp}] [SCHEDULER] ${message}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

const intervalMinutes = parseInt(process.env.CHECK_INTERVAL_MINUTES || '5', 10);
let isRunning = false;
let runCount = 0;

async function runCheck() {
  if (isRunning) {
    log('Previous check still running, skipping this cycle.');
    return;
  }
  isRunning = true;
  runCount++;
  log(`Starting check #${runCount}...`);
  try {
    const bookings = await run();
    if (bookings && bookings.length > 0) {
      log(`Check #${runCount} complete - ${bookings.length} booking(s) made!`);
    } else {
      log(`Check #${runCount} complete - no spots found.`);
    }
  } catch (err) {
    log(`Check #${runCount} error: ${err.message}`);
  } finally {
    isRunning = false;
  }
}

// Run every N minutes
const cronExpr = `*/${intervalMinutes} * * * *`;
log(`🏸 Mixer Booking Scheduler started!`);
log(`Checking every ${intervalMinutes} minutes (cron: ${cronExpr})`);
for (const [id, days] of Object.entries(CONFIG.eventConfigs)) {
  log(`Event type ${id}: ${days.join(', ')}`);
}
log(`Dry run: ${CONFIG.dryRun}`);

// Run immediately on start
runCheck();

// Then schedule recurring checks
cron.schedule(cronExpr, runCheck);

// Handle graceful shutdown
process.on('SIGINT', () => {
  log(`Scheduler stopped (SIGINT) after ${runCount} checks.`);
  process.exit(0);
});
process.on('SIGTERM', () => {
  log(`Scheduler stopped (SIGTERM) after ${runCount} checks.`);
  process.exit(0);
});

log('Press Ctrl+C to stop.');
