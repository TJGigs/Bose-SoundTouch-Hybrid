// ============================================================================
// PHASE 1: IMPORTS & CONSTANTS
// ============================================================================
const CURRENT_VERSION = "v3.5.1";
const ENV_SCHEMA_VERSION = "v3.5"; 
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
console.log("====                STARTUP AND INITIALIZATION");
console.log("====           BOSE SOUNDTOUCH HYBRID 2026: " + CURRENT_VERSION.toUpperCase());
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

// Handle .env and Migration
if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    const firstLine = envContent.split('\n')[0].trim();
    
if (firstLine !== `# .env file format: ${ENV_SCHEMA_VERSION}`) {
        console.log(`[Boot] Outdated .env format detected. Backing up to .env.bak...`);
        fs.renameSync(envPath, path.join(USER_ROOT, '.env.bak'));
        
        console.log(`[Boot] Copying new ${ENV_SCHEMA_VERSION} .env.template...`);
        if (fs.existsSync(envTemplatePath)) {
            fs.copyFileSync(envTemplatePath, envPath);
        } else {
            console.error(`[Boot] CRITICAL: .env.template is missing from ${envTemplatePath}`);
        }
        
        console.log(`[!!] Validation Failed: .env file updated to ${ENV_SCHEMA_VERSION}  Old settings saved to config/.env.bak`);
        isReady = false; 
    } else {
        console.log(`[Boot] .env ${ENV_SCHEMA_VERSION} already exists. Skipping generation.`);
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

// ---------------------------------------------------------
// ⚙️ AUTO-GENERATE DEFAULT SETTINGS
// ---------------------------------------------------------
const settingsPath = path.join(USER_ROOT, 'settings.json');
if (!fs.existsSync(settingsPath)) {
    console.log(`[Boot] settings.json not found. Generating default preferences...`);
    const defaultSettings = {
        autoResumePreset: false,
        autoRestartMass: false,
        autoSyncVolume: false,
        mobileAutoSortSpeakers: true,  
        scheduledSpeakerAudit: true,   
        scheduledRestart: false,
        includeReboot: false,
        searchMenuOrder: ['global', 'radio', 'nas', 'spotify']
    };
    fs.writeFileSync(settingsPath, JSON.stringify(defaultSettings, null, 4));
} else {
    console.log(`[Boot] settings.json already exists. Skipping generation.`);
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

    // Smart Timezone Detection & Logging
    if (process.env.TZ) {
        // Docker passed it successfully from the .yml file
        console.log(`[Boot] 🕒 Timezone loaded from Docker config: ${process.env.TZ}`);
    } else {
        // User forgot to set it in the .yml file
        process.env.TZ = 'UTC';
        console.log(`[Boot] ⚠️ No Timezone found in Docker .yml. Defaulting to UTC.`);
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
	app.use('/api', require('./routes/admin').router); // Fix: Extracted .router
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
           
		   const githubRes = await axios.get(`https://api.github.com/repos/TJGigs/Bose-SoundTouch-Hybrid-2026/releases/latest?t=${Date.now()}`, { 
                headers: { 
                    'User-Agent': 'Bose-Hybrid-App',
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    'Pragma': 'no-cache'
                }
            });
            
            const latestVersion = githubRes.data.tag_name;
            if (latestVersion !== CURRENT_VERSION) {
                console.log(`\n[Boot] 🚀 SOUNDTOUCH HYBRID UPDATE AVAILABLE! Current: ${CURRENT_VERSION} | Latest: ${latestVersion}\n`);
                UPDATE_CACHED_DATA = { updateAvailable: true, current: CURRENT_VERSION, latest: latestVersion, url: githubRes.data.html_url };
            } else {
                console.log(`\n[Boot] ✓ App is up to date (${CURRENT_VERSION})\n`);
            }
        } catch (e) {
            console.log(`\n[Boot] ⚠️ Could not check for updates on GitHub.\n`);
        }
    }

    async function systemBoot() {
        console.log("\n=======================================================================");
        console.log(`[Boot]          🔍  Checking configured speakers...`);
        console.log("\========================================================================");
        
        const ALIVE_SPEAKERS = [];
        const parser = new xml2js.Parser({ explicitArray: false });
        
        // STEP 1: The Hardware Roll Call (Ping Check)
        for (const s of SPEAKERS) {
            try {
                const res = await axios.get(`http://${s.ip}:8090/info`, { timeout: 1500 });
                const data = await parser.parseStringPromise(res.data);
                const type = data.info.type || data.info.$.type || "Unknown";
                console.log(` [OK] ${s.name.padEnd(20)} | Type: ${type.padEnd(15)} | IP: ${s.ip}`);
                ALIVE_SPEAKERS.push(s); 
            } catch (e) {
                console.log(` [!!] ${s.name.padEnd(20)} | IP: ${s.ip.padEnd(15)} | OFFLINE (Skipping)`);
            }
        }
        console.log("=========================================================================");

		// STEP 2: Force Injection Check & Pre-Flight Execution
        console.log(`\n-----------------------------------------------------------------------`);
        console.log(`[Boot] Handing over to Pre-Flight Speaker Configuration...`); 
        console.log(`-------------------------------------------------------------------------`);       		
        
        let forceInjectTarget = null;
        let forceRebootTarget = null;
        const flagPath = path.join(USER_ROOT, 'force_inject.json');
        if (fs.existsSync(flagPath)) {
            try {
                const flagData = JSON.parse(fs.readFileSync(flagPath, 'utf8'));
                // Read the new variables safely from the JSON payload
                forceInjectTarget = flagData.forceInjectTarget || null;
                forceRebootTarget = flagData.forceRebootTarget || null;
                if (flagData.debugMode === true) {
                    global.DEBUG_MODE = true;
                    console.log(`[Boot] 🐛 Verbose Debug Mode RESTORED from Force flag.`);
                }
                if (forceInjectTarget || forceRebootTarget) {
                    console.log(`[Boot] 🚨 FORCE SEQUENCE FLAG DETECTED!`);
                    if (forceInjectTarget) console.log(`   ├─ Inject Target: ${forceInjectTarget}`);
                    if (forceRebootTarget) console.log(`   ├─ Reboot Target: ${forceRebootTarget}`);
                }                
                // Delete the file so it only executes once!
                fs.unlinkSync(flagPath);
            } catch (e) {
                console.error("[Boot] ⚠️ Error reading force_inject.json flag file.", e);
            }
        }
        // Pass the new variables to the updated engine
        const preflightData = await preflight.runSetup(forceInjectTarget, forceRebootTarget);
        if (!preflightData.success) console.log(`[Boot] ⚠️ Pre-Flight encountered a soft error. Continuing boot...\n`);
        

// STEP 3: The Great Wait (Reboot Polling)
        if (preflightData.rebootedIps && preflightData.rebootedIps.length > 0) {
            console.log(`\n=======================================================================`);
            console.log(`⏳ SPEAKER REBOOT SEQUENCE INITIATED`);
            console.log(`=========================================================================\n`);
            console.log(`[Boot] Waiting for ${preflightData.rebootedIps.length} speaker(s) to finish rebooting...`);
            console.log(`[Boot] Bose SoundTouch speakers are historically very slow.`);
            console.log(`[Boot] Please wait ~90 seconds for shutdown and network reconnection.\n`);
            
            console.log(`[Boot] ⏳ Phase 1/2: Allowing 35 seconds for speakers to drop offline...`);
            await new Promise(r => setTimeout(r, 35000));
            
            console.log(`\n[Boot] ⏳ Phase 2/2: Polling speakers until network reconnects...`);

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
                        
                        if (!ALIVE_SPEAKERS.find(s => s.ip === ip)) {
                            const originalSpeaker = SPEAKERS.find(s => s.ip === ip);
                            if (originalSpeaker) ALIVE_SPEAKERS.push(originalSpeaker);
                        }
                    } catch (e) {
                        attempts++;
                        process.stdout.write('.'); 
                        await new Promise(r => setTimeout(r, 5000)); 
                    }
                }
                
                if (!online) {
                    console.log(` ⚠️ Timeout. Moving on.`);
                } else if (finalInfo) {
                    try {
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
                    } catch (err) {}
                }
            }
            console.log(`\n=======================================================================`);
            console.log(`✅ ALL SPEAKER REBOOTS COMPLETE`);
            console.log(`=======================================================================\n`);
        }

        // STEP 4: Establish Territory (WebSockets)
        console.log(`\n-----------------------------------------------------------------------`);
        console.log(`[Boot] Connecting Real-time WebSockets...`);
        console.log(`-------------------------------------------------------------------------`);
        ALIVE_SPEAKERS.forEach(s => deviceState.initDevice(s));
        
		// STEP 5: The Introduction (Restart MASS)
        console.log(`\n-----------------------------------------------------------------------`);
        console.log(`[Boot] 🧹 Triggering Music Assistant restart for a clean network state...`);
        console.log(`-----------------------------------------------------------------------\n`);
        
        let dockerRestartSuccess = false;
        try {
            await dockerAction('restart');
            console.log(`\n[Boot] ⏳ Waiting for Music Assistant Docker container to boot...`);
            dockerRestartSuccess = true;
        } catch (e) {
            const configuredName = process.env.MASS_CONTAINER_NAME || "NOT SET";
            console.error(`[Boot] ❌ Docker Restart Failed: ${e.message}`);
            console.error(`[Boot] 💡 The app tried to restart the container named: "${configuredName}"`);
            console.error(`[Boot] 💡 Please verify this exactly matches your Music Assistant container name in your config/.env file.`);
            console.error(`[Boot] 💡 Also ensure the docker.sock volume is mapped correctly in your docker-compose.yml file.\n`);
        }

        let massHealth = { isOnline: false, version: "Unknown" };
        let healthAttempts = 0;
        
        // Loop every 2 seconds until the Health Check passes (Max 30 seconds)
        while (!massHealth.isOnline && healthAttempts < 15) {
            await new Promise(r => setTimeout(r, 2000)); 
            massHealth = await getMassHealth();
            if (!massHealth.isOnline) {
                process.stdout.write('.'); // Print dots while waiting
                healthAttempts++;
            }
        }
        if (healthAttempts > 0) console.log(); // Clear the line after dots finish

        if (massHealth.isOnline) {
            // Check the flag to print the correct message!
            if (dockerRestartSuccess) {
                console.log(`[Boot] ✅ Music Assistant restarted successfully (v${massHealth.version}).`);
            } else {
                console.log(`[Boot] ⚠️ Music Assistant is online (v${massHealth.version}), but was NOT restarted.`);
            }
            
            const minReq = [2, 8, 5];
            const current = massHealth.version.split('.').map(Number);
            const isOutdated = current.some((num, i) => num < minReq[i]);
            if (isOutdated) {
                console.log(`[Boot] ⚠️  NOTICE: Music Assistant 2.8.5 or later is required.\n`);
            }

            // STEP 6: Smart Polling & Configuration Injection        
            const { enforcePlayerConfigs } = require('./routes/mass_utils');
            await enforcePlayerConfigs(ALIVE_SPEAKERS);
            console.log(`-------------------------------------------------------------------------`);            

        } else {
            console.log(`\n[Boot] ⚠️ Music Assistant failed to report online after restart.\n`);
        }

        // STEP 7: Check Updates (Standalone Space)
        await checkGitHubForUpdates();

        // STEP 8: The Final Banner
		// 🌟 Cache globally so the frontend UI can fetch them instantly
        global.APP_VERSION = CURRENT_VERSION;
        global.MASS_VERSION = massHealth.version;
        console.log("=========================================================================");
        console.log(`====      BOSE SOUNDTOUCH HYBRID 2026:  ${CURRENT_VERSION.toUpperCase()}`);
        console.log(`====                  MUSIC ASSISTANT:  v${massHealth.version}`);
        console.log("=======================================================================\n");
        console.log(`➡️  Web UI accessible at: http://${process.env.APP_IP}:${PORT}/control.html\n`);
		
		// =======================================================================
        // STEP 9: THE NETWORK KEEP-ALIVE HEARTBEAT
        // =======================================================================
        // Runs every 45 minutes to prevent network routers from killing idle DLNA/AirPlay sockets overnight.
        setInterval(async () => {
            console.log(`\n[Boot] 💓 Executing scheduled Network Keep-Alive ping to Music Assistant...`);
            try {
                const massCore = require('./routes/mass');
                
                // Runs the Soft Rescan (players/all) silently in the background
                // Passing the combined string ensures the backend logs perfectly match the UI
                await massCore.forceRescan(false, 'dlna & airplay'); 
                
            } catch (e) {
                // Silently catch network drops so the Docker container doesn't crash if MA is temporarily offline
                console.error(`[Boot] ⚠️ Keep-Alive heartbeat failed to reach MASS: ${e.message}`);
            }
        }, 45 * 60 * 1000); // 45 minutes in milliseconds
	}	

	const { startScheduler } = require('./routes/utils');
	startScheduler();
    app.listen(PORT, '0.0.0.0', systemBoot);
} // <--- closes the Gatekeeper "else" block
