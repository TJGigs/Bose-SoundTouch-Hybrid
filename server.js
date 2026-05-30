// ============================================================================
// PHASE 1: IMPORTS & CONSTANTS
// ============================================================================
const CURRENT_VERSION = "v3.4.2";
let UPDATE_CACHED_DATA = { updateAvailable: false, current: CURRENT_VERSION };

const express = require('express');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');
const axios = require('axios');
const xml2js = require('xml2js');
const cors = require('cors');

// ============================================================================
// PHASE 2: DIRECTORY SETUP & LIVE LOGGER
// ============================================================================
// Use process.cwd() to guarantee we are at the absolute root of the /app folder in Docker
const APP_ROOT = process.cwd();
const USER_ROOT = path.join(APP_ROOT, 'config');

if (!fs.existsSync(USER_ROOT)) {
    console.log(`[Boot] Creating missing config directory at ${USER_ROOT}`);
    fs.mkdirSync(USER_ROOT, { recursive: true });
}

const LOG_DIR = path.join(USER_ROOT, 'logs');
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

const MAX_LOG_LINES = 350; 
const logBuffer = [];
const originalLog = console.log;
const originalError = console.error;

function captureLog(type, args) {
    const time = new Date().toLocaleTimeString([], { hour12: false });
    const msg = Array.from(args).map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
    logBuffer.push(`[${time}] [${type}] ${msg}`);
    if (logBuffer.length > MAX_LOG_LINES) logBuffer.shift(); 
}

console.log = function() { captureLog('INFO', arguments); originalLog.apply(console, arguments); };
console.error = function() { captureLog('ERROR', arguments); originalError.apply(console, arguments); };

console.log("=======================================================================");
console.log("====      BOSE SOUNDTOUCH HYBRID 2026: STARTUP INITIALIZATION");
console.log("=======================================================================");

// ============================================================================
// PHASE 3: TEMPLATES & MIGRATION ENGINE
// ============================================================================
const envPath = path.join(USER_ROOT, '.env');
const speakersPath = path.join(USER_ROOT, 'speakers.json');
const libraryPath = path.join(USER_ROOT, 'library.json');

// Point explicitly to the /templates subfolder!
const envTemplatePath = path.join(APP_ROOT, 'templates', '.env.template');
const speakersTemplatePath = path.join(APP_ROOT, 'templates', 'speakers.template.json');
const libraryTemplatePath = path.join(APP_ROOT, 'templates', 'library.template.json');

let isReady = true; 

// Handle .env and v3.4 Migration
if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    const firstLine = envContent.split('\n')[0].trim();
    
    if (firstLine !== '# .env file format: v3.4') {
        console.log(`[Boot] Outdated .env format detected. Backing up to .env.bak...`);
        fs.renameSync(envPath, path.join(USER_ROOT, '.env.bak'));
        
        console.log(`[Boot] Copying new v3.4 .env.template...`);
        if (fs.existsSync(envTemplatePath)) {
            fs.copyFileSync(envTemplatePath, envPath);
        } else {
            console.error(`[Boot] CRITICAL: .env.template is missing from ${envTemplatePath}`);
        }
        
        // REPLACED THE DOUBLE BANNER WITH A CLEAN SINGLE-LINE WARNING
        console.log(`[!!] Validation Failed: .env file updated to v3.4. Old settings saved to config/.env.bak`);
        isReady = false; 
    } else {
        console.log(`[Boot] .env (v3.4) already exists. Skipping generation.`);
    }
} else {
    console.log(`[Boot] .env not found. Copying template...`);
    if (fs.existsSync(envTemplatePath)) {
        fs.copyFileSync(envTemplatePath, envPath);
        console.log(`[!!] Validation Failed: Fresh .env file created. Requires user configuration.`);
    } else {
        console.error(`[Boot] CRITICAL: .env.template is missing from ${envTemplatePath}`);
    }
    isReady = false; 
}

// Ensure speakers.json exists
if (!fs.existsSync(speakersPath)) {
    console.log(`[Boot] speakers.json not found. Copying template...`);
    if (fs.existsSync(speakersTemplatePath)) {
        fs.copyFileSync(speakersTemplatePath, speakersPath);
        console.log(`[!!] Validation Failed: Fresh speakers.json file created. Requires user configuration.`);
    } else {
        console.error(`[Boot] CRITICAL: speakers.template.json is missing from ${speakersTemplatePath}`);
    }
    isReady = false; 
} else {
    console.log(`[Boot] speakers.json already exists. Skipping generation.`);
}

// Ensure library.json exists
if (!fs.existsSync(libraryPath)) {
    console.log(`[Boot] library.json not found. Copying template...`);
    if (fs.existsSync(libraryTemplatePath)) {
        fs.copyFileSync(libraryTemplatePath, libraryPath);
    } else {
        console.error(`[Boot] CRITICAL: library.template.json is missing from ${libraryTemplatePath}`);
    }
} else {
    console.log(`[Boot] library.json already exists. Skipping generation.`);
}

// ============================================================================
// PHASE 4: CONFIGURATION VALIDATION (The "Bouncer")
// ============================================================================
if (isReady) {
    // Only parse the file if we know it's not a fresh, empty template
    require('dotenv').config({ path: envPath, override: true });

    // Check required variables
    const requiredEnvVars = ['APP_IP', 'MASS_IP', 'MASS_USERNAME', 'MASS_PASSWORD'];
    for (const v of requiredEnvVars) {
        if (!process.env[v] || process.env[v].trim() === '') {
            console.log(`[!!] Validation Failed: Missing or empty variable -> ${v}`);
            isReady = false;
        }
    }

    // Check for placeholder data in speakers.json
    if (fs.existsSync(speakersPath)) {
        try {
            const speakersData = JSON.parse(fs.readFileSync(speakersPath, 'utf8'));
            const hasTemplateData = speakersData.some(s => s.ip === "999.999.9.9" || s.name.includes("TypeInSpeakerName"));
            if (hasTemplateData) {
                console.log(`[!!] Validation Failed: speakers.json contains template data (TypeInSpeakerName, 999.999.9.9).`);
                isReady = false;
            }
        } catch (e) {
            console.log(`[!!] Validation Failed: speakers.json is invalid JSON.`);
            isReady = false;
        }
    }
}

// ============================================================================
// THE GATEKEEPER: SLEEP OR BOOT?
// ============================================================================
if (!isReady) {
    console.error('========================================================');
    console.error(' ACTION REQUIRED: Setup Incomplete');
    console.error(' 1. Open the folder where your docker .yml file is located.');
    console.error(' 2. Edit the config/.env and config/speakers.json files.');
    console.error(' 3. Restart this container (docker compose restart).');
    console.error('========================================================');
    console.error(' App is safely halted. Fix your config files to boot.');
    
    // This puts Docker to sleep instead of crashing it (No more infinite restart loops!)
    setInterval(() => {}, 1000 * 60 * 60); 
} else {

    // ============================================================================
    // PHASE 5: ENVIRONMENT INITIALIZATION
    // ============================================================================
    const deviceState = require('./device_state');
    const { dockerAction, getMassHealth } = require('./routes/mass_utils');
    const preflight = require('./routes/preflight');

    try {
        if (fs.existsSync('/etc/timezone')) {
            process.env.TZ = fs.readFileSync('/etc/timezone', 'utf8').trim();
        } else {
            process.env.TZ = 'UTC';
        }
    } catch (err) {
        console.warn("[Boot] Could not read timezone, defaulting to UTC.");
        process.env.TZ = 'UTC';
    }

    const SPEAKERS = require(speakersPath);
    const PORT = process.env.APP_PORT;

    // ============================================================================
    // PHASE 6: WEB SERVER & ROUTING
    // ============================================================================
    const app = express();

    if (process.env.TRUST_PROXY === 'true') {
        app.set('trust proxy', true);
        console.log("[Boot] 🛡️  Running behind Reverse Proxy (Trust Proxy Enabled)");
    }		

    app.use(cors());
    app.use(bodyParser.json());
    app.use(express.static(path.join(__dirname, 'public')));

    app.use('/api', require('./routes/controller'));
    app.use('/api', require('./routes/manager'));
    app.use('/api', require('./routes/admin'));
    app.use('/api/admin', require('./routes/mass_utils').router);

    app.use('/', require('./routes/bridge')); 
    app.use('/', require('./routes/bose_cloud'));

    app.get('/api/logs', (req, res) => res.type('text/plain').send(logBuffer.join('\n')));
    app.get('/api/check_update', (req, res) => res.json(UPDATE_CACHED_DATA));
    app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'control.html')));

    // ============================================================================
    // PHASE 7: HARDWARE BOOT SEQUENCE
    // ============================================================================
    async function checkGitHubForUpdates() {
        try {
            const githubRes = await axios.get('https://api.github.com/repos/TJGigs/Bose-SoundTouch-Hybrid-2026/releases/latest', { headers: { 'User-Agent': 'Bose-Hybrid-App' }});
            const latestVersion = githubRes.data.tag_name;
            if (latestVersion !== CURRENT_VERSION) {
                console.log(`\n[Boot] 🚀  SOUNDTOUCH HYBRID UPDATE AVAILABLE! Current: ${CURRENT_VERSION} | Latest: ${latestVersion}`);
                UPDATE_CACHED_DATA = { updateAvailable: true, current: CURRENT_VERSION, latest: latestVersion, url: githubRes.data.html_url };
            } else {
                console.log(`[Boot] ✓ App is up to date (${CURRENT_VERSION})`);
            }
        } catch (e) {
            console.log(`[Boot] ⚠️ Could not check for updates on GitHub.`);
        }
    }

    async function systemBoot() {
        console.log("[Boot] 🧹 Triggering Music Assistant restart to clear orphaned DLNA connections...");
        try {
            await dockerAction('restart');
            console.log("[Boot] ⏳ Waiting 15s for Music Assistant to initialize...");
            await new Promise(r => setTimeout(r, 15000));
        } catch (e) {
            console.error("[Boot] ❌ Docker Restart Failed: Check socket permissions.");
        }

        let massHealth = await getMassHealth();

        if (massHealth.isOnline) {
            console.log(`[Boot] ✅ Music Assistant restarted successfully (v${massHealth.version}).`);
            const minReq = [2, 8, 5];
            const current = massHealth.version.split('.').map(Number);
            const isOutdated = current.some((num, i) => num < minReq[i]);
            if (isOutdated) {
                console.log(`[Boot] ⚠️  NOTICE: Music Assistant 2.8.5 or later is required.`);
            }
        } else {
            console.log("[Boot] ⚠️ Music Assistant failed to report online after restart.");
        }

        await checkGitHubForUpdates();

        console.log("\n=======================================================================");
        console.log(`====      BOSE SOUNDTOUCH HYBRID 2026:  ${CURRENT_VERSION.toUpperCase()}`);
        console.log(`====                  MUSIC ASSISTANT:  v${massHealth.version}`);
        console.log("=======================================================================");

        const parser = new xml2js.Parser({ explicitArray: false });
        for (const s of SPEAKERS) {
            try {
                const res = await axios.get(`http://${s.ip}:8090/info`, { timeout: 1500 });
                const data = await parser.parseStringPromise(res.data);
                const type = data.info.type || data.info.$.type || "Unknown";
                console.log(` [OK] ${s.name.padEnd(20)} | Type: ${type.padEnd(15)} | IP: ${s.ip}`);
            } catch (e) {
                console.log(` [!!] ${s.name.padEnd(20)} | IP: ${s.ip.padEnd(15)} | OFFLINE`);
            }
        }
        console.log("=======================================================================");

		console.log(`\n[Boot] Handing over to Pre-Flight Speaker Configuration...`); 
		console.log(` `);       		
        // --- CHECK FOR FORCE INJECTION FLAG ---
        let forceMode = false;
        let targetIp = 'all';
        const flagPath = path.join(USER_ROOT, 'force_inject.json');

        if (fs.existsSync(flagPath)) {
            try {
                const flagData = JSON.parse(fs.readFileSync(flagPath, 'utf8'));
                forceMode = flagData.forceMode || false;
                targetIp = flagData.targetIp || 'all';
                console.log(`[Boot] 🚨 FORCE INJECTION FLAG DETECTED! Target: ${targetIp}`);
                
                // Immediately delete the flag so it only executes on this specific boot
                fs.unlinkSync(flagPath);
            } catch (e) {
                console.error("[Boot] ⚠️ Error reading force_inject.json flag file.", e);
            }
        }

        // Run setup using the variables (they default to false/'all' if no flag exists)
        const preflightData = await preflight.runSetup(forceMode, targetIp);
        
        if (preflightData.rebootedIps && preflightData.rebootedIps.length > 0) {
			console.log(`\n=======================================================================`);
            console.log(`⏳ SPEAKER REBOOT SEQUENCE INITIATED`);
            console.log(`=======================================================================`);
            console.log(`[Boot] Waiting for ${preflightData.rebootedIps.length} speaker(s) to finish rebooting...`);
            console.log(`[Boot] Bose SoundTouch speakers are historically very slow.`);
            console.log(`[Boot] Please wait ~90 seconds for shutdown and network reconnection.\n`);
            
            console.log(`[Boot] ⏳ Phase 1/2: Allowing 35 seconds for speakers to drop offline...`);
            await new Promise(r => setTimeout(r, 35000));
            
            console.log(`[Boot] ⏳ Phase 2/2: Polling speakers until network reconnects...`);

            // 1. Wait for all rebooted speakers to finish sequentially
            for (const ip of preflightData.rebootedIps) {
                let online = false, attempts = 0;
                let finalInfo = null; 
                process.stdout.write(`[Boot] Polling ${ip} `); 
                
                while (!online && attempts < 24) { 
                    try {
                        const res = await axios.get(`http://${ip}:8090/info`, { timeout: 2000 });
                        online = true;
                        finalInfo = res.data;
                        console.log(` ✅ Online!`);
                    } catch (e) {
                        attempts++;
                        process.stdout.write('.'); 
                        await new Promise(r => setTimeout(r, 5000)); 
                    }
                }
                
                if (!online) {
                    console.log(` ⚠️ Timeout. Moving on.`);
                } else if (finalInfo) {
                    // 2. DETECTION BY DEDUCTION (Legacy USB Check)
                    try {
                        const parser = new xml2js.Parser({ explicitArray: false });
                        const data = await parser.parseStringPromise(finalInfo);
                        const info = data.info || {};
                        const currentMargeUrl = info.margeURL || info.margeServerUrl || "";


						if (!currentMargeUrl.includes(`${process.env.APP_IP}:${process.env.APP_PORT}`)) { 
                            console.log(`\n=======================================================================`);
                            console.log(`🚨 LEGACY V1/V2 CONFIGURATION DETECTED ON ${ip}!`);
                            console.log(`   The speaker is refusing the V3 update because an old USB hack file`);
                            console.log(`   is overriding the internal memory.`);
                            console.log(``);
                            console.log(`   TO FIX THIS AUTOMATICALLY:`);
                            console.log(`   1. Plug your "remote_services" USB setup cable into the speaker.`);
                            console.log(`   2. Reboot the speaker (unplug power, wait 10s, plug back in).`);
                            console.log(`   3. Wait 1 minute for it to connect to Wi-Fi.`);
                            console.log(`   4. Click "Restart SoundTouch Hybrid" in the System Tools menu.`);
                            console.log(``);
                            console.log(`   The Telnet Janitor will detect the USB, safely wipe the file,`);
                            console.log(`   reboot the speaker, and complete the V3 upgrade automatically!`);
                            console.log(`=======================================================================\n`);
                        }
                    } catch (err) {
                        // ignore parse errors
                    }
                }
            }
			
			// 3. --- BATCH PROCESSING & MASS RECOVERY LOGIC ---
            // Triggered natively exactly once after ALL hardware is back online
            console.log(`\n=======================================================================`);
            console.log(`✅ ALL SPEAKER REBOOTS COMPLETE`);
            console.log(`=======================================================================\n`);
            
            console.log(`[Boot] Restarting Music Assistant to recover DLNA streams...`);	
            try {
                await dockerAction('restart');
                console.log(`[Boot] ⏳ Waiting 15s for MASS to re-initialize...`);
                await new Promise(r => setTimeout(r, 15000));
                
                const health = await getMassHealth();
                if (health.isOnline) {
                    console.log(`[Boot] ✅ MASS connection restored (v${health.version}).`);
                } else {
                    console.log(`[Boot] ⚠️ MASS did not report online.`);
                }
            } catch (err) {
                console.error(`[Boot] ❌ Failed to restart MASS: ${err.message}`);
            }
        }

        if (!preflightData.success) console.log(`[Boot] ⚠️ Pre-Flight encountered a soft error. Continuing boot...`);

        console.log("-----------------------------------------------------------------------");
        console.log(`[Boot] Connecting Real-time WebSockets...`);
        SPEAKERS.forEach(s => deviceState.initDevice(s));
        
        console.log("-----------------------------------------------------------------------");
        console.log(`➡️  Web UI accessible at: http://${process.env.APP_IP}:${PORT}/control.html\n`);
    }

    app.listen(PORT, '0.0.0.0', systemBoot);
} // <--- This closes the Gatekeeper "else" block!
