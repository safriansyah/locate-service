'use strict';
/**
 * wt_locate_server.cjs — HTTP microservice wrapper for wt_locate.cjs
 *
 * Deploy to Railway / Render / Fly.io (any Docker host with Node.js + Chrome).
 * Laravel shared hosting calls: POST /locate  { "phone": "628xxx" }
 *
 * Env vars:
 *   PORT              - listen port (default 3000, set by Railway automatically)
 *   WT_LICENSE_KEY    - wikitrack.live license key
 *   CHROME_PATH       - path to chrome/chromium binary
 *   CHROME_PROFILE_DIR- persistent profile directory (default /app/chrome_profile)
 *   LOCATE_SECRET     - optional shared secret (set same value in Laravel LOCATE_SECRET)
 */

const express    = require('express');
const { execFile } = require('child_process');
const path       = require('path');
const fs         = require('fs');

const app    = express();
const PORT   = process.env.PORT || 3000;
const SECRET = process.env.LOCATE_SECRET || '';

// Ensure chrome profile dir exists
const profileDir = process.env.CHROME_PROFILE_DIR || '/app/chrome_profile';
try { fs.mkdirSync(profileDir, { recursive: true }); } catch (_) {}

app.use(express.json());

// Accept requests with or without cPanel base-path prefix (Passenger may or may not strip it)
const R = (path) => [path, `/locate-api${path}`];

// Health check
app.get(R('/health'), (_, res) => {
    res.json({ ok: true, service: 'locate-live', ts: new Date().toISOString() });
});

app.post(R('/locate'), (req, res) => {
    // Optional token auth — reject if LOCATE_SECRET is set but header doesn't match
    if (SECRET && req.headers['x-secret'] !== SECRET) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { phone } = req.body || {};
    if (!phone) {
        return res.status(400).json({ success: false, error: 'phone required' });
    }

    const script   = path.join(__dirname, 'wt_locate.cjs');
    const nodeBin  = process.execPath; // full path ke node binary (aman di cPanel Passenger)
    const env = {
        ...process.env,
        CHROME_PROFILE_DIR: profileDir,
    };

    // Timeout: 55s (wt_locate.cjs has 50s internal timeout, +5s margin)
    execFile(nodeBin, [script, phone], { env, timeout: 55000, maxBuffer: 1024 * 512 }, (err, stdout, stderr) => {
        if (err) {
            if (err.killed) {
                return res.json({ success: false, error: 'Timeout: browser tidak merespon dalam 55s' });
            }
            // wt_locate.cjs always writes JSON to stdout even on error — try to parse it first
            const out = (stdout || '').trim();
            if (out) {
                try { return res.json(JSON.parse(out)); } catch (_) {}
            }
            // Fallback: return raw error + stderr for diagnosis
            return res.json({
                success: false,
                error:  String(err.message).substring(0, 300),
                stderr: (stderr || '').substring(0, 500),
                stdout: out.substring(0, 200),
            });
        }

        const output = (stdout || '').trim();
        if (!output) {
            return res.json({ success: false, error: 'Tidak ada output dari browser script' });
        }

        try {
            res.json(JSON.parse(output));
        } catch (_) {
            res.json({ success: false, error: 'Response tidak valid', raw: output.substring(0, 150) });
        }
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`[locate-service] ready on :${PORT}`);
    console.log(`[locate-service] chrome profile: ${profileDir}`);
    console.log(`[locate-service] auth: ${SECRET ? 'enabled' : 'disabled (set LOCATE_SECRET to enable)'}`);
});
