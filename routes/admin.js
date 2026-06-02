const express = require('express');
const router = express.Router();
const axios = require('axios');
const xml2js = require('xml2js');
const net = require('net'); 
const BOSE_HEADERS = { headers: { 'Content-Type': 'application/xml' } };
const mass = require('./mass');
const fs = require('fs');      
const path = require('path');  


// --- UNIFIED SMART COMMAND ROUTER ---
// Forwards commands directly to controller.js to inherit Master/Slave and Queue cleanup logic
async function routeToSmartController(ip, key) {
    const LOCAL_PORT = process.env.APP_PORT;
    console.log(`[Admin] 🔀 Routing ${key} command for ${ip} through the Smart Controller...`);
    await axios.post(`http://127.0.0.1:${LOCAL_PORT}/api/key`, { ip, key });
}

// admin.js (Updated settings logic)
const SETTINGS_FILE = path.join(process.cwd(), 'config', 'settings.json');

function getSettings() {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
        }
    } catch (e) { 
        console.error("[Admin] Error reading settings.json", e); 
    }
    
    return { 
        autoResumePreset: false, 
        autoRestartMass: false, 
        autoSyncVolume: false, 
        autoSortSpeakers: true 
    };
}

router.get('/admin/settings', (req, res) => res.json(getSettings()));

router.post('/admin/settings', (req, res) => {
    try {
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(req.body, null, 4));
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "Failed to save settings.json" });
    }
});
router.get('/admin/settings', (req, res) => res.json(getSettings()));

router.post('/admin/settings', (req, res) => {
    try {
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(req.body, null, 4));
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "Failed to save settings.json" });
    }
});



router.get('/admin/device_status', async (req, res) => {
    const { ip } = req.query;
    try {
        const [bass, clock, autoOff, nowPlaying, info, netStats] = await Promise.all([
            axios.get(`http://${ip}:8090/bass`, { timeout: 1500 }).catch(() => null),
            axios.get(`http://${ip}:8090/clockDisplay`, { timeout: 1500 }).catch(() => null),
            axios.get(`http://${ip}:8090/systemtimeout`, { timeout: 1500 }).catch(() => null),
            axios.get(`http://${ip}:8090/now_playing`, { timeout: 1500 }).catch(() => null),
            axios.get(`http://${ip}:8090/info`, { timeout: 1500 }).catch(() => null),
            axios.get(`http://${ip}:8090/netStats`, { timeout: 1500 }).catch(() => null)
        ]);

        const parser = new xml2js.Parser({ explicitArray: false });
        const result = { bass: 0, clock: 'N/A', autoOff: 'N/A', power: 'UNKNOWN', name: '', nowPlaying: 'Unknown', ssid: '---', rssi: '---', freq: '', fw: '---',rawSource: 'UNKNOWN' };

        if (bass && bass.data) {
            const b = await parser.parseStringPromise(bass.data);
            result.bass = parseInt(b.bass.targetbass || b.bass.actualbass || 0);
        }
        if (nowPlaying && nowPlaying.data) {
            const np = await parser.parseStringPromise(nowPlaying.data);
            const source = np.nowPlaying.$.source;
            result.power = (source === 'STANDBY') ? 'STANDBY' : 'ON';
            result.nowPlaying = (np.nowPlaying.ContentItem && np.nowPlaying.ContentItem.itemName) ? np.nowPlaying.ContentItem.itemName : source;
			result.rawSource = source;
        }
        
        if (info && info.data) {
            const i = await parser.parseStringPromise(info.data);
            result.name = i.info.name;
            if (i.info.components && i.info.components.component) {
                const comps = i.info.components.component;
                const compArray = Array.isArray(comps) ? comps : [comps];
                const scm = compArray.find(c => c.componentCategory === 'SCM');
                if (scm && scm.softwareVersion) {
                    result.fw = scm.softwareVersion;
                }
            }
        }
        
        if (netStats && netStats.data) {
             const ns = await parser.parseStringPromise(netStats.data);
             const devices = ns['network-data']?.devices?.device;
             const device = Array.isArray(devices) ? devices[0] : devices;
             if (device?.interfaces?.interface) {
                 const ifaces = Array.isArray(device.interfaces.interface) ? device.interfaces.interface : [device.interfaces.interface];
                 const wifi = ifaces.find(iface => iface.kind === 'Wireless' || iface.ssid);
                 if (wifi) { 
                     result.ssid = wifi.ssid; 
                     result.rssi = wifi.rssi; 
                     
                     // Parse the frequency into 5G or 2.4G
                     if (wifi.frequencyKHz) {
                         const freqNum = parseInt(wifi.frequencyKHz, 10);
                         if (freqNum >= 5000000) result.freq = '5G';
                         else if (freqNum >= 2400000) result.freq = '2.4G';
                     }
                 }
             }
        }
        if (clock && clock.data) {
             const c = await parser.parseStringPromise(clock.data);
             if (c.clockDisplay && c.clockDisplay.clockConfig) {
                 result.clock = c.clockDisplay.clockConfig.$.userEnable;
             }
        }
        if (autoOff && autoOff.data) {
             const a = await parser.parseStringPromise(autoOff.data);
             if (a.systemtimeout) result.autoOff = a.systemtimeout.powersaving_enabled;
        }
        res.json(result);
    } catch (e) { res.status(500).json({ error: "Failed to fetch state" }); }
});

// --- UNIFIED SMART COMMAND ROUTER ---
// Forwards commands directly to controller.js to inherit Master/Slave and Queue cleanup logic
async function routeToSmartController(ip, key) {
    const LOCAL_PORT = process.env.APP_PORT;
    await axios.post(`http://127.0.0.1:${LOCAL_PORT}/api/key`, { ip, key });
}

// --- UNIFIED SMART POWER LOGIC ---
router.post('/admin/key', async (req, res) => { 
    try { 
        await routeToSmartController(req.body.ip, req.body.key);
        res.send({success:true}); 
    } catch(e) { 
        console.error(`[Admin] Failed to route key ${req.body.key} to smart controller:`, e.message);
        res.status(500).send(e.message); 
    } 
});

// RENAME ROUTE WITH LOGGING
router.post('/admin/name', async (req, res) => { 
    try { 
        console.log(`[Admin] Attempting to rename ${req.body.ip} to "${req.body.name}"...`);
        const boseRes = await axios.post(`http://${req.body.ip}:8090/name`, `<name>${req.body.name}</name>`, BOSE_HEADERS); 
        console.log(`[Admin] Rename response from speaker: HTTP ${boseRes.status}`);
        res.send({success:true}); 
    } catch(e) { 
        console.log(`[Admin] Rename failed on ${req.body.ip}: ${e.response?.data || e.message}`);
        res.status(500).send(e.response?.data || e.message); 
    } 
});

router.post('/admin/bass', async (req, res) => { try { await axios.post(`http://${req.body.ip}:8090/bass`, `<bass>${req.body.value}</bass>`, BOSE_HEADERS); res.send({success:true}); } catch(e) { res.status(500).send(e.message); } });
router.post('/admin/bluetooth', async (req, res) => { try { await axios.post(`http://${req.body.ip}:8090/select`, `<ContentItem source="BLUETOOTH" />`, BOSE_HEADERS); res.send({success:true}); } catch(e) { res.status(500).send(e.message); } });

router.post('/admin/settings_toggle', async (req, res) => { 
    const { ip, tag } = req.body; 
    let endpoint = `/${tag}`; 
    try { 
        const check = await axios.get(`http://${ip}:8090${endpoint}`); 
        const parser = new xml2js.Parser({ explicitArray: false }); 
        const data = await parser.parseStringPromise(check.data); 
        let newState = 'true'; 
        let xmlBody = ''; 
        if (tag === 'clockDisplay') { 
            let current = 'false'; 
            if (data.clockDisplay && data.clockDisplay.clockConfig) current = data.clockDisplay.clockConfig.$.userEnable; 
            newState = (current === 'true') ? 'false' : 'true'; 
            let raw = check.data;
            if (raw.includes('userEnable="')) xmlBody = raw.replace(/userEnable="\w+"/, `userEnable="${newState}"`);
            else xmlBody = raw.replace('/>', ` userEnable="${newState}" />`);
        } else { 
            let current = data[tag] || (data[tag] && data[tag]._) || 'false'; 
            newState = (current === 'true' || current === 'On') ? 'false' : 'true'; 
            xmlBody = `<${tag}>${newState}</${tag}>`; 
        } 
        await axios.post(`http://${ip}:8090${endpoint}`, xmlBody, BOSE_HEADERS); 
        res.send({ success: true, state: newState }); 
    } catch(e) { res.status(500).send({ error: e.message }); } 
});

router.post('/admin/auto_off', async (req, res) => { 
    const { ip } = req.body; 
    try { 
        const check = await axios.get(`http://${ip}:8090/systemtimeout`); 
        const parser = new xml2js.Parser({ explicitArray: false }); 
        const data = await parser.parseStringPromise(check.data); 
        let currentVal = 'true'; 
        if (data.systemtimeout) currentVal = data.systemtimeout.powersaving_enabled; 
        const newState = (currentVal === 'true') ? 'false' : 'true'; 
        const xml = `<systemtimeout><powersaving_enabled>${newState}</powersaving_enabled></systemtimeout>`; 
        await axios.post(`http://${ip}:8090/systemtimeout`, xml, BOSE_HEADERS); 
        res.send({ success: true, state: newState }); 
    } catch(e) { res.status(500).send({ error: e.message }); } 
});
    
router.get('/admin/deepscan', async (req, res) => { 
    const targets = ["info", "netStats","now_playing", "presets","sources","setup"]; 
    const results = {}; 
    for (const t of targets) { 
        try { const r = await axios.get(`http://${req.query.ip}:8090/${t}`); results[t] = r.data; } 
        catch (e) { results[t] = "Error"; } 
    } 
    res.json(results); 
});

// --- SMART SOURCE TOGGLE (Wi-Fi -> AUX -> Bluetooth) ---
router.post('/admin/toggle_source', async (req, res) => {
    const { ip } = req.body;
    const parser = new xml2js.Parser({ explicitArray: false });

    try {
        // 1. Check what the speaker is currently playing
        const npRes = await axios.get(`http://${ip}:8090/now_playing`, { timeout: 3000 });
        const npData = await parser.parseStringPromise(npRes.data);
        
        const currentSource = npData.nowPlaying.$.source;
        let nextPayload = "";
        let finalUiState = ""; // Track the exact string to send back to the UI

        // 2. The Toggle Logic
        if (currentSource === 'AUX') {
            console.log(`[Admin] Toggling ${ip} from AUX to BLUETOOTH`);
            nextPayload = `<ContentItem source="BLUETOOTH" />`;
            finalUiState = "BLUETOOTH";
            
        } else if (currentSource === 'BLUETOOTH') {
            console.log(`[Admin] Toggling ${ip} from BLUETOOTH to WI-FI (Via Silent Stream)`);
            const host = req.get('host'); 
            // Standard Bose tag for custom URLs
            nextPayload = `<ContentItem source="LOCAL_INTERNET_RADIO" location="http://${host}/silent.mp3"><itemName>Ready</itemName></ContentItem>`;               
            mass.setPresetMemory(ip, 0); 
            finalUiState = "WIFI";
            
        } else {
            console.log(`[Admin] Toggling ${ip} from ${currentSource} to AUX`);
            nextPayload = `<ContentItem source="AUX" sourceAccount="AUX" />`;
            finalUiState = "AUX";
        }

        // 3. Send the command to change the source
        try {
            await axios.post(`http://${ip}:8090/select`, nextPayload, BOSE_HEADERS);
        } catch (boseErr) {
            // Bose throws a 500 Server Error on dummy URL.
            // But it successfully drops the Bluetooth/AUX connection and enters 
            // INVALID_SOURCE (Network Ready). So this specific 500 error is a success
            if (finalUiState !== 'WIFI') {
                throw boseErr; // If AUX or BT fail, throw a real error
            }
        }
        
        // 4. Return the correct explicit state to the UI
        res.send({ success: true, new_state: finalUiState });

    } catch (e) {
        console.log(`[Admin] Toggle Error: ${e.message}`);
        res.status(500).send({ error: e.message });
    }
});

// --- TELNET REBOOT ROUTE (PORT 17000) ---
router.post('/admin/reboot_speaker', async (req, res) => { // <-- Added async
    const { ip } = req.body;
    
    try {
        // 1. SMART SHUTDOWN: Check if it's awake before rebooting
        const statusRes = await axios.get(`http://${ip}:8090/now_playing`, { timeout: 2000 });
        
        if (!statusRes.data.includes('source="STANDBY"')) {
            console.log(`[Admin] 💤 Clean shutdown: Routing POWER command for ${ip} before Telnet reboot...`);
            await routeToSmartController(ip, 'POWER');
            
            // Give controller.js and the hardware 1.5 seconds to finish clearing queues
            await new Promise(r => setTimeout(r, 1500));
        }
    } catch (e) {
        console.log(`[Admin] ⚠️ Could not verify power state for ${ip} before reboot. Proceeding anyway.`);
    }

    // 2. EXECUTE THE HARDWARE REBOOT
    console.log(`[Admin] Sending Telnet 'sys reboot' to ${ip} on port 17000...`);
    
    const client = new net.Socket();
    client.on('error', (err) => console.log(`[Admin] Telnet error on ${ip}: ${err.message}`));

    client.connect(17000, ip, () => {
        client.write('sys reboot\r\n');
        setTimeout(() => client.destroy(), 500);
    });

    res.send({ success: true });
});


// --- UNIFIED WI-FI PROVISIONING ---
router.post('/admin/set_wifi', async (req, res) => {
    const { ip, ssid, password } = req.body;
    console.log(`[Admin] Sending Wi-Fi Provisioning to ${ip}... (SSID: ${ssid})`);
    
    const isUsb = (ip === "203.0.113.1" || ip === "192.168.1.1");
    let hasResponded = false;
    const client = new net.Socket();

    client.on('error', (err) => {
        console.log(`[Admin] Telnet error on ${ip}: ${err.message}`);
        if (!hasResponded) {
            res.status(500).send({ error: `Telnet Error: ${err.message}` });
            hasResponded = true;
        }
    });

    if (isUsb) {
        // ==========================================
        // PATH A: USB CONNECTION (Verified)
        // ==========================================
        let outputBuffer = "";
        
        client.on('data', (data) => {
            outputBuffer += data.toString();
            
            // Wait until the speaker prints the </WiFiProfiles> closing tag
            if (outputBuffer.includes('</WiFiProfiles>')) {
                if (outputBuffer.includes(`SSID="${ssid}"`)) {
					console.log(`[Admin] ✅ USB Setup Verified: Profile saved! Waiting for UI to trigger reboot...`);
                    
                    if (!hasResponded) {
                        res.send({ success: true });
                        hasResponded = true;
                    }
                } else {
                    console.log(`[Admin] ❌ USB Setup Failed: SSID not found in memory.`);
                    if (!hasResponded) {
                        res.status(500).send({ error: "Wi-Fi profile did not save to the speaker." });
                        hasResponded = true;
                    }
                }
                setTimeout(() => client.destroy(), 500);
            }
        });

        client.connect(17000, ip, () => {
            console.log(`[Admin] Connected to ${ip}:17000 (USB) - Pushing and Verifying...`);
            // Turn on async responses, clear old profiles, add the new one, and check the file!
            const tapCommands = `async_responses on\r\nnetwork wifi profiles clear\r\nnetwork wifi profiles add ${ssid} wpa_or_wpa2 ${password}\r\nnetwork wifi profiles info\r\n`;
            client.write(tapCommands);
            
            setTimeout(() => {
                if (!hasResponded) {
                    res.status(500).send({ error: "Verification timed out. Check speaker." });
                    hasResponded = true;
                    client.destroy();
                }
            }, 5000);
        });
} else {
        // ==========================================
        // PATH B: NETWORK CONNECTION (Network Switch)
        // ==========================================
        const SERVER_IP = process.env.APP_IP;

        client.connect(17000, ip, () => {
            console.log(`[Admin] Connected to ${ip}:17000 (Network) - Executing Clean Wi-Fi Switch...`);
            
            // 1. Wipe the flash memory
            client.write('network wifi profiles clear\r\n');
            console.log(`[Admin] Sent 'clear'. Waiting 3 seconds...`);
            
            setTimeout(() => {
                // 2. Inject the new Wi-Fi credentials
                client.write(`network wifi profiles add "${ssid}" wpa_or_wpa2 "${password}"\r\n`);
                console.log(`[Admin] Sent 'add'. Waiting 12 seconds for NVRAM save...`);
                
                // 3. Reboot the speaker to apply changes
                setTimeout(() => {
                    client.write('sys reboot\r\n');
                    console.log(`[Admin] Sent 'reboot'. Closing connection.`);
                    
                    if (!hasResponded) {
                        res.send({ success: true });
                        hasResponded = true;
                    }
                    setTimeout(() => client.destroy(), 500);
                }, 12000); // 12-second delay for saving
                    
            }, 3000); // 3-second delay for clearing
        });
    }
});


// --- THE CLEAN SLATE PROTOCOL (SMART POWER OFF ALL) ---
async function powerOffAllSpeakers() {
    const speakersPath = path.join(process.cwd(), 'config', 'speakers.json');
    if (!fs.existsSync(speakersPath)) return;
    
    const SPEAKERS = JSON.parse(fs.readFileSync(speakersPath, 'utf8'));
    console.log(`\n[Admin] 🧹 Putting all active speakers to sleep for a clean restart...`);

    const sleepTasks = SPEAKERS.map(async (speaker) => {
        try {
            const statusRes = await axios.get(`http://${speaker.ip}:8090/now_playing`, { timeout: 2000 });
            if (!statusRes.data.includes('source="STANDBY"')) {
                console.log(`   └─ 💤 Initiating smart power-down for ${speaker.name}...`);
                // Use our new shared helper!
                await routeToSmartController(speaker.ip, 'POWER');
            }
        } catch (e) {
            console.error(`   └─ ⚠️ Could not reach ${speaker.name} to power it down.`);
        }
    });

    await Promise.allSettled(sleepTasks);
    // Give controller.js 1.5 seconds to finish clearing queues before we kill the server
    await new Promise(r => setTimeout(r, 1500)); 
}


// --- RESTART SOUNDTOUCH HYBRID ---
router.post('/admin/restart_hybrid', async (req, res) => {
    console.log(`\n[Admin] 🔄 SoundTouch Hybrid App restart requested via Web UI (Standard).`);
    
    // --- PERSIST VERBOSE DEBUG STATE ---
    if (global.DEBUG_MODE === true) {
        try {
            // Write the flag file with forceMode FALSE so we skip the USB wipe, 
            // but pass debugMode TRUE so the bootloader restores our logs!
            const flagPath = path.join(process.cwd(), 'config', 'force_inject.json');
            fs.writeFileSync(flagPath, JSON.stringify({ 
                forceMode: false, 
                targetIp: 'all', 
                debugMode: true 
            }));
            console.log(`[Admin] 💾 Verbose Debug state saved to disk for standard reboot.`);
        } catch (err) {
            console.error(`[Admin] ⚠️ Could not save debug state for reboot:`, err.message);
        }
    }

	
	// 🔥 EXECUTE UNIFIED SMART SHUTDOWN
    await powerOffAllSpeakers();
	
    res.send({ success: true });
    
    // Wait 1 second to ensure the UI gets the 'success' response, then kill the process.
    // Docker will immediately detect the exit and spin it back up!
    setTimeout(() => {
        console.log(`[Admin] Exiting process now...`);
        process.exit(0); 
    }, 1000);
});

// --- TOGGLE VERBOSE DEBUG ---
router.post('/admin/toggle_debug', (req, res) => {
    global.DEBUG_MODE = req.body.debug === true;
    console.log(`[Admin] Verbose Debug Mode set to: ${global.DEBUG_MODE ? 'ON' : 'OFF'}`);
    res.send({ success: true, debug: global.DEBUG_MODE });
});
// --- GET CURRENT DEBUG STATE ---
router.get('/admin/debug_state', (req, res) => {
    res.json({ debug: global.DEBUG_MODE === true });
});
// --- FORCE NVRAM INJECTION ---
router.post('/admin/force_injection', async (req, res) => {
    const targetIp = req.body.target || 'all';
    
    console.log(`\n=======================================================================`);
    console.log(`🚨 SOUNDTOUCH HYBRID RESTART REQUESTED WITH FORCE NVRAM INJECTION`);
    console.log(`🎯 Target: ${targetIp === 'all' ? 'ALL SPEAKERS' : targetIp}`);
    console.log(`=======================================================================`);
    
	// Write a temporary flag file including the debug state
    const flagPath = path.join(process.cwd(), 'config', 'force_inject.json');
    fs.writeFileSync(flagPath, JSON.stringify({ 
        forceMode: true, 
        targetIp: targetIp,
        debugMode: global.DEBUG_MODE === true // carry over to new session
    }));
	
	// 🔥 EXECUTE UNIFIED SMART SHUTDOWN
    await powerOffAllSpeakers();
	
    // 2. Release the UI immediately
    res.json({ success: true, message: "Flag set. Restarting Hybrid container..." });

    // 3. Kill the process so Docker restarts it and triggers the boot sequence
    setTimeout(() => {
        console.log(`[Admin] Exiting process to apply force injection...`);
        process.exit(0); 
    }, 1000);
});

module.exports = router;

