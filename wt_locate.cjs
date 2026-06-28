'use strict';

const puppeteer = require('puppeteer-core');
const path      = require('path');
const fs        = require('fs');

async function getChromePath() {
    if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
    if (process.platform !== 'win32') {
        try {
            const chromium = require('@sparticuz/chromium');
            return await chromium.executablePath();
        } catch (_) {}
        return '/usr/bin/google-chrome';
    }
    const systemChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
    if (fs.existsSync(systemChrome)) return systemChrome;
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
const PROFILE_DIR = process.env.CHROME_PROFILE_DIR || '/app/chrome_profile';
const TIMEOUT_MS  = 50000;

const phone = process.argv[2];
if (!phone) {
    process.stdout.write(JSON.stringify({ success: false, error: 'phone argument required' }));
    process.exit(1);
}

try { fs.mkdirSync(PROFILE_DIR, { recursive: true }); } catch (_) {}

async function run() {
    const executablePath = await getChromePath();
    const sparticuzArgs  = await getSparticuzArgs();

    // Railway = Docker normal, TIDAK perlu --single-process / --no-zygote
    // --disable-gpu membunuh WebGL → React app (yang pakai WebGL/peta) crash → root kosong
    // Solusi: SwiftShader = software WebGL renderer (jalan tanpa GPU fisik)
    const extraArgs = [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-infobars',
        '--disable-dev-shm-usage',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-sync',
        '--no-first-run',
        '--no-default-browser-check',
        '--hide-scrollbars',
        '--mute-audio',
        '--window-size=1366,768',
        // Software WebGL via SwiftShader — wajib di Docker tanpa GPU
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--ignore-gpu-blocklist',
        '--enable-webgl',
    ];

    const args = [...new Set([...sparticuzArgs, ...extraArgs])];

    const browser = await puppeteer.launch({
        executablePath,
        headless: 'new', // new headless mode: full Chrome di background, WebGL SwiftShader aktif otomatis
        userDataDir: PROFILE_DIR,
        ignoreDefaultArgs: ['--enable-automation'],
        args,
        defaultViewport: { width: 1366, height: 768 },
        timeout: 60000,
        protocolTimeout: 60000,
    });

    const page = await browser.newPage();
    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7' });

    let trackResponse = null;
    const jsErrors = [];
    page.on('response', async resp => {
        const url = resp.url();
        if (url.includes('/api/track') && !url.includes('balance') && !url.includes('count')) {
            try {
                const body = await resp.text().catch(() => '');
                trackResponse = { status: resp.status(), body };
            } catch (_) {}
        }
    });
    page.on('console', msg => {
        if (msg.type() === 'error') jsErrors.push(msg.text().substring(0, 150));
    });
    page.on('pageerror', err => {
        jsErrors.push('PAGE_ERR:' + err.message.substring(0, 150));
    });

    await page.goto(WT, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
    await sleep(3000); // beri waktu React mount setelah load event
    await waitForCloudflarePass(page, 20000);

    await page.evaluate((did) => {
        localStorage.setItem('_wt_did', did);
    }, DEVICE_ID);

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

    const loginReady = await waitForSelector(page, 'input[placeholder="WT-XXXX-XXXX-XXXX"]', 5000);
    if (loginReady) {
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
        await sleep(1500);
    }

    const inputReady = await waitForSelector(
        page, 'input[placeholder*="subject"], input[placeholder*="contact"]', 12000
    );
    if (!inputReady) {
        const diag = await page.evaluate(() => {
            const root = document.getElementById('root');
            return {
                title:     document.title,
                url:       location.href,
                isCF:      document.title.toLowerCase().includes('cloudflare') ||
                           document.title.toLowerCase().includes('just a moment') ||
                           !!document.querySelector('#challenge-form, #cf-challenge-running, #cf-spinner'),
                hasRoot:   !!root,
                rootHTML:  root ? root.innerHTML.substring(0, 400) : 'no-root',
                bodyText:  document.body ? document.body.innerText.substring(0, 100) : '',
            };
        }).catch(() => ({}));
        await browser.close();
        return {
            success: false,
            error: `Tool UI tidak muncul | isCF:${diag.isCF} | hasRoot:${diag.hasRoot} | rootHTML:"${diag.rootHTML}" | bodyText:"${diag.bodyText}" | jsErr:${JSON.stringify(jsErrors.slice(0,2))}`,
        };
    }

    await page.evaluate(() => {
        const sidebar = [...document.querySelectorAll('button')].find(b =>
            b.textContent.includes('01.') && b.textContent.includes('LOCATE')
        );
        if (sidebar) sidebar.click();
    });
    await sleep(300);

    await page.click('input[placeholder*="subject"], input[placeholder*="contact"]').catch(() => {});
    await sleep(200);
    await page.evaluate(() => {
        const inp = document.querySelector('input[placeholder*="subject"], input[placeholder*="contact"]');
        if (inp) { inp.value = ''; inp.dispatchEvent(new Event('input', { bubbles: true })); }
    });
    await sleep(100);
    await page.type('input[placeholder*="subject"], input[placeholder*="contact"]', phone, { delay: 40 });
    await sleep(500);

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

    const deadline = Date.now() + TIMEOUT_MS;
    let retried = false;
    while (!trackResponse && Date.now() < deadline) {
        await sleep(500);
        if (!retried && Date.now() > deadline - (TIMEOUT_MS / 2)) {
            retried = true;
            await clickBtn();
        }
    }

    await browser.close();

    if (!trackResponse) {
        return {
            success: false,
            error: `Timeout ${Math.round(TIMEOUT_MS / 1000)}s — CF mungkin menolak IP Railway ini`,
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

run()
    .then(result => {
        process.stdout.write(JSON.stringify(result));
        process.exit(0);
    })
    .catch(err => {
        process.stdout.write(JSON.stringify({ success: false, error: err.message }));
        process.exit(1);
    });
