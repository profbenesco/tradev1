// Runs your deployed bot UI in headless Chromium and keeps it trading 24/7.
//
// Environment variables (set in Render):
//   SESSION_B64   (required) base64 of session.json made by export-session.js
//   TARGET_URL    default https://tradev1.netlify.app
//   STRATEGY_FILE default ./strategy.xml  (Blockly XML exported from the bot builder)
//   AUTO_RESTART_ON_STOP  "true" to restart the bot if it stops by itself.
//                         Default "false" so stop-loss / take-profit / max-trade
//                         limits in your strategy are respected.
//   PORT          set by Render automatically

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const TARGET_URL = process.env.TARGET_URL || 'https://tradev1.netlify.app';
const STRATEGY_FILE = process.env.STRATEGY_FILE || path.join(__dirname, 'strategy.xml');
const AUTO_RESTART_ON_STOP = process.env.AUTO_RESTART_ON_STOP === 'true';
const PORT = Number(process.env.PORT || 3000);
const CHECK_EVERY_MS = 15000;

const RUN_BTN = '#db-animation__run-button';
const STOP_BTN = '#db-animation__stop-button';

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const status = { state: 'starting', since: Date.now(), restarts: 0, lastCheck: null, note: '' };
const setState = (state, note = '') => {
    status.state = state;
    status.note = note;
    status.since = Date.now();
    log(`[state] ${state}${note ? ' - ' + note : ''}`);
};

// Tiny health endpoint so Render sees the service as alive.
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
}).listen(PORT, () => log(`health server on :${PORT}`));

function loadSession() {
    if (!process.env.SESSION_B64) throw new Error('SESSION_B64 is not set');
    return JSON.parse(Buffer.from(process.env.SESSION_B64, 'base64').toString('utf8'));
}

function loadStrategy() {
    if (!fs.existsSync(STRATEGY_FILE)) throw new Error(`Strategy file not found: ${STRATEGY_FILE}`);
    return fs.readFileSync(STRATEGY_FILE, 'utf8');
}

async function startBot(page, xml) {
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });

    // Wait for Blockly workspace to exist.
    await page.waitForFunction(() => window.Blockly && window.Blockly.derivWorkspace, null, { timeout: 120000 });

    // Warn if saved login looks expired.
    const authInfo = await page.evaluate(() => localStorage.getItem('auth_info'));
    if (!authInfo) log('WARNING: no auth_info in localStorage - session may be missing or expired');
    else {
        try {
            const exp = JSON.parse(authInfo).expires_at;
            if (exp && Date.now() > exp * 1000) log('WARNING: auth_info has expired - re-run export-session.js');
        } catch (_) {}
    }

    // Load the strategy into the workspace.
    await page.evaluate(xmlString => {
        const dom = window.Blockly.utils.xml.textToDom(xmlString);
        window.Blockly.Xml.clearWorkspaceAndLoadFromXml(dom, window.Blockly.derivWorkspace);
    }, xml);
    await sleep(3000);

    // Wait until connected/authorised enough for the Run button to be usable, then click it.
    await page.waitForSelector(RUN_BTN, { timeout: 120000 });
    await page.waitForFunction(sel => {
        const b = document.querySelector(sel);
        return b && !b.disabled;
    }, RUN_BTN, { timeout: 120000 });
    await page.click(RUN_BTN);
    await page.waitForSelector(STOP_BTN, { timeout: 60000 });
    setState('running');
}

async function runOnce() {
    const session = loadSession();
    const xml = loadStrategy();

    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    const context = await browser.newContext({
        storageState: session,
        viewport: { width: 1366, height: 800 },
    });
    const page = await context.newPage();
    page.on('pageerror', e => log('[pageerror]', String(e).slice(0, 300)));

    let crashed = false;
    page.on('crash', () => { crashed = true; });
    browser.on('disconnected', () => { crashed = true; });

    try {
        setState('starting-bot');
        await startBot(page, xml);

        // Monitor loop
        while (true) {
            await sleep(CHECK_EVERY_MS);
            status.lastCheck = new Date().toISOString();
            if (crashed || page.isClosed()) throw new Error('browser/page crashed');
            const stopped = (await page.$(STOP_BTN)) === null;
            if (stopped) {
                if (AUTO_RESTART_ON_STOP) throw new Error('bot stopped - restarting (AUTO_RESTART_ON_STOP=true)');
                setState('stopped', 'bot stopped on its own (strategy limit, error, or logout). Not restarting.');
                await browser.close();
                return 'stopped';
            }
        }
    } finally {
        await browser.close().catch(() => {});
    }
}

(async () => {
    let backoff = 5000;
    while (true) {
        try {
            const result = await runOnce();
            if (result === 'stopped') {
                // Stay alive (so Render doesn't restart us and re-trade) and just report.
                while (true) await sleep(60000);
            }
        } catch (err) {
            status.restarts += 1;
            setState('restarting', String(err.message || err).slice(0, 200));
            log(`retrying in ${backoff / 1000}s`);
            await sleep(backoff);
            backoff = Math.min(backoff * 2, 120000);
            continue;
        }
        backoff = 5000;
    }
})();