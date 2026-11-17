// Run this on YOUR computer (not on Render) to capture a logged-in session.
//   npm install playwright
//   npx playwright install chromium
//   node export-session.js
// Log in to the bot in the window that opens (use a DEMO account first), wait until
// the bot page is fully loaded, then come back here and press Enter.
// It writes session.json and session.b64.txt (paste its contents into Render as SESSION_B64).

const fs = require('fs');
const readline = require('readline');
const { chromium } = require('playwright');

const TARGET_URL = process.env.TARGET_URL || 'https://tradev1.netlify.app';

(async () => {
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(TARGET_URL);

    await new Promise(resolve => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question('\nLog in in the browser window, then press Enter here to save the session... ', () => {
            rl.close();
            resolve();
        });
    });

    const state = await context.storageState();
    fs.writeFileSync('session.json', JSON.stringify(state, null, 2));
    fs.writeFileSync('session.b64.txt', Buffer.from(JSON.stringify(state)).toString('base64'));
    console.log('Saved session.json and session.b64.txt');
    console.log('KEEP THESE PRIVATE: they give access to your Deriv account. Do not commit them to GitHub.');
    await browser.close();
})();