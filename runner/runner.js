// 24/7 runner for the tradev1 bot.
// Environment variables (set in Render):
//   RUNNER_SECRET (required) a long random password
//   ALLOWED_ORIGIN  default https://tradev1.netlify.app
//   TARGET_URL      default = ALLOWED_ORIGIN
//   DATA_DIR        default ./data
//   AUTO_RESUME     default "true"
//   AUTO_RESTART_ON_STOP  default "false"

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://tradev1.netlify.app';
const TARGET_URL = process.env.TARGET_URL || ALLOWED_ORIGIN;
const SECRET = process.env.RUNNER_SECRET || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PAYLOAD_FILE = path.join(DATA_DIR, 'payload.json');
const AUTO_RESUME = process.env.AUTO_RESUME !== 'false';
const AUTO_RESTART_ON_STOP = process.env.AUTO_RESTART_ON_STOP === 'true';
const PORT = Number(process.env.PORT || 3000);
const CHECK_EVERY_MS = 15000;
const MAX_BODY = 5 * 1024 * 1024;

const RUN_BTN = '#db-animation__run-button';
const STOP_BTN = '#db-animation__stop-button';

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const status = { state: 'idle', since: Date.now(), restarts: 0, lastCheck: null, note: '' };
const setState = (state, note = '') => {
    status.state = state;
    status.note = note;
    status.since = Date.now();
    log(`[state] ${state}${note ? ' - ' + note : ''}`);
};

let generation = 0;
let activeBrowser = null;

async function closeActive() {
    if (activeBrowser) {
        const b = activeBrowser;
        activeBrowser = null;
        await b.close().catch(() => {});
    }
}

async function startBot(page, payload) {
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForFunction(() => window.Blockly && window.Blockly.derivWorkspace, null, { timeout: 120000 });

    const authInfo = await page.evaluate(() => localStorage.getItem('auth_info'));
    if (!authInfo) log('WARNING: no auth_info - login session missing. Tap "Run 24/7" again while logged in.');
    else {
        try {
            const exp = JSON.parse(authInfo).expires_at;
            if (exp && Date.now() > exp * 1000) log('WARNING: login session has expired. Tap "Run 24/7" again.');
        } catch (_) {}
    }

    if (payload.xml) {
        await page.evaluate(xmlString => {
            const dom = window.Blockly.utils.xml.textToDom(xmlString);
            window.Blockly.Xml.clearWorkspaceAndLoadFromXml(dom, window.Blockly.derivWorkspace);
        }, payload.xml);
    }
    await sleep(3000);

    await page.waitForSelector(RUN_BTN, { timeout: 120000 });
    await page.waitForFunction(sel => {
        const b = document.querySelector(sel);
        return b && !b.disabled;
    }, RUN_BTN, { timeout: 120000 });
    await page.click(RUN_BTN);
    await page.waitForSelector(STOP_BTN, { timeout: 60000 });
    setState('running');
}

async function runOnce(gen, payload) {
    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    activeBrowser = browser;
    const origin = new URL(TARGET_URL).origin;

    const context = await browser.newContext({ viewport: { width: 1366, height: 800 } });
    await context.addInitScript(({ local, session, origin }) => {
        if (location.origin !== origin) return;
        try {
            for (const [k, v] of Object.entries(local || {})) if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
        } catch (_) {}
        try {
            for (const [k, v] of Object.entries(session || {})) if (sessionStorage.getItem(k) === null) sessionStorage.setItem(k, v);
        } catch (_) {}
    }, { local: payload.local, session: payload.session, origin });

    const page = await context.newPage();
    page.on('pageerror', e => log('[pageerror]', String(e).slice(0, 300)));
    let crashed = false;
    page.on('crash', () => { crashed = true; });
    browser.on('disconnected', () => { crashed = true; });

    try {
        setState('starting-bot');
        await startBot(page, payload);

        while (true) {
            await sleep(CHECK_EVERY_MS);
            if (gen !== generation) return 'superseded';
            status.lastCheck = new Date().toISOString();
            if (crashed || page.isClosed()) throw new Error('browser/page crashed');
            const stopped = (await page.$(STOP_BTN)) === null;
            if (stopped) {
                if (AUTO_RESTART_ON_STOP) throw new Error('bot stopped - restarting (AUTO_RESTART_ON_STOP=true)');
                setState('stopped', 'bot stopped on its own (strategy limit, error, or logout). Not restarting.');
                return 'stopped';
            }
        }
    } finally {
        if (activeBrowser === browser) activeBrowser = null;
        await browser.close().catch(() => {});
    }
}

async function supervise(gen, payload) {
    let backoff = 5000;
    while (gen === generation) {
        try {
            const r = await runOnce(gen, payload);
            if (r === 'stopped' || r === 'superseded') return;
            backoff = 5000;
        } catch (err) {
            if (gen !== generation) return;
            status.restarts += 1;
            setState('restarting', String(err.message || err).slice(0, 200));
            await sleep(backoff);
            backoff = Math.min(backoff * 2, 120000);
        }
    }
}

async function deploy(payload) {
    generation += 1;
    const gen = generation;
    await closeActive();
    status.restarts = 0;
    setState('starting', 'new strategy received');
    supervise(gen, payload).catch(e => log('supervisor error', e));
}

async function stopAll() {
    generation += 1;
    await closeActive();
    setState('idle', 'stopped by request');
}

function secretOk(req) {
    if (!SECRET) return false;
    const given = String(req.headers['x-runner-secret'] || '');
    const a = Buffer.from(given);
    const b = Buffer.from(SECRET);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', c => {
            size += c.length;
            if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

http.createServer(async (req, res) => {
    const headers = {
        'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
        'Access-Control-Allow-Headers': 'content-type, x-runner-secret',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Content-Type': 'application/json',
    };
    const send = (code, obj) => { res.writeHead(code, headers); res.end(JSON.stringify(obj)); };

    try {
        if (req.method === 'OPTIONS') return send(204, {});
        const url = req.url.split('?')[0];

        if (req.method === 'GET' && (url === '/' || url === '/status' || url === '/health')) {
            return send(200, status);
        }
        if (req.method === 'POST' && (url === '/deploy' || url === '/stop')) {
            if (!SECRET) return send(500, { error: 'RUNNER_SECRET is not set on the server' });
            if (!secretOk(req)) return send(401, { error: 'wrong secret' });

            if (url === '/stop') {
                try { fs.rmSync(PAYLOAD_FILE, { force: true }); } catch (_) {}
                await stopAll();
                return send(200, { ok: true, state: status.state });
            }

            const body = JSON.parse((await readBody(req)) || '{}');
            if (!body.xml || typeof body.xml !== 'string') return send(400, { error: 'xml (strategy) is required' });
            const payload = {
                xml: body.xml,
                local: body.local && typeof body.local === 'object' ? body.local : {},
                session: body.session && typeof body.session === 'object' ? body.session : {},
            };
            fs.mkdirSync(DATA_DIR, { recursive: true });
            fs.writeFileSync(PAYLOAD_FILE, JSON.stringify(payload), { mode: 0o600 });
            await deploy(payload);
            return send(200, { ok: true, state: status.state });
        }
        send(404, { error: 'not found' });
    } catch (err) {
        send(400, { error: String(err.message || err) });
    }
}).listen(PORT, () => {
    log(`runner listening on :${PORT}`);
    if (!SECRET) log('WARNING: RUNNER_SECRET is not set - /deploy and /stop are disabled');
    if (AUTO_RESUME && fs.existsSync(PAYLOAD_FILE)) {
        try {
            const payload = JSON.parse(fs.readFileSync(PAYLOAD_FILE, 'utf8'));
            log('resuming last deployed strategy');
            deploy(payload);
        } catch (e) {
            log('could not resume:', e.message);
        }
    }
});