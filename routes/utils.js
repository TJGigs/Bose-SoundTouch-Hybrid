const { URL } = require('url'); // Standard Node.js library
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const xml2js = require('xml2js');
const { injectPort17000Commands, speakerHasPresets } = require('./preflight');
const DEFAULT_ICON = "";

const LOG_DIR = path.resolve(process.cwd(), "config", "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function buildImageUrl(artPath, provider, uri) {
    if (artPath && typeof artPath === 'string' && artPath.startsWith('http') && !artPath.includes('imageproxy')) {
        return artPath;
    }
    if (artPath && provider) {
        return `/api/manager/proxy_image?mode=raw&path=${encodeURIComponent(artPath)}&provider=${encodeURIComponent(provider)}`;
    }
    if (uri) {
        return `/api/manager/proxy_image?uri=${encodeURIComponent(uri)}`;
    }
    return DEFAULT_ICON;
}

// --- CENTRALIZED IP PARSER ---
function parseIp(input) {
    if (!input)
        return null;
    let str = String(input);

    // 1. Handle UPnP/XML URLs
    if (str.includes("http")) {
        try {
            str = new URL(str).hostname;
        } catch (e) {
            // If URL parsing fails, fall through to regex
        }
    }

    // 2. Handle IPv6 mapped IPv4 (e.g., ::ffff:192.168.1.50)
    str = str.replace('::ffff:', '');

    // 3. Extract pure IPv4 if garbage remains
    const match = str.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
    return match ? match[0] : str;
}
// --- SHARED PRESET LOOKUP ---
function getPresetAssignment(ip, slotId) {
    const libPath = path.join(__dirname, '../config/library.json');
    if (!fs.existsSync(libPath))
        return null;

    const library = JSON.parse(fs.readFileSync(libPath));

    let match = library.find(item => item.slot === slotId && item.speakerIp === ip);
    if (!match)
        match = library.find(item => item.slot === slotId && !item.speakerIp);

    return match || null;
}
// --- TEXT SANITIZER ---
// Safely replaces broken Bose encoding diamonds with an 'a' to preserve word structure.
// Music Assistant will instantly overwrite this with the perfect UTF-8 accents anyway!
function scrubText(str) {
    if (!str) return "";
    return str.replace(/[\ufffd]/g, 'a').normalize('NFC');
}

let lastAuditDate = null;
let lastRestartDate = null;
let lastWatchdogRunMs = null; // set when startScheduler() actually starts the clock
let lastObserveRunMs = null;  // separate 5-min clock for observe mode
const firedToday = new Set();

// --- SHARED HYBRID PRESET DEFINITIONS ---
// Single source of truth for what "Hybrid Preset N" is: the URL, the display name.
// Consumed by bose_cloud.js (cloud-delivered presets XML, pulled by the speaker
// during its handshake) and pushPresetsToSpeaker() below (direct local WAPI write).
// Keeping both fed from here means the two delivery paths can never drift apart.
function getHybridPresetDefinitions() {
    const IP = process.env.APP_IP;
    const PORT = process.env.APP_PORT;
    const definitions = [];
    for (let i = 1; i <= 6; i++) {
        definitions.push({
            id: i,
            name: `Hybrid Preset ${i}`,
            url: `http://${IP}:${PORT}/preset/${i}.mp3`
        });
    }
    return definitions;
}

// --- PRESET WATCHDOG: Direct WAPI Write (storePreset) ---
// Writes all 6 Hybrid presets straight into the speaker's local NVRAM via the
// undocumented but community-confirmed WAPI
// /storePreset endpoint. Unlike runSpeakerAudit's reboot-based heal, this is
// non-destructive — no reboot, no standby/wake cycle, no playback interruption.
// Intended only for speakers flagged in settings.presetWatchdogSpeakers (Tools
// page "Preset Refresh Watchdog" card) — most speakers never need this.
async function pushPresetsToSpeaker(ip) {
    const definitions = getHybridPresetDefinitions();
    const nowSec = Math.floor(Date.now() / 1000);

    for (const preset of definitions) {
        const body = `<preset id="${preset.id}" createdOn="${nowSec}" updatedOn="${nowSec}">
            <ContentItem source="LOCAL_INTERNET_RADIO" type="stationurl" location="${preset.url}" sourceAccount="" isPresetable="true">
                <itemName>${preset.name}</itemName>
            </ContentItem>
        </preset>`;
        try {
            await axios.post(`http://${ip}:8090/storePreset`, body, {
                headers: { 'Content-Type': 'text/xml' },
                timeout: 3000
            });
        } catch (e) {
            console.error(`[Preset Watchdog] ❌ Failed to push Preset ${preset.id} to ${ip}: ${e.message}`);
        }
    }
}

// --- WATCHDOG OBSERVE: 12-HOUR ROLLING LOG ---
// Appends one entry (JSON object) to config/logs/watchdog_<ip>.json.
// On every write, entries older than 12 hours are pruned so the file self-limits.
function appendWatchdogLog(ip, entry) {
    const logPath = path.join(LOG_DIR, `watchdog_${ip.replace(/\./g, '_')}.json`);
    const TWELVE_HOURS = 12 * 60 * 60 * 1000;
    const cutoff = Date.now() - TWELVE_HOURS;

    let entries = [];
    try {
        if (fs.existsSync(logPath)) entries = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    } catch (e) {
        entries = [];
    }

    entries.push(entry);
    entries = entries.filter(e => new Date(e.ts).getTime() > cutoff);

    try {
        fs.writeFileSync(logPath, JSON.stringify(entries, null, 2));
    } catch (e) {
        console.error(`[Watchdog] ❌ Failed to write log for ${ip}:`, e.message);
    }
}

// --- WATCHDOG OBSERVE: 5-MINUTE PRESET SNAPSHOT ---
async function queryPresetsForSpeaker(ip) {
    const parser = new xml2js.Parser({ explicitArray: false });
    const entry = { ts: new Date().toISOString(), type: 'preset_snapshot', presets: [] };

    try {
        const res = await axios.get(`http://${ip}:8090/presets`, { timeout: 3000 });
        const data = await parser.parseStringPromise(res.data);
        const raw = data.presets?.preset;
        if (raw) {
            const arr = Array.isArray(raw) ? raw : [raw];
            entry.presets = arr.map(p => ({
                id:       p.$?.id,
                name:     p.ContentItem?.itemName || 'Unknown',
                source:   p.ContentItem?.$?.source || 'Unknown',
                location: p.ContentItem?.$?.location || ''
            }));
        }
    } catch (e) {
        entry.error = e.message;
    }

    appendWatchdogLog(ip, entry);
    console.log(`[Watchdog] 📋 Preset snapshot for ${ip}: ${entry.presets.length} preset(s)${entry.error ? ' — ERROR: ' + entry.error : ''}`);
}

// --- WATCHDOG: SYNC GLOBALS FROM SETTINGS ---
// Called on startup and after every settings save so bose_cloud.js middleware
// can check global.WATCHDOG_SPEAKERS / global.WATCHDOG_MODE without disk reads.
function updateWatchdogGlobals() {
    const settingsPath = path.join(process.cwd(), 'config', 'settings.json');
    try {
        const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};
        global.WATCHDOG_SPEAKERS = Array.isArray(settings.presetWatchdogSpeakers) ? settings.presetWatchdogSpeakers : [];
        global.WATCHDOG_MODE = settings.presetWatchdogMode || 'push';
    } catch (e) {
        console.error('[Watchdog] Failed to sync globals from settings:', e.message);
    }
}

function fmtScheduledTime(h, m) {
    if (h == null) return 'Manual Trigger';
    const ampm = h < 12 ? 'AM' : 'PM';
    const h12  = h % 12 || 12;
    return `${h12}:${String(m ?? 0).padStart(2, '0')} ${ampm}`;
}

async function runSpeakerAudit(hour = null, minute = null) {
    console.log(`\n=======================================================================`);
    console.log(`[Scheduler] 🕒 ${fmtScheduledTime(hour, minute)} Routine: Executing Speaker Preset Audit...`);
    console.log(`=======================================================================`);
    
    const speakersPath = path.join(process.cwd(), 'config', 'speakers.json');
    const speakers = fs.existsSync(speakersPath) ? JSON.parse(fs.readFileSync(speakersPath, 'utf8')) : [];

    let rebootOccurred = false;

    for (const speaker of speakers) {
        try {
            console.log(`[Scheduler] 🔍 Checking presets for ${speaker.name} (${speaker.ip})...`);
            if (!(await speakerHasPresets(speaker.ip))) {
                console.log(`   └─ ⚠️ Empty presets detected! Initiating Smart Reboot...`);
                
                // 1. SMART SHUTDOWN: Check if it's awake before rebooting
                try {
                    const statusRes = await axios.get(`http://${speaker.ip}:8090/now_playing`, { timeout: 2000 });
                    if (!statusRes.data.includes('source="STANDBY"')) {
                        console.log(`      └─ 💤 Clean shutdown: Routing POWER command for ${speaker.name}...`);
                        const LOCAL_PORT = process.env.APP_PORT || 8080;
                        await axios.post(`http://127.0.0.1:${LOCAL_PORT}/api/key`, { ip: speaker.ip, key: 'POWER' });
                        
                        // Give controller.js 1.5 seconds to finish clearing queues
                        await new Promise(r => setTimeout(r, 1500));
                    }
                } catch (e) {
                    console.log(`      └─ ⚠️ Could not verify power state. Proceeding anyway.`);
                }

                // 2. EXECUTE THE HARDWARE REBOOT
                await injectPort17000Commands(speaker.ip, ['sys reboot']);
                rebootOccurred = true;

            } else {
                console.log(`   └─ ✅ Presets intact. Speaker is healthy.`);
            }
        } catch (e) {
            console.log(`   └─ ❌ Failed to reach ${speaker.name}: ${e.message}`);
        }
    }

    // 3. SMART RECOVERY: The 90-Second Music Assistant DLNA/AirPlay Reload
    if (rebootOccurred) {
        scheduleProviderReload('rebooted speakers');
    }

    console.log(`[Scheduler] ✅ Speaker Preset Audit Complete.\n`);
}

// routes/utils.js — Update this function verbatim
async function runSystemRestart(hour = null, minute = null) {
    console.log(`\n=======================================================================`);
    console.log(`[Scheduler] 🕒 ${fmtScheduledTime(hour, minute)} Routine: Executing Scheduled System Restart...`);
    console.log(`=======================================================================`);
    
    try {
        const settingsPath = path.join(process.cwd(), 'config', 'settings.json');
        const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};
        
        // Match the checkbox options from the tools UI layout
        const forceInjectTarget = null; 
        const forceRebootTarget = settings.includeReboot ? 'all' : null;
        
        // Fire the unified execution engine using the parameters expected by preflight.runSetup
        await executeSmartShutdown(forceInjectTarget, forceRebootTarget);
    } catch (e) {
        console.error(`[Scheduler] ❌ Scheduled restart script failed: ${e.message}`);
    }
}

function startScheduler() {
    console.log(`[Scheduler] 🕰️ Background automation engine started.`);

    // Preset Watchdog interval starts counting from here — NOT from 0/boot. Pre-Flight
    // already reboots/heals speakers as needed on startup, so re-running this within the
    // first minute of every restart would be redundant. The clock starts only once the
    // app is actually up and the scheduler is live.
    lastWatchdogRunMs = Date.now();
    lastObserveRunMs  = Date.now();

    // Prime globals so bose_cloud.js middleware has them from the first request.
    updateWatchdogGlobals();

    setInterval(async () => {
        const now = new Date();
        const hours = now.getHours();
        const minutes = now.getMinutes();
        const today = now.toDateString(); 
		
		// ==========================================================
        // 🕒 PERMANENT DEBUG LOGGER (Prints every 60 seconds)
        // ==========================================================
        if (global.DEBUG_MODE) {
            console.log(`[Scheduler-Debug] 🕒 Current Docker Time -> ${hours}:${minutes}`);
        }
        
        const settingsPath = path.join(process.cwd(), 'config', 'settings.json');
        const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};

        // ====================================================================
        // 🕰️ SCHEDULER CONFIGURATION — read from settings.json (24-hour)
        // ====================================================================
        const AUDIT_HOUR    = settings.scheduledAuditHour   ?? 2;
        const AUDIT_MINUTE  = 0;

        const RESTART_HOUR   = settings.scheduledRestartHour ?? 3;
        const RESTART_MINUTE = 0;
        // ====================================================================
        // 1. SPEAKER AUDIT SEQUENCE
        if (hours === AUDIT_HOUR && minutes === AUDIT_MINUTE && settings.scheduledSpeakerAudit) {
            if (lastAuditDate !== today) {
                lastAuditDate = today;
                await runSpeakerAudit(AUDIT_HOUR, AUDIT_MINUTE);
            }
        }
        // 2. SYSTEM RESTART SEQUENCE
        if (hours === RESTART_HOUR && minutes === RESTART_MINUTE && settings.scheduledRestart) {
            if (lastRestartDate !== today) {
                lastRestartDate = today;
                await runSystemRestart(RESTART_HOUR, RESTART_MINUTE);
            }
        }
        // 3. PRESET WATCHDOG (rolling interval — not tied to a fixed hour like Audit/Restart)
        const watchdogSpeakers = Array.isArray(settings.presetWatchdogSpeakers) ? settings.presetWatchdogSpeakers : [];
        const watchdogMode = settings.presetWatchdogMode || 'push';

        if (watchdogSpeakers.length > 0) {
            if (watchdogMode === 'push') {
                const intervalMs = (settings.presetWatchdogIntervalMinutes ?? 60) * 60000;
                if (Date.now() - lastWatchdogRunMs >= intervalMs) {
                    lastWatchdogRunMs = Date.now();
                    console.log(`\n[Scheduler] 🔁 Preset Watchdog (Push): refreshing presets on ${watchdogSpeakers.length} speaker(s)...`);
                    for (const ip of watchdogSpeakers) {
                        await pushPresetsToSpeaker(ip);
                    }
                }
            } else if (watchdogMode === 'observe') {
                if (Date.now() - lastObserveRunMs >= 5 * 60000) {
                    lastObserveRunMs = Date.now();
                    console.log(`\n[Scheduler] 🔍 Preset Watchdog (Observe): querying ${watchdogSpeakers.length} speaker(s)...`);
                    for (const ip of watchdogSpeakers) {
                        await queryPresetsForSpeaker(ip);
                    }
                }
            }
        }

        // 4. SCHEDULED PLAYS
        const scheduledPlays = Array.isArray(settings.scheduledPlays) ? settings.scheduledPlays : [];
        for (const play of scheduledPlays) {
            if (!play.speakerIp || !play.preset || play.hour == null) continue;
            if (play.enabled === false) continue;
            const playHour   = parseInt(play.hour, 10);
            const playMinute = parseInt(play.minute ?? 0, 10);
            if (hours !== playHour || minutes !== playMinute) continue;
            const playKey = `${today}-${play.speakerIp}-${play.preset}`;
            if (firedToday.has(playKey)) continue;
            firedToday.add(playKey);
			    console.log(`\n=======================================================================`);
            console.log(`[Scheduler] ⏰ Scheduled Play: Speaker ${play.speakerIp} Preset ${play.preset}`);
			    console.log(`=======================================================================`);
            try {
                await executeSmartPreset(play.speakerIp, play.preset);
            } catch (e) {
                console.error(`[Scheduler] ❌ Scheduled Play failed (${play.speakerIp} P${play.preset}):`, e.message);
            }
        }
    }, 60000);
}

// ====================================================================
// --- UNIFIED SMART PRESET ENGINE ---
// ====================================================================
async function executeSmartPreset(ip, id) {
    // Dynamic requires to prevent circular dependency loops
    const mass = require('./mass'); 
    const deviceState = require('../device_state');

    console.log(`\n[Smart Engine] ⚙️ Executing Preset ${id} for ${ip}...`);
    
    // 1. Log the memory (Moved from old Bridge)
    mass.setPresetMemory(ip, id);

    // 2. Fetch the assignment (Moved from old Bridge)
    const match = module.exports.getPresetAssignment(ip, id);
    
    if (match && match.uri) {
        console.log(`   ✅ Triggering via MASS: ${match.name}`);
        
        // 3. Lock the UI to prevent bouncing
        deviceState.setExpectation(ip, 'PRESET', id);
        
        try {
            await mass.playMedia(ip, match);
            return true; // 🌟 Tells bridge.js it was successful!
        } catch (e) {
            console.error(`[Smart Engine] ❌ Failed to play preset: ${e.message}`);
            return false;
        }
    } else {
        console.log(`   ⚠️ No item assigned to Slot ${id}`);
        return false; // 🌟 Tells bridge.js to abort the silence stream!
    }
}


// --- CLEAN SLATE PROTOCOL (SMART POWER OFF ALL) ---
async function powerOffAllSpeakers() {
    const speakersPath = path.join(process.cwd(), 'config', 'speakers.json');
    if (!fs.existsSync(speakersPath)) return;

    const SPEAKERS = JSON.parse(fs.readFileSync(speakersPath, 'utf8'));
    const LOCAL_PORT = process.env.APP_PORT || 3000;
    console.log(`\n[Admin] 🧹 Putting all active speakers to sleep for a clean restart...`);

    const sleepTasks = SPEAKERS.map(async (speaker) => {
        try {
            const statusRes = await axios.get(`http://${speaker.ip}:8090/now_playing`, { timeout: 2000 });
            if (!statusRes.data.includes('source="STANDBY"')) {
                console.log(`   └─ 💤 Initiating smart power-down for ${speaker.name}...`);
                console.log(`   └─ 🔀 Routing POWER command through the Smart Controller...`);
                await axios.post(`http://127.0.0.1:${LOCAL_PORT}/api/key`, { ip: speaker.ip, key: 'POWER' });
            }
        } catch (e) {
            console.error(`   └─ ⚠️ Could not reach ${speaker.name} to power it down.`);
        }
    });

    await Promise.allSettled(sleepTasks);
    await new Promise(r => setTimeout(r, 1500));
}

// --- UNIFIED SMART SHUTDOWN ENGINE ---
// Used by both the UI restart button and the background scheduler
async function executeSmartShutdown(injectTarget = null, rebootTarget = null) {
    console.log(`\n=======================================================================`);
    console.log(`🚨 SOUNDTOUCH HYBRID RESTART SEQUENCE INITIATED`);
    if (injectTarget) console.log(`🎯 Inject Target: ${injectTarget === 'all' ? 'ALL SPEAKERS' : injectTarget}`);
    if (rebootTarget) console.log(`🎯 Reboot Target: ${rebootTarget === 'all' ? 'ALL SPEAKERS' : rebootTarget}`);
    console.log(`=======================================================================`);

    if (injectTarget || rebootTarget) {
        const flagPath = path.join(process.cwd(), 'config', 'force_inject.json');
        fs.writeFileSync(flagPath, JSON.stringify({
            forceMode: true,
            forceInjectTarget: injectTarget,
            forceRebootTarget: rebootTarget,
            debugMode: global.DEBUG_MODE === true
        }));
    }

    try {
        await powerOffAllSpeakers();
    } catch (e) {
        console.error(`[Admin] Could not power off speakers during shutdown:`, e.message);
    }

    setTimeout(() => {
        console.log(`[Admin] Exiting process to apply restart sequence...`);
        process.exit(0);
    }, 1000);
}

// --- 90-SECOND DLNA/AIRPLAY PROVIDER RELOAD TIMER ---
// Called after any mid-session speaker hardware reboot (Type A only).
// Waits for the speaker to fully boot and broadcast UPnP before asking MASS to rediscover it.
function scheduleProviderReload(context) {
    const label = context || 'rebooted speakers';
    console.log(`[Scheduler] ⏱️ Starting 90-second Music Assistant recovery timer for ${label}...`);
    setTimeout(async () => {
        console.log(`[Scheduler] 🔄 Triggering aggressive Music Assistant provider reload for ${label}...`);
        try {
            const LOCAL_PORT = process.env.APP_PORT || 8080;
            await axios.post(`http://127.0.0.1:${LOCAL_PORT}/api/admin/rescan_ma`, { aggressive: true, provider: 'dlna' });
            await axios.post(`http://127.0.0.1:${LOCAL_PORT}/api/admin/rescan_ma`, { aggressive: true, provider: 'airplay' });
            console.log(`[Scheduler] ✅ Music Assistant providers successfully reloaded.`);
        } catch (err) {
            console.error(`[Scheduler] ❌ Failed to reload MA providers:`, err.message);
        }
    }, 90000);
}

module.exports = {
    DEFAULT_ICON,
    buildImageUrl,
    getPresetAssignment,
    parseIp,
    scrubText,
	startScheduler,
	runSpeakerAudit,
	executeSmartPreset,
    powerOffAllSpeakers,
    executeSmartShutdown,
    scheduleProviderReload,
    getHybridPresetDefinitions,
    pushPresetsToSpeaker,
    appendWatchdogLog,
    queryPresetsForSpeaker,
    updateWatchdogGlobals
};
