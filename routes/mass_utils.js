const express = require('express');
const router = express.Router();
const http = require('http');
const axios = require('axios');
const mass = require('./mass');

function dockerAction(action = 'restart') {
    return new Promise((resolve, reject) => {
        const containerName = process.env.MASS_CONTAINER_NAME;
        if (!containerName) return reject(new Error("MASS_CONTAINER_NAME not set in .env"));

        const options = {
            socketPath: '/var/run/docker.sock',
            path: `/v1.41/containers/${containerName}/${action}`,
            method: 'POST',
        };

        const req = http.request(options, (res) => {
            if (res.statusCode === 204 || res.statusCode === 200) resolve(true);
            else reject(new Error(`Docker API Status: ${res.statusCode}`));
        });

        req.on('error', (err) => reject(err));
        req.end();
    });
}

// --- BULLETPROOF HEALTH CHECK ---
async function getMassHealth() {
    const massIp = process.env.MASS_IP;
    const massPort = process.env.MASS_PORT;

    if (!massIp || !massPort) {
        console.log(`[Boot] MASS Health Check Aborted: Missing Config in .env`);
        return { isOnline: false, version: "Unknown" };
    }

    try {
        // Use the explicitly documented unauthenticated /info endpoint
        const infoRes = await axios.get(`http://${massIp}:${massPort}/info`, { timeout: 3500 });
        
        let version = "Running";
        if (infoRes.data) {
            // Extract the version from the JSON response
            version = infoRes.data.server_version || infoRes.data.version || "Running";
        }

        return { isOnline: true, version: version };

    } catch (e) {
        // If we get an HTTP error like 403 or 401, the server is still technically online and responding!
        if (e.response) {
            return { isOnline: true, version: "2.x (Auth Required)" };
        }
        
        // A true network error means the Docker container is completely unreachable
        return { isOnline: false, version: "Offline" };
    }
}

// --- DYNAMIC PLAYER CONFIGURATION ENFORCER (WITH REGEX IP MATCH) ---
async function enforcePlayerConfigs(speakers) {
    const massIp = process.env.MASS_IP;
    const massPort = process.env.MASS_PORT;
    const baseUrl = `http://${massIp}:${massPort}`;
    
    console.log(`\n---------------------------------------------------------------------------------------`);
    console.log(`[MASS Utils] ⚙️ Auditing core configurations dynamically (Strict Exact Matching)...`);
    console.log(`---------------------------------------------------------------------------------------`);

    try {
        const authRes = await axios.post(`${baseUrl}/auth/login`, {
            provider_id: "builtin",
            credentials: { 
                username: process.env.MASS_USERNAME, 
                password: process.env.MASS_PASSWORD 
            }
        });

        const token = authRes.data.token;
        if (!token) throw new Error("Authentication succeeded but no token returned.");
        
        const reqConfig = { 
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 5000 
        };

        let massPlayers = [];
        for (let attempts = 1; attempts <= 6; attempts++) {
            const playersRes = await axios.post(`${baseUrl}/api`, { command: "players/all", args: {} }, reqConfig);
            massPlayers = playersRes.data || [];
            
            // REVERTED FIX: Strict Boundary Regex for IP discovery
            const visibleCount = speakers.filter(speaker => {
                const ipRegex = new RegExp(`\\b${speaker.ip.replace(/\./g, '\\.')}\\b`);
                return massPlayers.find(p => ipRegex.test(JSON.stringify(p)));
            }).length;
            
            if (visibleCount === speakers.length) {
                console.log(`[MASS Utils] 🎯 MASS has successfully discovered all ${speakers.length} speakers.`);
                break; 
            } else if (attempts < 6) {
                console.log(`[MASS Utils] ⏳ MASS has only discovered ${visibleCount}/${speakers.length} speakers. Waiting 5s... (Attempt ${attempts}/6)`);
                await new Promise(r => setTimeout(r, 5000));
            } else {
                console.log(`[MASS Utils] ⚠️ Timeout. Proceeding to audit only the ${visibleCount} discovered speakers.`);
            }
        }

        for (const speaker of speakers) {
            // REVERTED FIX: Strict Boundary Regex for speaker targeting
            const ipRegex = new RegExp(`\\b${speaker.ip.replace(/\./g, '\\.')}\\b`);
            const player = massPlayers.find(p => ipRegex.test(JSON.stringify(p)));
            if (!player) continue;

            const configRes = await axios.post(`${baseUrl}/api`, { 
                command: "config/players/get", 
                args: { player_id: player.player_id } 
            }, reqConfig).catch(() => null);

            if (!configRes || !configRes.data || !configRes.data.values) continue;
            const currentValues = configRes.data.values;
            
            const dlnaId = Object.keys(currentValues).find(k => k.startsWith('uuid:') && k.includes('||protocol||'))?.split('||')[0] || null;
            const airplayId = Object.keys(currentValues).find(k => k.startsWith('ap') && k.includes('||protocol||'))?.split('||')[0] || null;

            let currentProtocol = currentValues['preferred_output_protocol']?.value || "";
            
            let activeMode = (currentProtocol === airplayId || currentProtocol.startsWith('ap') || currentProtocol.startsWith('spb') || currentProtocol.includes('native')) ? 'airplay' : 'dlna'; 
            let targetConfigs = {};

            // STRICT EXACT MATCH: Values mirrored exactly from the Gold Standard JSON
            if (activeMode === 'airplay') {
                targetConfigs["preferred_output_protocol"] = airplayId; 
                targetConfigs["power_control"]             = "none";
                targetConfigs["auto_play"]                 = false; 
                targetConfigs["volume_normalization"]      = false;
                targetConfigs["output_limiter"]            = false; 
                targetConfigs["tts_pre_announce"]          = false;
                targetConfigs["smart_fades_mode"]          = "disabled"; 
                targetConfigs["volume_control"]            = "none";
                targetConfigs["mute_control"]              = "none";
            } else {
                // DLNA Mode Enforcement
                targetConfigs["preferred_output_protocol"] = dlnaId; 
                targetConfigs["power_control"]             = "none";
                targetConfigs["auto_play"]                 = false; 
                targetConfigs["volume_normalization"]      = false;
                targetConfigs["output_limiter"]            = false; 
                targetConfigs["tts_pre_announce"]          = false;
                targetConfigs["smart_fades_mode"]          = "disabled"; 
                targetConfigs["volume_control"]            = dlnaId; 
                targetConfigs["mute_control"]              = dlnaId; 
            }

            // --- THE BATCH FIX ---
            let changesMade = [];
            let batchPayload = {};
            let errorsEncountered = 0;

            // Gather required updates using strict inequality (!==) to ensure exact type and string match
            for (const [key, targetValue] of Object.entries(targetConfigs)) {
                // Ensure target value actually exists before comparing (failsafe for missing IDs)
                if (targetValue !== null && targetValue !== undefined) {
                    if (!currentValues[key] || currentValues[key].value !== targetValue) {
                        batchPayload[key] = targetValue;
                        changesMade.push(`${key} -> ${targetValue}`);
                    }
                }
            }

            if (Object.keys(batchPayload).length > 0) {
                try {
                    await axios.post(`${baseUrl}/api`, {
                        command: "config/players/save",
                        args: { 
                            player_id: player.player_id, 
                            values: batchPayload 
                        }
                    }, reqConfig);
                    
                    await new Promise(r => setTimeout(r, 500)); 
                    
                } catch (err) {
                    errorsEncountered++;
                    const errorReason = err.response?.data?.message || err.response?.data?.detail || err.response?.data || err.message;
                    console.error(`[MASS Utils] ❌ Failed to save batched configs on ${player.name}`);
                    console.error(`            ↳ Reason:`, typeof errorReason === 'object' ? JSON.stringify(errorReason) : errorReason);
                }
            }

            if (changesMade.length > 0 && errorsEncountered === 0) {
                console.log(`[MASS Utils] ✅ Applied ${changesMade.length} strict update(s) to ${player.name} (${activeMode.toUpperCase()}):`);
                changesMade.forEach(change => console.log(`   ↳ ${change}`));
            } 
            
            if (errorsEncountered === 0 && changesMade.length === 0) {
                console.log(`[MASS Utils] ⚡ ${player.name} (${activeMode.toUpperCase()}) core config verified (Exact Match).`);
            } else if (errorsEncountered > 0) {
                console.log(`[MASS Utils] ⚠️ ${player.name} encountered an error saving the batch.`);
            }
        }
    } catch (e) {
        console.error(`[MASS Utils] ❌ Failed to authenticate or reach MASS API:`, e.response?.data || e.message);
    }
}


// --- THE CLEAN SLATE PROTOCOL (SMART POWER OFF ALL) ---
async function powerOffAllSpeakers() {
    const fs = require('fs');
    const path = require('path');
    const speakersPath = path.join(process.cwd(), 'config', 'speakers.json');
    if (!fs.existsSync(speakersPath)) return;
    
    const SPEAKERS = JSON.parse(fs.readFileSync(speakersPath, 'utf8'));
    const LOCAL_PORT = process.env.APP_PORT || 3000;
    
    console.log(`\n[Admin] 🧹 Putting all active speakers to sleep before MASS restart...`);

    const sleepTasks = SPEAKERS.map(async (speaker) => {
        try {
            const statusRes = await axios.get(`http://${speaker.ip}:8090/now_playing`, { timeout: 2000 });
            if (!statusRes.data.includes('source="STANDBY"')) {
                console.log(`   └─ 💤 Initiating smart power-down for ${speaker.name}...`);
                console.log(`   └─ 🔀 Routing POWER command through the Smart Controller...`);
                // Route directly to controller.js
                await axios.post(`http://127.0.0.1:${LOCAL_PORT}/api/key`, {
                    ip: speaker.ip,
                    key: 'POWER'
                });
            }
        } catch (e) {
            console.error(`   └─ ⚠️ Could not reach ${speaker.name} to power it down.`);
        }
    });

    await Promise.allSettled(sleepTasks);
    await new Promise(r => setTimeout(r, 1500)); 
}


// POST /api/admin/restart_ma
router.post('/restart_ma', async (req, res) => {
    console.log(`\n-----------------------------------------------------------------------`);
    console.log(`[Admin] 🧹 Manual MASS restart requested via Web UI...`);
    console.log(`-----------------------------------------------------------------------`);
	
	// 🔥 EXECUTE UNIFIED SMART SHUTDOWN BEFORE KILLING DOCKER
    await powerOffAllSpeakers();
	
	
    
    // 1. Instantly release the UI so the frontend button doesn't freeze
    res.json({ success: true, message: "Restarting Music Assistant..." });

    try {
        await dockerAction('restart');
        if (mass && mass.resetHealth) mass.resetHealth();

        console.log(`[Admin] ⏳ Waiting for Music Assistant Docker container to boot...`);
        
        let massHealth = { isOnline: false };
        let attempts = 0;
        
        // 2. SMART POLLING USING YOUR HEALTH CHECK
        while (!massHealth.isOnline && attempts < 15) {
            await new Promise(r => setTimeout(r, 2000)); 
            massHealth = await getMassHealth();
            if (!massHealth.isOnline) {
                process.stdout.write('.'); // Print dots while waiting
                attempts++;
            }
        }
        if (attempts > 0) console.log(); // Clear the dots line

        // 3. CONFIRMATION & CONFIGURATION HEALING
        if (massHealth.isOnline) {
            console.log(`[Admin] ✅ Music Assistant is successfully back online (v${massHealth.version})!`);
            
            // We MUST re-run the configuration audit because MASS just lost its DB connections
            const fs = require('fs');
            const path = require('path');
            const speakersPath = path.join(process.cwd(), 'config', 'speakers.json');
            
            if (fs.existsSync(speakersPath)) {
                const SPEAKERS = JSON.parse(fs.readFileSync(speakersPath, 'utf8'));
                await enforcePlayerConfigs(SPEAKERS);
            }
        } else {
            console.log(`[Admin] ⚠️ MASS restart timeout. It may still be booting in the background.`);
        }
    } catch (err) {
        console.log(`[Admin] ❌ Failed to complete MASS restart sequence: ${err.message}`);
    }
});

module.exports = {
    router, 
    dockerAction,
    getMassHealth,
    enforcePlayerConfigs
};