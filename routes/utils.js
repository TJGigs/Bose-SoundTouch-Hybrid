const { URL } = require('url'); // Standard Node.js library
const fs = require('fs');
const path = require('path');
const net = require('net');
const axios = require('axios');
const xml2js = require('xml2js');
const DEFAULT_ICON = "";

const LOG_DIR = path.resolve(process.cwd(), "config", "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function localTimestamp(d = new Date()) {
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

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
let lastWatchdogRunMs = null;      // set when startScheduler() actually starts the clock
let lastObserveRunMs = null;       // separate 5-min clock for observe mode
let lastObserveHourlyLogMs = null; // hourly "still watching" heartbeat for observe mode
const firedToday = new Set();
const stuckStateStreak = {};       // ip → consecutive 5-min polls seen with PLAY_STATE + INVALID_SOURCE

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

// Synchronous inline check used by the nowSelectionUpdated WebSocket handler in device_state.js.
// Returns true when the ContentItem in the event is one of our own bridge preset URLs, meaning
// the bridge will handle the press via the /preset/:id.mp3 HTTP route — no MASS call needed here.
function isHybridContentItem(source, location) {
    const APP_IP   = process.env.APP_IP;
    const APP_PORT = process.env.APP_PORT;
    return source === 'LOCAL_INTERNET_RADIO' &&
           typeof location === 'string' &&
           location.includes(`${APP_IP}:${APP_PORT}/preset/`);
}

// --- PRESET HEALTH CHECKS ---
// speakerHasPresets: slot existence only (used by legacy callers and as a base check)
// speakerHasHybridPresets: stricter — confirms slots contain LOCAL_INTERNET_RADIO URLs
// pointing back to this bridge. Both return true on fetch error to avoid false-positive reboots.
async function speakerHasPresets(ip) {
    try {
        const res = await axios.get(`http://${ip}:8090/presets`, { timeout: 3000 });
        const parser = new xml2js.Parser({ explicitArray: false });
        const data = await parser.parseStringPromise(res.data);
        const presets = data.presets && data.presets.preset;
        if (!presets) return false;
        if (Array.isArray(presets)) return presets.length > 0;
        return Object.keys(presets).length > 0;
    } catch (e) {
        return true;
    }
}

async function speakerHasHybridPresets(ip) {
    const APP_IP = process.env.APP_IP;
    const APP_PORT = process.env.APP_PORT;
    try {
        const res = await axios.get(`http://${ip}:8090/presets`, { timeout: 3000 });
        const parser = new xml2js.Parser({ explicitArray: false });
        const data = await parser.parseStringPromise(res.data);
        const presets = data.presets?.preset;
        if (!presets) return false;
        const arr = Array.isArray(presets) ? presets : [presets];
        if (arr.length < 6) return false;
        return arr.every(p =>
            p.ContentItem?.$?.source === 'LOCAL_INTERNET_RADIO' &&
            p.ContentItem?.$?.location?.includes(`${APP_IP}:${APP_PORT}/preset/`)
        );
    } catch (e) {
        return true;
    }
}

// --- PRESET PUSH: Direct WAPI Write (storePreset) ---
// Universal non-destructive preset delivery path. Writes all 6 Hybrid presets
// directly into the speaker's NVRAM via the /storePreset endpoint — no reboot,
// no standby/wake cycle, no playback interruption. Called from:
//   - Pre-Flight Route D (wrong or missing presets, cloud config already correct)
//   - runSpeakerAudit (scheduled nightly audit)
//   - Preset Watchdog Push mode (recurring interval)
//   - Manual "Push Now" button (Tools page)
//   - Cloud handshake recovery (incomplete handshake — presets not injected via account/full)
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
            console.error(`[Preset Push] ❌ Failed to push Preset ${preset.id} to ${ip}: ${e.message}`);
        }
    }
    console.log(`[Preset Push] ✅ All 6 presets pushed to ${ip}.`);
}

// --- WATCHDOG OBSERVE: 24-HOUR ROLLING LOG ---
// Appends one entry (JSON object) to config/logs/watchdog_<ip>.json.
// On every write, entries older than 24 hours are pruned so the file self-limits.
function appendWatchdogLog(ip, entry) {
    const { ts: _ignored, ...rest } = entry;
    const stamped = { ts: localTimestamp(), ...rest };
    const logPath = path.join(LOG_DIR, `watchdog_${ip.replace(/\./g, '_')}.json`);
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - TWENTY_FOUR_HOURS;

    let entries = [];
    try {
        if (fs.existsSync(logPath)) entries = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    } catch (e) {
        entries = [];
    }

    entries.push(stamped);
    entries = entries.filter(e => new Date(e.ts).getTime() > cutoff);

    try {
        fs.writeFileSync(logPath, '[\n  ' + entries.map(e => JSON.stringify(e)).join(',\n  ') + '\n]');
    } catch (e) {
        console.error(`[Watchdog] ❌ Failed to write log for ${ip}:`, e.message);
    }
}

// --- WATCHDOG OBSERVE: 5-MINUTE PRESET SNAPSHOT ---
async function queryPresetsForSpeaker(ip, phase = null) {
    if (!global.WATCHDOG_SPEAKERS?.includes(ip)) return;
    const parser = new xml2js.Parser({ explicitArray: false });
    const entry = { ts: new Date().toISOString(), type: 'preset_snapshot', ...(phase ? { phase } : {}), presets: [] };

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
    if (global.DEBUG_MODE) {
        console.log(`[Watchdog] Preset snapshot for ${ip}${phase ? ' (' + phase + ')' : ''}: ${entry.presets.length} preset(s)${entry.error ? ' — ERROR: ' + entry.error : ''}`);
    }
}

// --- WATCHDOG: SYNC GLOBALS FROM SETTINGS ---
// Called on startup and after every settings save so all modules
// can check global.WATCHDOG_SPEAKERS without disk reads.
function updateWatchdogGlobals() {
    const settingsPath = path.join(process.cwd(), 'config', 'settings.json');
    try {
        const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};
        global.WATCHDOG_SPEAKERS = Array.isArray(settings.presetWatchdogSpeakers) ? settings.presetWatchdogSpeakers : [];
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

    for (const speaker of speakers) {
        try {
            console.log(`[Scheduler] 🔍 Checking presets for ${speaker.name} (${speaker.ip})...`);
            if (!(await speakerHasHybridPresets(speaker.ip))) {
                console.log(`   └─ ⚠️ Hybrid presets missing or stale — pushing directly (no reboot required).`);
                await pushPresetsToSpeaker(speaker.ip);
            } else {
                console.log(`   └─ ✅ Presets intact. Speaker is healthy.`);
            }
        } catch (e) {
            console.log(`   └─ ❌ Failed to reach ${speaker.name}: ${e.message}`);
        }
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
    console.log(`[Scheduler] Background automation engine started.`);

    // Preset Watchdog interval starts counting from here — NOT from 0/boot. Pre-Flight
    // already reboots/heals speakers as needed on startup, so re-running this within the
    // first minute of every restart would be redundant. The clock starts only once the
    // app is actually up and the scheduler is live.
    lastWatchdogRunMs      = Date.now();
    lastObserveRunMs       = Date.now();
    lastObserveHourlyLogMs = Date.now();

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
        // 3. PRESET WATCHDOG (observe mode — rolling interval, not tied to a fixed hour)
        const watchdogSpeakers = Array.isArray(settings.presetWatchdogSpeakers) ? settings.presetWatchdogSpeakers : [];

        if (watchdogSpeakers.length > 0) {
            // Hourly heartbeat — always visible so you know the watchdog is alive
            if (Date.now() - lastObserveHourlyLogMs >= 60 * 60000) {
                lastObserveHourlyLogMs = Date.now();
                console.log(`[Watchdog] Monitoring ${watchdogSpeakers.length} speaker(s). Querying every 5 min, logging to watchdog_*.json.`);
            }
            // Query every 5 min
            if (Date.now() - lastObserveRunMs >= 5 * 60000) {
                lastObserveRunMs = Date.now();
                if (global.DEBUG_MODE) {
                    console.log(`\n[Scheduler] 🔍 Preset Watchdog: querying ${watchdogSpeakers.length} speaker(s)...`);
                }
                for (const ip of watchdogSpeakers) {
                    await queryPresetsForSpeaker(ip);
                    await checkAndRecoverStuckSpeaker(ip);
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

    console.log(`\n[Smart Engine] Executing Preset ${id} for ${ip}...`);
    
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
                console.log(`   └─ Routing POWER command through the Smart Controller...`);
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
    if (injectTarget) console.log(`Inject Target: ${injectTarget === 'all' ? 'ALL SPEAKERS' : injectTarget}`);
    if (rebootTarget) console.log(`Reboot Target: ${rebootTarget === 'all' ? 'ALL SPEAKERS' : rebootTarget}`);
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
        console.log(`[Scheduler] Reloading Music Assistant DLNA & AirPlay providers for ${label}...`);
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

// --- TARGETED SPEAKER REBOOT (PORT 17000) + PROVIDER RELOAD ---
// Same recipe as the manual admin.js "Telnet Reboot" route (POST /admin/reboot_speaker):
// clean POWER shutdown if the speaker is awake, hard reboot via port 17000, then the
// 90s MASS provider reload so DLNA/AirPlay don't error out on a stale player afterward.
// Unlike executeSmartShutdown, this touches only the one target IP — no other speakers
// are powered off and the app process is not restarted.
async function rebootSpeakerAndReload(ip) {
    const LOCAL_PORT = process.env.APP_PORT;

    try {
        const statusRes = await axios.get(`http://${ip}:8090/now_playing`, { timeout: 2000 });
        if (!statusRes.data.includes('source="STANDBY"')) {
            console.log(`[Watchdog] 💤 Clean shutdown: Routing POWER command for ${ip} before Telnet reboot...`);
            await axios.post(`http://127.0.0.1:${LOCAL_PORT}/api/key`, { ip, key: 'POWER' });
            await new Promise(r => setTimeout(r, 1500));
        }
    } catch (e) {
        console.log(`[Watchdog] ⚠️ Could not verify power state for ${ip} before reboot. Proceeding anyway.`);
    }

    console.log(`[Watchdog] Sending Telnet 'sys reboot' to ${ip} on port 17000...`);
    const client = new net.Socket();
    client.on('error', (err) => console.log(`[Watchdog] Telnet error on ${ip}: ${err.message}`));
    client.connect(17000, ip, () => {
        client.write('sys reboot\r\n');
        setTimeout(() => client.destroy(), 500);
    });

    scheduleProviderReload(ip);
}

// --- STUCK-STATE DETECTION (WATCHDOG-MONITORED SPEAKERS ONLY) ---
// Observed failure mode: speaker reports PLAY_STATE + INVALID_SOURCE (a contradictory
// combo device_state.js already treats as an edge case — normally a transient AirPlay
// teardown artifact) and never recovers. No BMX/power-on cloud event follows, so the
// preset-recovery handshake logic in bose_cloud.js never fires, and /info on 8090 keeps
// answering 200 the whole time, so the offline watchdog in device_state.js never fires
// either. Two consecutive 5-min polls (~5-10 min stuck) triggers a targeted reboot.
async function checkAndRecoverStuckSpeaker(ip) {
    try {
        const res = await axios.get(`http://${ip}:8090/now_playing`, { timeout: 3000 });
        const parser = new xml2js.Parser({ explicitArray: false });
        const data = await parser.parseStringPromise(res.data);
        const np = data.nowPlaying;
        const source = np && np.$ ? np.$.source : null;
        const playStatus = np ? np.playStatus : null;

        if (playStatus === 'PLAY_STATE' && source === 'INVALID_SOURCE') {
            stuckStateStreak[ip] = (stuckStateStreak[ip] || 0) + 1;
            console.log(`[Watchdog] ⚠️ ${ip} reporting PLAY_STATE + INVALID_SOURCE (streak: ${stuckStateStreak[ip]}/2).`);

            if (stuckStateStreak[ip] >= 2) {
                stuckStateStreak[ip] = 0;
                console.log(`[Watchdog] 🚨 ${ip} stuck in PLAY_STATE + INVALID_SOURCE across 2 consecutive polls — forcing targeted reboot...`);
                appendWatchdogLog(ip, {
                    type:   'watchdog_recovery',
                    action: 'stuck_state_reboot',
                    reason: 'PLAY_STATE + INVALID_SOURCE persisted across 2 consecutive 5-min polls'
                });
                await rebootSpeakerAndReload(ip);
            }
        } else {
            stuckStateStreak[ip] = 0;
        }
    } catch (e) {
        // Unreachable speaker is the offline watchdog's job (device_state.js), not this one.
        stuckStateStreak[ip] = 0;
    }
}

// --- SPEAKER DISCOVERY ---
// Scans a /24 subnet for Bose SoundTouch speakers via parallel /info requests.
// Used both at boot (auto-discovery when speakers.json has template data) and
// by the manual discovery endpoint in tools.js.
async function discoverSpeakers(subnet) {
    const parser = new xml2js.Parser({ explicitArray: false });
    const promises = [];

    for (let i = 1; i <= 254; i++) {
        const ip = `${subnet}.${i}`;
        promises.push(
            axios.get(`http://${ip}:8090/info`, { timeout: 1500 })
                .then(async res => {
                    try {
                        const data = await parser.parseStringPromise(res.data);
                        if (!data || !data.info) return null;
                        const type = data.info.type ? String(data.info.type) : '';
                        if (!type.toLowerCase().includes('soundtouch')) return null;
                        const name = data.info.name ? String(data.info.name) : 'Unknown Speaker';
                        const deviceId = data.info.deviceID ? String(data.info.deviceID)
                                       : (data.info.$ && data.info.$.deviceID) ? String(data.info.$.deviceID)
                                       : null;
                        return { name, ip, deviceId, type };
                    } catch {
                        return null;
                    }
                })
                .catch(() => null)
        );
    }

    const results = await Promise.allSettled(promises);
    return results
        .filter(r => r.status === 'fulfilled' && r.value !== null)
        .map(r => r.value);
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
    rebootSpeakerAndReload,
    isHybridContentItem,
    speakerHasPresets,
    speakerHasHybridPresets,
    getHybridPresetDefinitions,
    pushPresetsToSpeaker,
    appendWatchdogLog,
    queryPresetsForSpeaker,
    updateWatchdogGlobals,
    discoverSpeakers
};
