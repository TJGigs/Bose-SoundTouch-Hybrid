const express = require('express');
const router = express.Router();
const boseCloudRoutes = require('./bose_cloud');
const fs = require('fs');
const path = require('path');
const mass = require('./mass'); 
const LIBRARY_FILE = path.join(__dirname, '../config/library.json');
const SILENT_MP3_B64 = "//NExAAAAANIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
const SILENT_MP3_BUFFER = Buffer.from(SILENT_MP3_B64, 'base64');
const utils = require('./utils');

const PENDING_TAP = {};
const EXTENDED_INTENT = {};

function setExtendedIntent(ip, basePresetId) {
    EXTENDED_INTENT[ip] = basePresetId;
    setTimeout(() => { delete EXTENDED_INTENT[ip]; }, 10000);
}

function getSettings() {
    try {
        return JSON.parse(fs.readFileSync(path.join(__dirname, '../config/settings.json'), 'utf8'));
    } catch (e) { return {}; }
}

router.use((req, res, next) => {
    // This part hides the "noise" from the UI poller AND background telemetry traps
    if (req.url.includes('/api/health') || 
        req.url.includes('/api/status') || 
		req.url.includes('/api/check_update') ||  
        req.url.includes('/v1/scmudc') || 
        req.url.includes('/events')) {
        return next();
    }

    const ip = (req.ip || req.connection.remoteAddress).replace('::ffff:', '');
	// Only print Bridge HTTP traffic if user enabled Verbose Logging
    if (global.DEBUG_MODE) {
        console.log(`[Bridge] Action: ${req.method} ${req.url} from ${ip}`);
    }
    next();
});

router.use('/', boseCloudRoutes);

// --- THE FINITE SILENCE STREAM ---
// Used to cleanly switch a speaker to Wi-Fi mode without triggering actual music.
// send buffer once and end the response. The speaker plays it and stops.
router.get('/silent.mp3', (req, res) => {
    res.set({'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-cache', 'icy-name': `Ready`});
    res.end(SILENT_MP3_BUFFER); 
});

// --- THE PRESET TRIGGER ---
router.get('/preset/:id.mp3', async (req, res) => {
    const id = parseInt(req.params.id);
    const ip = (req.ip || req.connection.remoteAddress).replace('::ffff:', '');

    console.log(`\n🔘 PHYSICAL PRESS: P${id} from ${ip}`);

    res.set({
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-cache',
        'icy-name': `Hybrid Preset ${id}`,
        'icy-description': 'Starting Music Assistant...'
    });

    const silenceLoop = setInterval(() => { res.write(SILENT_MP3_BUFFER); }, 500);
    req.on('close', () => { clearInterval(silenceLoop); });

    // UI extended intent: controller.js set this when the user clicked P11/P22/etc.
    if (EXTENDED_INTENT[ip] === id) {
        delete EXTENDED_INTENT[ip];
        const extId = id * 11;
        console.log(`[Bridge] ✌️ Extended intent active: P${id} → Slot ${extId} for ${ip}`);
        const success = await utils.executeSmartPreset(ip, extId);
        if (!success) { clearInterval(silenceLoop); res.end(); }
        return;
    }

    // Physical double-tap detection (only when feature is enabled)
    if (getSettings().doubleTapPresets) {
        if (PENDING_TAP[ip] && PENDING_TAP[ip].id === id) {
            clearTimeout(PENDING_TAP[ip].timer);
            delete PENDING_TAP[ip];
            const extId = id * 11;
            console.log(`[Bridge] ✌️ Double-tap confirmed: P${id} → Slot ${extId} for ${ip}`);
            const success = await utils.executeSmartPreset(ip, extId);
            if (!success) { clearInterval(silenceLoop); res.end(); }
            return;
        }

        if (PENDING_TAP[ip]) {
            clearTimeout(PENDING_TAP[ip].timer);
            delete PENDING_TAP[ip];
        }

        console.log(`[Bridge] ⏳ First tap P${id} from ${ip} — 500ms double-tap window open...`);
        PENDING_TAP[ip] = {
            id,
            timer: setTimeout(async () => {
                delete PENDING_TAP[ip];
                console.log(`[Bridge] ✅ Single-tap confirmed: P${id} for ${ip}`);
                const success = await utils.executeSmartPreset(ip, id);
                if (!success) { clearInterval(silenceLoop); res.end(); }
            }, 500)
        };
        return;
    }

    // Double-tap not enabled — execute immediately
    const success = await utils.executeSmartPreset(ip, id);
    if (!success) { clearInterval(silenceLoop); res.end(); }
});

module.exports = router;
module.exports.setExtendedIntent = setExtendedIntent;