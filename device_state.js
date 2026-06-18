const axios = require('axios');
const xml2js = require('xml2js');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

// --- IMPORTS ---
const mass = require('./routes/mass');
const utils = require('./routes/utils');

// --- NEW STATE ENGINE ---
const NATIVE_CACHE = {};   // Holds raw data pushed by WebSocket
const FINAL_STATE = {};    // Holds fully processed data (after MASS overrides and scrubbing)
const POISONED_DEVICES = {}; // Track bad metadata log suppression states per IP
const DEBOUNCE_TIMERS = {};
const DEBOUNCE_DELAY_MS = 500; // The "Anti-Flicker" window
const LAST_VALID_STATE = {};
const MAX_OFFLINE_RETRIES = 5;
const OFFLINE_COUNTS = {};
const LAST_METADATA = {};
const STOP_TIMERS = {}; // Replaces STOP_COUNTS for WebSocket time
const EXPECTATIONS = {}; // Tracks active UI Locks
const TRACK_TIME_ANCHOR = {}; // Fixes Bose gapless time accumulation
const WAKE_MEMORY = {}; // App Mem for Behavior 4
const AUTO_RESUME_TIMERS = {}; // Tracks timers thy can be cancelled if interrupted

// BAD_META: List of keywords indicating the speaker is not playing real content.
const BAD_META = ["MUSIC ASSISTANT", "READY", "OBJECT", "LOADING...", "", "AIRPLAY", "UNKNOWN", "STOPPED", "STANDBY", "UPNP", "INVALID_SOURCE", "NULL"];
// --- HELPERS (UNTOUCHED) ---
const isBadMeta = (t) => !t || BAD_META.includes(t.toUpperCase());


// --- DYNAMIC SETTINGS READER ---
let settingsErrorLogged = false;
function getAutoResumeSetting() {
    try {
        const settingsFile = path.join(process.cwd(), 'config', 'settings.json');
        
        if (fs.existsSync(settingsFile)) {
            const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
            
            // If it succeeds, reset the error flag so it warn again if it breaks later
            settingsErrorLogged = false; 
            
            return settings.autoResumePreset === true;
        } else {
            // File doesn't exist
            if (!settingsErrorLogged) {
                console.log(`[DeviceState] ⚠️ settings.json not found. Defaulting auto-resume to FALSE.`);
                settingsErrorLogged = true; //Marks the error as logged
            }
        }
    } catch (e) {
        // File exists but is corrupted, locked, or unreadable
        if (!settingsErrorLogged) {
            console.log(`[DeviceState] ⚠️ Could not read settings.json (${e.message}). Defaulting auto-resume to FALSE.`);
            settingsErrorLogged = true; // Marks the error as logged
        }
    }
    
    return false; //default fallback value is false
}


function cleanContentItem(raw, playStatus) {
    if (!raw) return { source: "Ready" };
    const attr = raw.$ || {};
    let source = raw.source || attr.source || "Ready";
    let type = raw.type || attr.type || "";
    let location = raw.location || attr.location || "";
    let itemName = raw.itemName || "";

    if (playStatus === 'STOP_STATE') source = 'Ready';

    return { source, type, location, itemName, containerArt: raw.containerArt || raw.art || (raw.img ? raw.img._ : "") || "" };
}

function determineActivePreset(cleanItem, presetsD, isStandby, source, massIsActiveDriver, deviceIp) {
    let activePreset = 0;
    if (cleanItem.source === 'Preset') activePreset = parseInt(cleanItem.location) || 0;
    if (activePreset === 0 && cleanItem.itemName) {
        const m = cleanItem.itemName.match(/Preset (\d+)/i);
        if (m) activePreset = parseInt(m[1]);
    }
    if (activePreset === 0 && cleanItem.location) {
        const m = cleanItem.location.match(/\/preset\/(\d+)\.mp3/);
        if (m) activePreset = parseInt(m[1]);
    }
    if (activePreset === 0 && !isStandby && cleanItem.location && presetsD && presetsD.presets && presetsD.presets.preset) {
        const allPresets = Array.isArray(presetsD.presets.preset) ? presetsD.presets.preset : [presetsD.presets.preset];
        const match = allPresets.find(p => p.ContentItem && p.ContentItem.$.location === cleanItem.location);
        if (match) activePreset = parseInt(match.$.id);
    }
    if (activePreset === 0 && !isStandby && massIsActiveDriver) {
        const mem = mass.getPresetMemory(deviceIp);
        if (mem) {
			// Added INVALID_SOURCE and Ready so the preset button stays lit while paused
            const stickySources = ['LOCAL_INTERNET_RADIO', 'AIRPLAY', 'UPNP', 'INVALID_SOURCE', 'READY', 'Ready'];
            if (stickySources.includes(source)) activePreset = mem.id;
        }
    }
    return activePreset;
}
function resolveMetadataAndStatus(nativeData, massData, source, isPausedByShadow, deviceIp) {
    let finalTrack = nativeData.track;
    let finalArtist = nativeData.artist;
    let finalAlbum = nativeData.album;
    let finalArt = nativeData.art; 
    let rawArtUrl = ""; 
	let rawProvider = "";	
    // 1. Establish baseline status directly from the hardware
    let finalStatus = isPausedByShadow ? 'PAUSE_STATE' : (nativeData.rawStatus === 'BUFFERING_STATE' ? 'PLAY_STATE' : nativeData.rawStatus);  
    let wipeMetadata = false;
    let finalMediaType = nativeData.type || ''; 
    let isMaActive = false; 
    
    if (massData) {
        if ((massData.state === 'idle' || massData.state === 'stopped') && !mass.isRecovering(deviceIp)) {
            finalStatus = 'STOP_STATE';
            wipeMetadata = true;
        } else if (isPausedByShadow) {
            finalStatus = 'PAUSE_STATE';
            isMaActive = true; 
        } else {
            isMaActive = true;           
            // 🛡️ Never override native PLAY/PAUSE state with MASS queue state.
            // MASS state can lag behind native hardware by 10+ seconds. Trust speaker
            // ONLY use MASS state to override a STOP_STATE to mask gapless track loading.
            if (finalStatus === 'STOP_STATE' && massData.state === 'playing') {
                finalStatus = 'PLAY_STATE';
            } else if (finalStatus === 'PLAY_STATE' && massData.state === 'paused' && POISONED_DEVICES[deviceIp]) {
                        // 🛑 THE RESUME FIX (ISSUE #56) - POISON EDGE CASE ONLY
                        // If the socket crashed due to bad metadata, it stops pushing XML updates, 
                        // leaving the native cache permanently stuck on PLAY_STATE.
                        // In this rare edge case, MUST trust MASS's explicit 'paused' state to prevent infinite Play/Pause loops!
                        finalStatus = 'PAUSE_STATE';				
            }
        }
        if (massData.item && massData.item.media_type) finalMediaType = massData.item.media_type;
    }

    const keepNative = ((source === 'AIRPLAY' || source === 'UPNP') && !isBadMeta(finalTrack) && !isMaActive); 

    if (wipeMetadata) {
        finalTrack = ""; finalArtist = ""; finalAlbum = ""; finalArt = null;
    } else if (!keepNative && massData && massData.meta) {
        const meta = massData.meta;
        finalTrack = utils.scrubText(meta.name || massData.item.name || finalTrack);
        if (meta.artists && Array.isArray(meta.artists)) {
            finalArtist = utils.scrubText(meta.artists.map(a => a.name).join(', '));
        } else if (meta.artist) {
            finalArtist = utils.scrubText(meta.artist.name || meta.artist);
        } else {finalArtist = "";}
		
        finalAlbum = utils.scrubText(meta.album ? (meta.album.name || meta.album) : finalAlbum);        
        // --- SMART ARTWORK SELECTION  ---
        if (meta.metadata && meta.metadata.images && meta.metadata.images.length > 0) {
            const imgs = meta.metadata.images;
			const bestImg = imgs.find(i => i.type === 'thumb') || imgs.find(i => i.type === 'landscape') || imgs[0];            
            rawArtUrl = bestImg.path;
            rawProvider = bestImg.provider;
        } else if (massData.item.image) {
            rawArtUrl = massData.item.image.path || massData.item.image;
            if (typeof massData.item.image === 'object') rawProvider = massData.item.image.provider;
        }

        if (rawArtUrl) finalArt = utils.buildImageUrl(rawArtUrl, rawProvider, massData.item.uri);
    }

    const isJunkArt = !finalArt || finalArt.includes('default-image') || finalArt.includes('placeholder') || finalArt.includes('Unknown');
    if (isJunkArt) finalArt = "";
    if (finalTrack === "Music Assistant") finalTrack = "";

	return { track: finalTrack, artist: finalArtist, album: finalAlbum, art: finalArt, playStatus: finalStatus, mediaType: finalMediaType, provider: rawProvider || '' };

}

// =========================================================
// --- HELPER: BEHAVIOR 4 (AUTO-RESUME PRESET) ---
// =========================================================
function handleWakeMemory(ip, isStandby, activePreset, finalPlayStatus, source) {
    if (!getAutoResumeSetting()) return; // Check settings.json

    // 1. RECORDING & CANCELLATION
    if (!isStandby) {
        const userIsLoadingSomething = EXPECTATIONS[ip] && (EXPECTATIONS[ip].type === 'PRESET' || EXPECTATIONS[ip].type === 'TRACK');
        // Guard against stale-cache contradictions: INVALID_SOURCE or Ready combined with a
        // leftover PLAY_STATE from the previous stream is not real playback — don't wipe memory on it.
        const isGenuineStream = finalPlayStatus === 'PLAY_STATE' && source !== 'INVALID_SOURCE' && source !== 'Ready' && source;

        if (AUTO_RESUME_TIMERS[ip] && (activePreset > 0 || isGenuineStream || userIsLoadingSomething)) {
            console.log(`[DeviceState] 🛑 Auto-Resume Cancelled: Speaker natively loaded a source or user action detected.`);
            clearTimeout(AUTO_RESUME_TIMERS[ip]);
            AUTO_RESUME_TIMERS[ip] = null;
        }

        if (activePreset > 0) {
            WAKE_MEMORY[ip] = activePreset;
        } else if (isGenuineStream) {
            // Playing genuine non-preset stream -> forget memory so it boots to vanilla Wi-Fi
            delete WAKE_MEMORY[ip];
        }
    }
    
    // 2. WAKE-UP TRIGGER
    const oldState = LAST_VALID_STATE[ip];
    if (oldState && oldState.isStandby && !isStandby) {
        // The speaker just woke up!
        if (WAKE_MEMORY[ip]) {
            
            // 🛑 CRITICAL BYPASS (ISSUE #55 FIX): 
            // Check if the user woke the speaker by pressing a physical preset button or app button.
            // If EXPECTATIONS has a PRESET lock, we absolutely know a command is already in flight!
            if (EXPECTATIONS[ip] && EXPECTATIONS[ip].type === 'PRESET') {
                console.log(`[DeviceState] 🛑 Auto-Resume Bypassed: User woke speaker via Preset action.`);
                return; 
            }

            const presetId = WAKE_MEMORY[ip];
            console.log(`\n[DeviceState] 🌅 Auto-Resume Enabled: Waking up ${ip}. Resuming Preset ${presetId}...`);
            
            // Clear any old pending timers
            if (AUTO_RESUME_TIMERS[ip]) clearTimeout(AUTO_RESUME_TIMERS[ip]);

            // Wait 2.5 seconds for the speaker's network stack to fully settle
            AUTO_RESUME_TIMERS[ip] = setTimeout(async () => {
                
                // Double check right before firing just to be safe
                if (EXPECTATIONS[ip] && EXPECTATIONS[ip].type === 'PRESET') {
                    console.log(`[DeviceState] 🛑 Auto-Resume Bypassed at Execution: User initiated action.`);
                    return; 
                }

                try {
                    await axios.post(`http://${ip}:8090/key`, `<key state="press" sender="Gabbo">PRESET_${presetId}</key>`);
                    await axios.post(`http://${ip}:8090/key`, `<key state="release" sender="Gabbo">PRESET_${presetId}</key>`);
                } catch(e) {
                    console.log(`[DeviceState] ⚠️ Failed to auto-resume preset for ${ip}`);
                }
            }, 2500);
        }
    }
}

// =========================================================
// --- HELPER: EXPECTATION LOCK EVALUATION ---
// =========================================================
function evaluateExpectationLocks(ip, finalTrack, finalPlayStatus, isStandby, isMaster) {
// Slaves must be allowed to be displayed so ReadyForDisplay returns true
    if (!EXPECTATIONS[ip]) return true; // No lock exists, UI is ready for display!

    const exp = EXPECTATIONS[ip];
    const elapsed = Date.now() - (exp.expires - 8000);

    // 1. Check for Safety Timeout
    if (Date.now() > exp.expires) {
        console.log(`[DeviceState] 🔓 Safety Timeout: UI Unlocked for ${ip}`);
        console.log(`[DeviceState] 🚨 Deleting EXPECTATION lock for ${ip}!`);
        delete EXPECTATIONS[ip];
        return true;
    }

    // 2. Evaluate specific lock conditions
    let lockMet = false;

    if (exp.type === 'TRACK' || exp.type === 'PRESET') {
        if (finalTrack && finalTrack !== 'Ready' && finalTrack !== 'Music Assistant') {
            if (finalPlayStatus === 'PLAY_STATE') {
                if (finalTrack !== exp.context || elapsed > 3000) {
                    lockMet = true;
                }
            }
        }
    } else if (exp.type === 'PLAY_STATUS') {
        if (exp.value === 'PLAYING' && finalPlayStatus === 'PLAY_STATE') lockMet = true;
        if (exp.value === 'NOT_PLAYING' && finalPlayStatus !== 'PLAY_STATE') lockMet = true;
    } else if (exp.type === 'POWER') {
        if (isStandby) lockMet = true;
    } else if (exp.type === 'JOIN') {
        // Instantly unlock the UI as soon as speaker confirms it's a slave
        if (!isMaster) lockMet = true;
    }

    // 3. Resolve the lock
    if (lockMet) {
        console.log(`[DeviceState] 🔓 Lock Met (${exp.type}): UI Unlocked for ${ip}`);
        console.log(`[DeviceState] 🚨 Deleting EXPECTATION lock for ${ip}`);
        delete EXPECTATIONS[ip];
        return true;
    } else {
        return false; // 🚫 REJECT THE OVERWRITE! KEEP THE UI LOCKED!
    }
}
// --- AUTO-HEALING WEBSOCKET INITIALIZER ---
async function initDevice(device) {
    console.log(`[DeviceState] 🔌 Initializing Hybrid Engine for ${device.name} (${device.ip})`);
    
    // 1. Setup Baseline Cache
    if (!NATIVE_CACHE[device.ip]) {
        NATIVE_CACHE[device.ip] = { device: device, playStatus: 'STOP_STATE', volume: 0, nowPlaying: {} };
        FINAL_STATE[device.ip] = { ...device, online: false, readyForDisplay: true };
    }
    
    let reconnectDelay = 5000;
    let failedAttempts = 0;
    let activeWs = null; // Stores the socket so the watchdog can kill it

    // 🌟 THE PERMANENT HTTP WATCHDOG (Online & Offline) 🌟
    // A lightweight pulse running in both directions, exactly as you designed.
    setInterval(async () => {
        try {
            await axios.get(`http://${device.ip}:8090/info`, { timeout: 2500 });
            
            // SPEAKER IS ALIVE!
            if (FINAL_STATE[device.ip] && FINAL_STATE[device.ip].online === false) {
                console.log(`[DeviceState] ☀️ Watchdog detected ${device.ip} is back online!`);
                FINAL_STATE[device.ip].online = true;
                
                // Force an immediate fetch to instantly expand the UI card
                await processSettledState(device.ip);
            }
        } catch (e) {
            // SPEAKER IS DEAD!
            if (FINAL_STATE[device.ip] && FINAL_STATE[device.ip].online === true) {
                console.log(`[DeviceState] 🌩️ Watchdog detected ${device.ip} dropped offline.`);
                FINAL_STATE[device.ip].online = false;
                
                // Forcefully kill the zombie WebSocket
                if (activeWs) activeWs.terminate();
            }
        }
    }, 5000);

    // Wrap the connection logic
    async function fetchInitialAndConnect() {
        try {
            const [npRes, volRes] = await Promise.all([
                axios.get(`http://${device.ip}:8090/now_playing`, { timeout: 3500 }).catch(() => null),
                axios.get(`http://${device.ip}:8090/volume`, { timeout: 3500 }).catch(() => null)
            ]);
            const parser = new xml2js.Parser({ explicitArray: false });
            
            if (npRes && npRes.data) {
                let cleanXml = npRes.data.replace(/\ufffd/g, 'a').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
                const npData = await parser.parseStringPromise(cleanXml);
                if (npData.nowPlaying) {
                    NATIVE_CACHE[device.ip].nowPlaying = npData.nowPlaying;
                    if (npData.nowPlaying.playStatus !== undefined) NATIVE_CACHE[device.ip].playStatus = npData.nowPlaying.playStatus;
                }
            }
            if (volRes && volRes.data) {
                let cleanVol = volRes.data.replace(/\ufffd/g, 'a').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
                const volData = await parser.parseStringPromise(cleanVol);
                if (volData.volume && volData.volume.actualvolume) {
                    NATIVE_CACHE[device.ip].volume = parseInt(volData.volume.actualvolume);
                }
            } 
        } catch (e) {}

        const originalLog = console.log;
        if (failedAttempts >= 3) console.log = function() {}; 
        await processSettledState(device.ip);
        console.log = originalLog; 

        // Start the WebSocket
        const ws = new WebSocket(`ws://${device.ip}:8080`, 'gabbo');
        activeWs = ws; // Save to global scope so watchdog can access it

        ws.on('open', () => {
            if (failedAttempts > 0 && !POISONED_DEVICES[device.ip]) {
                console.log(`[DeviceState] 🔌 WS Reconnected to ${device.ip}!`);
            }
            if (!POISONED_DEVICES[device.ip]) {
                reconnectDelay = 5000;
                failedAttempts = 0;
            }
        });

        ws.on('message', async (data) => {
            try {
                let rawXml = data.toString('utf8');
                rawXml = rawXml.replace(/\ufffd/g, 'a').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
                const parser = new xml2js.Parser({ explicitArray: false });
                const result = await parser.parseStringPromise(rawXml);

                if (!result.updates) return;

                if (result.updates.nowPlayingUpdated) {
                    const np = result.updates.nowPlayingUpdated.nowPlaying;
                    NATIVE_CACHE[device.ip].nowPlaying = np; 
                    if (np.playStatus !== undefined) NATIVE_CACHE[device.ip].playStatus = np.playStatus;
                }
                if (result.updates.volumeUpdated) {
                    NATIVE_CACHE[device.ip].volume = parseInt(result.updates.volumeUpdated.volume.actualvolume);
                }
                
                if (result.updates.nowSelectionUpdated) {
                    const selection = result.updates.nowSelectionUpdated;
                    let presetId = 0;
                    if (selection.preset) {
                        presetId = parseInt(selection.preset.id || (selection.preset.$ && selection.preset.$.id) || 0);
                    }
                    if (presetId > 0) {
                        const settingsPath = path.join(process.cwd(), 'config', 'settings.json');
                        let bypassEnabled = false;
                        if (fs.existsSync(settingsPath)) {
                            try {
                                const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
                                bypassEnabled = settings.bypassCloudEmulation === true; 
                            } catch(e) {}
                        }
                        if (bypassEnabled) {
                            console.log(`\n[DeviceState] 🚀 Bypass Cloud ON: Intercepted WebSocket selection for Preset ${presetId} on ${device.ip}`);
                            utils.executeSmartPreset(device.ip, presetId);
                        }
                    }
                }
                
                if (!EXPECTATIONS[device.ip]) FINAL_STATE[device.ip].readyForDisplay = false; 

                if (DEBOUNCE_TIMERS[device.ip]) clearTimeout(DEBOUNCE_TIMERS[device.ip]);
                DEBOUNCE_TIMERS[device.ip] = setTimeout(async () => {
                    await processSettledState(device.ip);
                }, DEBOUNCE_DELAY_MS);

            } catch (err) {}
        });
    
        ws.on('error', (err) => {
            if (err.message.includes('UTF-8')) {
                if (!POISONED_DEVICES[device.ip]) {
                    console.log(`[DeviceState] 🧽 Bad metadata from ${device.ip} broke the socket.`);
                    POISONED_DEVICES[device.ip] = true;
                }
                reconnectDelay = 5000; 
                return; 
            }
            failedAttempts++;
        });
    
        ws.on('close', () => {
            setTimeout(fetchInitialAndConnect, reconnectDelay);
            if (reconnectDelay < 15000 && !POISONED_DEVICES[device.ip]) {
                reconnectDelay = Math.min(reconnectDelay * 2, 15000);
            }
        });
    }

    // Start the engine
    fetchInitialAndConnect();
}


// --- THE LOGIC ENGINE ---
async function processSettledState(ip) {
    const cache = NATIVE_CACHE[ip];
    const device = cache.device;
    const npD = {
        nowPlaying: cache.nowPlaying
    };

    try {
        const [info, zone, presets] = await Promise.all([
                    axios.get(`http://${ip}:8090/info`, {
                        timeout: 3500
                    }).catch(() => null),
                    axios.get(`http://${ip}:8090/getZone`, {
                        timeout: 3500
                    }).catch(() => null),
                    axios.get(`http://${ip}:8090/presets`, {
                        timeout: 3500
                    }).catch(() => null)
                ]);
        // If info endpoint fails, the speaker is physically unplugged or off Wi-Fi.
        // Abort immediately before the engine hardcodes `online: true` below
        if (!info || !info.data) {
            FINAL_STATE[ip] = {
                ...device,
                online: false,
                readyForDisplay: true
            };
            return;
        }

        const parser = new xml2js.Parser({
            explicitArray: false
        });
        const [infoD, zoneD, presetsD] = await Promise.all([
                    info ? parser.parseStringPromise(info.data) : {
                        info: {}
                    },
                    zone ? parser.parseStringPromise(zone.data) : {
                        zone: null
                    },
                    presets ? parser.parseStringPromise(presets.data) : {
                        presets: null
                    }
                ]);

        const myMac = infoD.info.deviceID || (infoD.info.$ && infoD.info.$.deviceID);
        let masterMac = null;
        if (zoneD.zone)
            masterMac = zoneD.zone.master || (zoneD.zone.$ && zoneD.zone.$.master);
        const isMaster = (!masterMac || masterMac === myMac);

        let rawArt = typeof npD.nowPlaying.art === 'string' ? npD.nowPlaying.art : (npD.nowPlaying.art?._ || null);
        let rawTrack = utils.scrubText((npD.nowPlaying.track || '').trim());
        let rawArtist = utils.scrubText((npD.nowPlaying.artist || '').trim());
        let rawAlbum = utils.scrubText((npD.nowPlaying.album || '').trim());
        let station = utils.scrubText(npD.nowPlaying.stationName || '');
        const source = npD.nowPlaying.$ ? npD.nowPlaying.$.source : 'STANDBY';
        const isStandby = source === 'STANDBY';
        let rawStatus = npD.nowPlaying.playStatus || cache.playStatus || 'STOP_STATE';
        let finalMediaType = npD.nowPlaying.ContentItem ? (npD.nowPlaying.ContentItem.type || '') : '';
        // --- TIME & DURATION EXTRACTION ---
        let finalPosition = 0;
        let finalDuration = 0;
        if (npD.nowPlaying.time) {
            finalPosition = parseInt(npD.nowPlaying.time._ || npD.nowPlaying.time) || 0;
            finalDuration = parseInt(npD.nowPlaying.time.$ ? npD.nowPlaying.time.$.total : 0) || 0;
        }
        let finalTrack = rawTrack;
        let finalArtist = rawArtist;
        let finalAlbum = rawAlbum;
        let finalArt = rawArt;
        let finalPlayStatus = (rawStatus === 'BUFFERING_STATE') ? 'PLAY_STATE' : rawStatus;
        let finalProvider = "";

		// --- RESTORED: Standby Preset Wipe ---
        if (isStandby) {
            // 🛑 THE RACE CONDITION FIX (Preset Wake-Up)
            // If the user wakes the speaker by pressing a preset, the HTTP API registers the
            // preset lock INSTANTLY, but the hardware still reports "STANDBY" for another 2 seconds.
            // We must NOT wipe the preset memory if a PRESET expectation is actively locked!
            const isWakingViaPreset = EXPECTATIONS[ip] && EXPECTATIONS[ip].type === 'PRESET';
            
            if (!isWakingViaPreset) {
                mass.setPresetMemory(ip, 0);
                delete LAST_METADATA[ip];
                if (LAST_VALID_STATE[ip] && LAST_VALID_STATE[ip].isStandby === false) {
                    // The 1-2 Punch: Stop the active stream, then clear MA queue completely 
                    mass.stop(ip).catch(() => {});
                    mass.clearQueue(ip).catch(() => {});
                }
            }

            finalPlayStatus = 'STOP_STATE'; // Forces play button to gray
            finalTrack = 'Off'; // Ensures the title resets
        }

        let massIsActiveDriver = false;
        const isMassSourceType = (source === 'UPNP' || source === 'AIRPLAY');
        // THE STICKY DRIVER
        // If Bose pauses a DLNA stream, it drops the socket and reports INVALID_SOURCE.
        // so remember MASS is still driving so the Resume button routes correctly
        const wasMassDriving = LAST_VALID_STATE[ip] && LAST_VALID_STATE[ip].massIsActiveDriver;
        const isOrphaned = (!source || source === 'INVALID_SOURCE' || source === 'Ready');
        // Use the variables to decide if we should check MASS!
        const shouldCheckMass = isMassSourceType || (wasMassDriving && isOrphaned);

        if (shouldCheckMass && !isStandby) {
            if (wasMassDriving && isOrphaned)
                massIsActiveDriver = true; // Lock the driver!
            try {
                const maData = await mass.getRawMetadata(ip);
                if (maData) {
                    massIsActiveDriver = true;
                    const item = maData.item || maData.current_item || {};
                    const meta = maData.meta || item.metadata || {};
                    finalProvider = meta.provider_mappings?.[0]?.provider_domain || meta.provider || 'unknown';

                    // 🛑 STRICT OVERRIDE: MA always knows the true duration during gapless!
                    if (item.duration)
                        finalDuration = parseInt(item.duration);

                    const nativeState = {
                        track: rawTrack,
                        artist: rawArtist,
                        album: rawAlbum,
                        art: rawArt,
                        rawStatus: rawStatus,
                        type: finalMediaType
                    };
                    const overrides = resolveMetadataAndStatus(nativeState, maData, source, false, ip);

                    finalTrack = overrides.track;
                    finalArtist = overrides.artist;
                    finalAlbum = overrides.album;
                    finalArt = overrides.art;
                    finalPlayStatus = overrides.playStatus;
                    finalMediaType = overrides.mediaType;

                    // 🛑 THE GAPLESS TIME FIX
                    // If Bose accumulates time across gapless tracks, anchor the offset when the track changes.
                    if (!TRACK_TIME_ANCHOR[ip] || TRACK_TIME_ANCHOR[ip].track !== finalTrack) {
                        TRACK_TIME_ANCHOR[ip] = {
                            track: finalTrack,
                            offset: finalPosition
                        };
                    }

                    if (TRACK_TIME_ANCHOR[ip].offset > 0) {
                        if (finalPosition >= TRACK_TIME_ANCHOR[ip].offset) {
                            // Gapless continuation: Subtract the accumulated offset
                            finalPosition = finalPosition - TRACK_TIME_ANCHOR[ip].offset;
                        } else {
                            // Hardware finally reset itself natively. Reset our anchor!
                            TRACK_TIME_ANCHOR[ip].offset = 0;
                        }
                    }
                }

                const overrides = resolveMetadataAndStatus(nativeState, maData, source, false, ip);

                finalTrack = overrides.track;
                finalArtist = overrides.artist;
                finalAlbum = overrides.album;
                finalArt = overrides.art;
                finalPlayStatus = overrides.playStatus;
                finalMediaType = overrides.mediaType;
            } catch (e) {
                // Silently ignore MA fetch errors
            }
        } else {
            if (!finalArt || finalArt.includes('default-image') || finalArt.includes('Unknown'))
                finalArt = "";
        }

    const inGroup = (zoneD.zone && zoneD.zone.master);
    if ((source === 'UPNP' || source === 'AIRPLAY') && finalPlayStatus === 'PLAY_STATE') {
        const isJunkMeta = (!finalTrack || finalTrack === "Ready" || BAD_META.includes(finalTrack.toUpperCase()));
        if (isJunkMeta && !mass.isRecovering(ip) && !inGroup) {
            finalPlayStatus = 'STOP_STATE';
            finalTrack = "Ready";
        }
    }

    // --- RESTORED: LAST_METADATA Persistence ---
    const displayTitle = finalTrack || station || "";
    const isMetaValid = (displayTitle && !BAD_META.includes(displayTitle.toUpperCase()));

    if (isMetaValid && !isStandby) {
        LAST_METADATA[ip] = {
            track: finalTrack,
            artist: finalArtist,
            album: finalAlbum,
            art: finalArt,
            station
        };
    } else if (!isMetaValid && !isStandby && finalPlayStatus === 'PAUSE_STATE' && LAST_METADATA[ip]) {
        const saved = LAST_METADATA[ip];
        finalTrack = saved.track;
        finalArtist = saved.artist;
        finalAlbum = saved.album;
        finalArt = saved.art;
        station = saved.station;
    }

    const cleanItem = cleanContentItem(npD.nowPlaying.ContentItem, finalPlayStatus);
    let activePreset = determineActivePreset(cleanItem, presetsD, isStandby, source, massIsActiveDriver, ip);

    if (finalPlayStatus === 'STOP_STATE' && !isStandby) {
        activePreset = 0;
        finalArt = null;
    }
	
	// --- DELEGATE BEHAVIOR 4 LOGIC ---
    handleWakeMemory(ip, isStandby, activePreset, finalPlayStatus, source);

    let artPlaceholder = 'art-blank';
    if (isStandby) {
        artPlaceholder = 'art-off';
    } else {
        const isIdle = (finalPlayStatus === 'STOP_STATE' && (!finalTrack || finalTrack === 'Joining...' || isBadMeta(finalTrack)));
        if (!isIdle && finalProvider === 'builtin')
            artPlaceholder = 'art-globe';
    }

	// --- EXPECTATION LOCK EVALUATION ---
    let readyForDisplay = evaluateExpectationLocks(ip, finalTrack, finalPlayStatus, isStandby, isMaster);

    // --- DETAILED GROUPING LOGGING ---
    const mode = isMaster ? "MASTER" : "SLAVE";
    const oldState = LAST_VALID_STATE[ip];
    if (oldState && oldState.online) { // Only log if transitioning from a known online state
        const oldMode = oldState.mode;
        const oldMasterMac = oldState.zone ? oldState.zone.master : null;
        const newMembers = zoneD.zone && zoneD.zone.member ? (Array.isArray(zoneD.zone.member) ? zoneD.zone.member : [zoneD.zone.member]) : [];
        const oldMembers = oldState.zone && oldState.zone.member ? (Array.isArray(oldState.zone.member) ? oldState.zone.member : [oldState.zone.member]) : [];

        if (oldMode !== mode) {
            if (mode === 'MASTER')
                console.log(`\n[DeviceState] 👑 GROUP STATE: ${ip} became a MASTER / STANDALONE.`);
            if (mode === 'SLAVE')
                console.log(`\n[DeviceState] 🔗 GROUP STATE: ${ip} JOINED a group as a SLAVE (Master: ${masterMac}).`);
        } else if (mode === 'SLAVE' && oldMasterMac !== masterMac) {
            console.log(`\n[DeviceState] 🔀 GROUP STATE: ${ip} SWITCHED to a new Master (${masterMac}).`);
        } else if (mode === 'MASTER') {
            if (oldMembers.length !== newMembers.length) {
                if (newMembers.length > 0) {
                    console.log(`\n[DeviceState] 👥 GROUP STATE: ${ip} group updated. Now hosting ${newMembers.length} Slave(s).`);
                } else if (oldMembers.length > 0 && newMembers.length === 0) {
                    console.log(`\n[DeviceState] 💔 GROUP STATE: ${ip} group disbanded. All Slaves removed.`);
                }
            }
        }
    }
    // ----------------------------------------

    const result = {
        ...device,
        online: true,
        mac: myMac,
        type: (infoD.info.type || "Speaker"),
        volume: cache.volume,
        activePreset,
        isStandby,
        source,
        playStatus: finalPlayStatus,
        track: finalTrack,
        artist: finalArtist,
        album: finalAlbum,
        art: finalArt,
        stationName: station,
        ContentItem: cleanItem,
        mode: isMaster ? "MASTER" : "SLAVE",
        zone: zoneD.zone ? {
            master: masterMac,
            member: zoneD.zone.member || []
        }
         : null,
        massIsActiveDriver,
        readyForDisplay: readyForDisplay,
        artPlaceholder,
        provider: finalProvider,
        duration: finalDuration,
        position: finalPosition
    };

    // =========================================================
    // 🔍 STATE LOGGING (Concise vs Verbose)
    // =========================================================

	if (global.DEBUG_MODE) {
	 // =========================================================
    // 🔍 OMNI-LOG: Dumps ALL state values before updating cache
    // =========================================================	
    console.log(`\n=============================================`);
    console.log(`[DeviceState Engine] -> ${ip}`);
    console.log(`  • ReadyForDisplay : ${readyForDisplay} ${EXPECTATIONS[ip] ? '(LOCKED BY: ' + EXPECTATIONS[ip].type + ')' : ''}`);
    console.log(`  • Power (Standby) : ${isStandby ? 'OFF (true)' : 'ON (false)'}`);
    console.log(`  • Play Status     : ${finalPlayStatus}`);
    console.log(`  • Source          : ${source}`);
    console.log(`  • Media Type      : ${finalMediaType || 'Unknown'}`);
    console.log(`  • Provider        : ${finalProvider || 'Unknown'}`);
    console.log(`  • Track           : ${finalTrack || 'None'} (${finalPosition}s / ${finalDuration}s)`);
    console.log(`  • Artist          : ${finalArtist || 'None'}`);
    console.log(`  • Art URL         : ${finalArt || 'None'}`);
    console.log(`  • Volume          : ${cache.volume}`);
    console.log(`  • Active Preset   : ${activePreset}`);
    console.log(`  • Group Mode      : ${isMaster ? "MASTER" : "SLAVE"}`);
    console.log(`  • MASS is Driver? : ${massIsActiveDriver}`);
    console.log(`=============================================`);
	} else {
        // CONCISE: Print a single line ONLY when the state changes
        const lastState = LAST_VALID_STATE[ip];
        
        if (readyForDisplay) {
            if (finalPlayStatus === 'PLAY_STATE') {
                if (!lastState || lastState.track !== finalTrack || lastState.playStatus !== finalPlayStatus) {
                    console.log(`[DeviceState] 🎵 ${ip} playing "${finalTrack || 'Unknown'}" via ${finalProvider || source || 'Unknown'}`);
                    if (source === 'INVALID_SOURCE' && global.WATCHDOG_MODE === 'observe' && global.WATCHDOG_SPEAKERS?.includes(ip)) {
                        utils.appendWatchdogLog(ip, { ts: new Date().toISOString(), type: 'ws_event', source: 'INVALID_SOURCE' });
                    }
                }
            } else if (isStandby) {
                if (!lastState || !lastState.isStandby) {
                    console.log(`[DeviceState] 💤 ${ip} entered Standby.`);
                }
            }
        }
    }

    LAST_VALID_STATE[ip] = result;
    FINAL_STATE[ip] = result;
    OFFLINE_COUNTS[ip] = 0;

}
catch (error) {
    console.error(`[DeviceState] ❌ Error processing settled state for ${ip}:`, error.message);
	}
}
// --- SYNCHRONOUS GETTER ---
async function get(device) {
    const currentState = FINAL_STATE[device.ip];

    if (currentState && currentState.online === false) {
        OFFLINE_COUNTS[device.ip] = (OFFLINE_COUNTS[device.ip] || 0) + 1;
        if (OFFLINE_COUNTS[device.ip] <= MAX_OFFLINE_RETRIES && LAST_VALID_STATE[device.ip]) {
            return LAST_VALID_STATE[device.ip];
        }
        return { ...device, online: false, readyForDisplay: true };
    }

    // --- RESTORED: Playlist Gap Masking (Replaces STOP_COUNTS) ---
    // If UPnP drops to STOP_STATE, we hold the UI in the previous PLAY_STATE for 4.5 seconds
    // to mask the gap between songs on a playlist.
    if (currentState && currentState.playStatus === 'STOP_STATE' && !currentState.isStandby) {
        const networkSources = ['UPNP', 'AIRPLAY'];
        if (networkSources.includes(currentState.source) && LAST_VALID_STATE[device.ip] && LAST_VALID_STATE[device.ip].playStatus === 'PLAY_STATE') {
            
            if (!STOP_TIMERS[device.ip]) {
                STOP_TIMERS[device.ip] = Date.now();
            }
            
            // If it's been less than 4500ms since we saw the STOP, fake it as still playing
            if (Date.now() - STOP_TIMERS[device.ip] < 4500) {
                return LAST_VALID_STATE[device.ip]; 
            }
        }
    } else {
        delete STOP_TIMERS[device.ip]; // Reset if it starts playing again
    }
    
    // FIX 3: Stop lying on boot! Default to false.
    return currentState || { ...device, online: false, readyForDisplay: true };
}


function clearSession(ip) {
    console.log(`[DeviceState] 🧹 Session Cleared for ${ip} (Power Down / Reset)`);
    // Explicitly lock the UI during power down so the power button doesn't bounce!
    EXPECTATIONS[ip] = { type: 'POWER', expires: Date.now() + 5000 };
    if (FINAL_STATE[ip]) FINAL_STATE[ip].readyForDisplay = false;
}

function setExpectation(target, type, value, extraContext = null) {
    // 1. Resolve Target to IP
    let ip = target;
    if (!target.includes('.')) {
        // Normalize the target by stripping colons/dashes and forcing Uppercase
        const cleanTarget = target.replace(/[:-]/g, '').toUpperCase();
        
        for (const [deviceIp, state] of Object.entries(FINAL_STATE)) {
            if (state.mac && state.mac.toUpperCase() === cleanTarget) {
                ip = deviceIp;
                break;
            }
        }
    }

    if (!FINAL_STATE[ip]) return;
    
    // 2. Set the Lock
    EXPECTATIONS[ip] = { type, value, context: extraContext, expires: Date.now() + 8000 };
    console.log(`[DeviceState] 🔒 UI Locked for ${ip}: Waiting for ${type}...`);
    FINAL_STATE[ip].readyForDisplay = false; 
}

module.exports = {
    initDevice,
    get,
    setExpectation,
    clearSession
};
 
// =================================================================
// --- THE GAPLESS WATCHDOG & LOG UNMUTER ---
// Bose WebSockets go completely silent during gapless UPnP streams.
// This ultra-lightweight loop pings Music Assistant directly every 2.5 seconds
// to catch track changes instantly without hammering the Bose speakers
// =================================================================
setInterval(async () => {
    for (const [ip, state] of Object.entries(FINAL_STATE)) {
        
        // --- VIRTUAL WEBSOCKET FOR POISONED DEVICES ---
        // If the socket crashed, the speaker stops pushing XML events.
        // force a poll to catch Pause/Play clicks and clear UI locks!
        if (POISONED_DEVICES[ip]) {
            await processSettledState(ip);
        }

        // Only check if it's actively playing, driven by MASS, and NOT locked by a user click
        if (state && state.playStatus === 'PLAY_STATE' && state.massIsActiveDriver && !EXPECTATIONS[ip]) {
            try {
                const maData = await mass.getRawMetadata(ip);
                if (maData && maData.item) {
                    const meta = maData.meta || maData.item.metadata || {};
                    let newTrack = utils.scrubText(meta.name || maData.item.name || "");
                    
                    // If MASS reports a new track that isn't the dummy name, trigger an update!
                    if (newTrack && newTrack !== state.track && newTrack !== "Music Assistant") {
                        console.log(`\n[DeviceState] 🐕 Gapless Watchdog caught track change on ${ip}: ${state.track} -> ${newTrack}`);
                        
                        // --- THE RESET & UNMUTE ---
                        // Track advanced! Clear poison suppression state to unlock socket logs
                        if (POISONED_DEVICES[ip]) {
                            console.log(`[DeviceState] 🔓 Clean track signature detected. Re-activating WebSocket log stream for ${ip}.`);
                            delete POISONED_DEVICES[ip];
                        }

                        // Force the engine to update the UI instantly
                        await processSettledState(ip);
                    }
                }
            } catch (e) {
                // Silently ignore network blips so the server doesn't crash
            }
        }
    }
}, 2500);