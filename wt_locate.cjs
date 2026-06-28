'use strict';

// Override TMPDIR sebelum apapun di-require.
// Shared hosting CloudLinux mount /tmp dengan noexec — Chromium tidak bisa dijalankan dari sana.
// Arahkan ke home dir user yang executable.
if (process.platform !== 'win32' && !process.env.CHROME_PATH) {
    const _fs  = require('fs');
    const _dir = (process.env.HOME || '/tmp') + '/chromium_tmp';
    try { _fs.mkdirSync(_dir, { recursive: true }); } catch (_) {}
    process.env.TMPDIR = _dir;
}

/**
 * wt_locate.cjs — headless Chrome locate_live runner for wikitrack.live
 *
 * Usage: node wt_locate.cjs <phone>
 * Output: JSON on stdout — {"success":true,"data":[...]} or {"success":false,"error":"..."}
 *
 * CF Turnstile auto-solves silently because --enable-automation is removed
 * (navigator.webdriver = false → CF treats browser as real user).
 * No X-Device-ID header is ever sent by this script.
 * _wt_did is set in localStorage so the SPA reuses a known registered device slot.
 */

const puppeteer = require('puppeteer-core');
const path      = require('path');
const fs        = require('fs');

// Resolve Chrome executable:
// 1. CHROME_PATH env → use directly (local dev / VPS with Chrome installed)
// 2. No CHROME_PATH on Linux → use @sparticuz/chromium (bundled, no install needed)
// 3. Windows fallback → default Chrome path
async function getChromePath() {
    if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
    if (process.platform !== 'win32') {
        try {
            const chromium = require('@sparticuz/chromium');
            return await chromium.executablePath();
        } catch (_) {}
        return '/usr/bin/google-chrome';
    }
    // Windows: cek system Chrome dulu, fallback ke puppeteer bundled Chromium
    const systemChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
    if (fs.existsSync(systemChrome)) return systemChrome;
    try {
        // puppeteer@19 bundel Chrome 107 — compatible Windows Server 2012 R2
        const p = require('puppeteer');
        return p.executablePath();
    } catch (_) {}
    return systemChrome;
}

async function getSparticuzArgs() {
    if (process.env.CHROME_PATH || process.platform === 'win32') return [];
    try {
        const chromium = require('@sparticuz/chromium');
        return chromium.args || [];
    } catch (_) { return []; }
}
const WT          = 'https://wikitrack.live';
const LICENSE     = process.env.WT_LICENSE_KEY || 'WT-XY3C-K2UV-N9QZ';
const DEVICE_ID   = '18ed9e62-9a1c-4cb5-a7d1-de5e08e71720:mtxrxy';
const PROFILE_DIR = process.env.CHROME_PROFILE_DIR
    || path.resolve(__dirname, '../../storage/app/chrome_wt_profile');
const TIMEOUT_MS  = 50000;

const phone = process.argv[2];
if (!phone) {
    process.stdout.write(JSON.stringify({ success: false, error: 'phone argument required' }));
    process.exit(1);
}

// Ensure profile directory exists
try { fs.mkdirSync(PROFILE_DIR, { recursive: true }); } catch (_) {}

async function run() {
    const executablePath  = await getChromePath();
    const sparticuzArgs   = await getSparticuzArgs();
    const extraArgs = [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-infobars',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-sync',
        '--no-first-run',
        '--no-default-browser-check',
        '--hide-scrollbars',
        '--mute-audio',
        '--window-size=1366,768',
    ];
    // Linux-only: workaround untuk CloudLinux seccomp yang blok fork/clone syscall
    // JANGAN dipakai di Windows — merusak JS renderer (body jadi kosong)
    if (process.platform !== 'win32') {
        extraArgs.push('--no-zygote', '--single-process', '--disable-gpu-sandbox', '--disable-software-rasterizer');
    }
    // Merge sparticuz args (dedup)
    const args = [...new Set([...sparticuzArgs, ...extraArgs])];

    const browser = await puppeteer.launch({
        executablePath,
        headless: true,
        userDataDir: PROFILE_DIR,
        ignoreDefaultArgs: ['--enable-automation'],
        args,
        defaultViewport: { width: 1366, height: 768 },
        timeout: 60000,         // 60s launch timeout (default 30s too short on slow shared hosting)
        protocolTimeout: 60000,
    });

    const page = await browser.newPage();
    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7' });

    // Capture /api/track response (set before navigation)
    let trackResponse = null;
    page.on('response', async resp => {
        const url = resp.url();
        if (url.includes('/api/track') && !url.includes('balance') && !url.includes('count')) {
            try {
                const body = await resp.text().catch(() => '');
                trackResponse = { status: resp.status(), body };
            } catch (_) {}
        }
    });

    // Navigate to root — 'load' waits for all resources (needed for React SPA)
    await page.goto(WT, { waitUntil: 'load', timeout: 30000 }).catch(() => {});

    // Wait for CF challenge to pass (if any) — up to 20s for JS challenge auto-solve
    await waitForCloudflarePass(page, 20000);

    // ── INJECT DEVICE ID immediately after CF (before SPA reads localStorage)
    await page.evaluate((did) => {
        localStorage.setItem('_wt_did', did);
    }, DEVICE_ID);

    // ── Accept Terms if shown (first run with fresh profile)
    const hasCheckbox = await page.evaluate(() => !!document.querySelector('input[type="checkbox"]'));
    if (hasCheckbox) {
        await page.click('input[type="checkbox"]').catch(() => {});
        await sleep(300);
        await page.evaluate(() => {
            const b = [...document.querySelectorAll('button')].find(b => b.textContent.includes('ACCEPT'));
            if (b) b.click();
        });
        await sleep(1500);
        await page.evaluate((did) => { localStorage.setItem('_wt_did', did); }, DEVICE_ID);
    }

    // ── Check login form — wait up to 5s (short: established sessions skip this fast)
    const loginReady = await waitForSelector(page, 'input[placeholder="WT-XXXX-XXXX-XXXX"]', 5000);
    if (loginReady) {
        // Pakai evaluate (atomic) — lebih stabil saat SPA re-render & element bisa hilang tiba-tiba
        const filled = await page.evaluate((license) => {
            const inp = document.querySelector('input[placeholder="WT-XXXX-XXXX-XXXX"]');
            if (!inp) return false;
            inp.focus();
            inp.value = license;
            inp.dispatchEvent(new Event('input',  { bubbles: true }));
            inp.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        }, LICENSE).catch(() => false);

        if (filled) {
            await sleep(200);
            await page.keyboard.press('Enter').catch(() => {});
            await waitForApiActivate(page, 12000);
            await sleep(2000);
        } else {
            await sleep(1500);
        }
    } else {
        // Already authenticated — short wait for SPA to finish auto-auth
        await sleep(1500);
    }

    // ── Wait for tool UI to be ready
    const inputReady = await waitForSelector(
        page, 'input[placeholder*="subject"], input[placeholder*="contact"]', 12000
    );
    if (!inputReady) {
        const diag = await page.evaluate(() => ({
            title:   document.title,
            url:     location.href,
            isCF:    document.title.toLowerCase().includes('cloudflare') ||
                     document.title.toLowerCase().includes('just a moment') ||
                     !!document.querySelector('#challenge-form, #cf-challenge-running, #cf-spinner'),
            bodySnip: document.body ? document.body.innerText.substring(0, 300) : '',
        })).catch(() => ({}));
        await browser.close();
        return {
            success: false,
            error: `Tool UI tidak muncul | isCF:${diag.isCF} | title:"${diag.title}" | url:${diag.url} | body:"${(diag.bodySnip||'').substring(0,150)}"`,
        };
    }

    // ── Ensure LOCATE LIVE sidebar item is selected
    await page.evaluate(() => {
        const sidebar = [...document.querySelectorAll('button')].find(b =>
            b.textContent.includes('01.') && b.textContent.includes('LOCATE')
        );
        if (sidebar) sidebar.click();
    });
    await sleep(300);

    // ── Clear field and enter phone number
    await page.click('input[placeholder*="subject"], input[placeholder*="contact"]').catch(() => {});
    await sleep(200);
    await page.evaluate(() => {
        const inp = document.querySelector('input[placeholder*="subject"], input[placeholder*="contact"]');
        if (inp) { inp.value = ''; inp.dispatchEvent(new Event('input', { bubbles: true })); }
    });
    await sleep(100);
    await page.type('input[placeholder*="subject"], input[placeholder*="contact"]', phone, { delay: 40 });
    await sleep(500);

    // ── Click LOCATE LIVE submit button (the one with ▶)
    const clickBtn = async () => page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find(b =>
            b.textContent.includes('LOCATE LIVE') && (b.textContent.includes('▶') || b.textContent.includes('►'))
        );
        if (btn) { btn.click(); return true; }
        return false;
    });

    const clicked = await clickBtn();
    if (!clicked) {
        await browser.close();
        return { success: false, error: 'Tombol LOCATE LIVE tidak ditemukan' };
    }

    // ── Wait for /api/track response; retry button click once if nothing comes within 20s
    const deadline = Date.now() + TIMEOUT_MS;
    let retried = false;
    while (!trackResponse && Date.now() < deadline) {
        await sleep(500);
        // If half the timeout elapsed with no response, click the button once more
        if (!retried && Date.now() > deadline - (TIMEOUT_MS / 2)) {
            retried = true;
            await clickBtn();
        }
    }

    await browser.close();

    if (!trackResponse) {
        return {
            success: false,
            error: `Timeout ${Math.round(TIMEOUT_MS / 1000)}s — CF mungkin menolak request dari IP server ini, coba lagi`,
        };
    }

    if (trackResponse.status !== 200) {
        let errBody = {};
        try { errBody = JSON.parse(trackResponse.body); } catch (_) {}
        return {
            success: false,
            error: errBody.error || errBody.message || `HTTP ${trackResponse.status}`,
            http_status: trackResponse.status,
        };
    }

    let data = {};
    try {
        data = JSON.parse(trackResponse.body);
    } catch (_) {
        return { success: false, error: 'Response /api/track bukan JSON valid', raw: trackResponse.body.substring(0, 200) };
    }

    if (data.data && Array.isArray(data.data)) {
        return { success: true, ...data };
    }
    if (data.error || data.message) {
        return { success: false, error: data.error || data.message };
    }
    return { success: true, raw: data };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function waitForSelector(page, selector, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const found = await page.evaluate(sel => !!document.querySelector(sel), selector);
        if (found) return true;
        await sleep(500);
    }
    return false;
}

async function waitForCloudflarePass(page, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const isCF = await page.evaluate(() => {
            const title = document.title.toLowerCase();
            return title.includes('cloudflare') ||
                   title.includes('just a moment') ||
                   !!document.querySelector('#challenge-form, #cf-challenge-running, #cf-spinner, .cf-browser-verification, [id^="cf-"]');
        });
        if (!isCF) return true;
        await sleep(800);
    }
    return false;
}

async function waitForApiActivate(page, timeoutMs) {
    return new Promise(resolve => {
        const handler = async resp => {
            if (resp.url().includes('/api/auth/activate')) {
                page.off('response', handler);
                resolve(true);
            }
        };
        page.on('response', handler);
        setTimeout(() => { page.off('response', handler); resolve(false); }, timeoutMs);
    });
}

// ── Entry point ───────────────────────────────────────────────────────────────

run()
    .then(result => {
        process.stdout.write(JSON.stringify(result));
        process.exit(0);
    })
    .catch(err => {
        process.stdout.write(JSON.stringify({ success: false, error: err.message }));
        process.exit(1);
    });
