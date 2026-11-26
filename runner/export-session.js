// Export an authenticated Playwright browser session for the 24/7 runner.
// Run locally on a trusted computer:
//   cd runner
//   npm install
//   npx playwright install chromium
//   node export-session.js
//
// Sign in to Deriv in the opened browser, return to this terminal and press
// Enter. Copy session.b64.txt into Render's SESSION_B64 environment variable.
// Treat the value like a password.

const fs = require('fs');
const readline = require('readline');
const { chromium } = require('playwright');

const TARGET_URL = process.env.TARGET_URL || 'https://tradev1.pages.dev';

(async () => {
    const browser = await chromium.launch({ headless: false });
    try {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });

        await new Promise(resolve => {
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            rl.question(
                '\nLog in to Deriv in the browser window. Wait until the bot page shows you are logged in, then press Enter here... ',
                () => { rl.close(); resolve(); }
            );
        });

        const state = await context.storageState();
        if (!Array.isArray(state.origins) || state.origins.length === 0) {
            console.warn('Warning: no localStorage origins were captured. Cookies may still have been saved.');
        }
        fs.writeFileSync('session.json', JSON.stringify(state, null, 2), { mode: 0o600 });
        fs.writeFileSync('session.b64.txt', Buffer.from(JSON.stringify(state)).toString('base64'), { mode: 0o600 });
        console.log('\nSaved session.json and session.b64.txt');
        console.log('Set the full contents of session.b64.txt as SESSION_B64 in Render.');
        console.log('IMPORTANT: this is an authenticated account session. Never share it or commit it to GitHub.');
    } finally {
        await browser.close();
    }
})().catch(err => {
    console.error('Session export failed:', err);
    process.exitCode = 1;
});
