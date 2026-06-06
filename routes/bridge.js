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
        console.log(`[Bridge] 🔍 Action: ${req.method} ${req.url} from ${ip}`);
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
    
    // --- NEW: Check if the WebSocket Bypass is enabled ---
    const fs = require('fs');
    const path = require('path');
    const settingsPath = path.join(process.cwd(), 'config', 'settings.json');
    let bypassEnabled = false;
    if (fs.existsSync(settingsPath)) {
        try {
            const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            bypassEnabled = settings.bypassCloudEmulation === true;
        } catch(e) {}
    }

    if (bypassEnabled) {
        console.log(`\n🔘 PHYSICAL PRESS: P${id} from ${ip} (HTTP Ignored -> WS Bypass Active)`);
    } else {
        console.log(`\n🔘 PHYSICAL PRESS: P${id} from ${ip}`);
    }

    // 1. Tell the speaker this is a valid continuous radio stream
    res.set({
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-cache',
        'icy-name': `Hybrid Preset ${id}`,
        'icy-description': 'Starting Music Assistant...'
    });
    
    // 2. Start an "Infinite Silence" loop to keep the speaker happy
    const silenceLoop = setInterval(() => {
        res.write(SILENT_MP3_BUFFER);
    }, 500);

    // 3. When Music Assistant hijacks the speaker, the connection drops
    req.on('close', () => {
        clearInterval(silenceLoop);
    });

    // 4. Trigger Music Assistant (Only if WS bypass is OFF to prevent double-firing!)
    if (!bypassEnabled) {
        const success = await utils.executeSmartPreset(ip, id);
        
        // 🌟 RESTORED LOGIC: If no item is assigned, kill the silence loop so it doesn't hang!
        if (!success) {
            clearInterval(silenceLoop);
            res.end();
        }
    }
});

module.exports = router;