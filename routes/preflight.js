// routes/preflight.js
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const xml2js = require('xml2js');
const net = require('net');
// ⚠️ WARNING: SET THIS TO false BEFORE GITHUB RELEASE!
const FORCE_TEST_JANITOR = false;


async function auditSpeakerClock(ip, name) {
    try {
        // 1. Calculate the exact local timezone offset right now
        const now = new Date();
        const localUnixTime = Math.floor(now.getTime() / 1000);
        const offsetMinutes = -now.getTimezoneOffset(); // e.g., +120 for ECST
        const offsetSeconds = offsetMinutes * 60;
        const utcUnixTime = localUnixTime - offsetSeconds;

        // 2. Ask the speaker what offset it is currently using
        const checkRes = await axios.get(`http://${ip}:8090/clockTime`, { timeout: 1500 });
        const parser = new xml2js.Parser({ explicitArray: false });
        const data = await parser.parseStringPromise(checkRes.data);
        
        const currentOffset = parseInt(data.clockTime?.offset || "0");

        // 3. Only push an update if the speaker is wrong
        if (currentOffset !== offsetSeconds) {
            console.log(`[Pre-Flight] 🕒 Adjusting timezone offset on ${name} (Daylight/Timezone shift detected)...`);
            const timeXml = `
                <clockTime>
                    <state>SYNC_VALID</state>
                    <utcTime>${utcUnixTime}</utcTime>
                    <localTime>${localUnixTime}</localTime>
                    <offset>${offsetSeconds}</offset>
                </clockTime>
            `.trim();
            await axios.post(`http://${ip}:8090/clockTime`, timeXml, {
                headers: { 'Content-Type': 'application/xml' },
                timeout: 2000
            });
        }
    } catch (e) {
        // Fail silently so it doesn't interrupt the boot sequence
    }
}

// 1. THE NATIVE INJECTOR (Universal Timing Sequence)
function injectPort17000Commands(ip, commands) {
    return new Promise((resolve) => {
        const client = new net.Socket();
        client.setTimeout(20000); 
        let isSocketAlive = true; // 🌟 THE FIX: Flag to abort the loop
        
        client.on('error', (err) => {
            console.log(`   ├─ ❌ Port 17000 Error: ${err.message}`);
            isSocketAlive = false; // Kill the loop
            resolve(false);
        });
        
        client.on('timeout', () => { 
            console.log(`   ├─ ⚠️ Port 17000 Connection Timed Out.`);
            isSocketAlive = false; // Kill the loop
            client.destroy(); 
            resolve(true); 
        });
        
        client.connect(17000, ip, async () => {
            console.log(`   ├─ 🔌 Port 17000 connected. Initiating universal timing sequence...`);
            
            // Bypass lazy-load bug with wake-up carriage returns
            client.write('\r\n');
            await new Promise(r => setTimeout(r, 1000));
            if (!isSocketAlive) return; // Check heartbeat
            client.write('sys configuration\r\n');
            await new Promise(r => setTimeout(r, 1500));
            if (!isSocketAlive) return; // Check heartbeat

			// Sequential injection with universal NVRAM delays
            for (let i = 0; i < commands.length; i++) {
                if (!isSocketAlive) break; // 🌟 THE FIX: Immediately halt injection if socket died

                let cmdLog = commands[i].split(' ')[1] || 'command';
                
                // Extract the actual values for the console log
                if (cmdLog === 'AccountId') {
                    cmdLog = `AccountId -> ${commands[i].split(' ')[3]}`;
                } else if (cmdLog === 'configuration') {
                    cmdLog = `${commands[i].split(' ')[2]}`; 
                } else if (cmdLog === 'boseurls') {
                    cmdLog = `boseurls`;
                }

                console.log(`   ├─ ⚙️  [${i+1}/${commands.length}] Injecting: ${cmdLog}`);
                client.write(commands[i] + '\r\n');
                await new Promise(r => setTimeout(r, 1000)); // Crucial 1000ms universal delay
            }
            
            if (isSocketAlive) {
                client.destroy();
                resolve(true);
            }
        });
    });
}

// THE NATIVE TELNET JANITOR (Upgraded with Error Trapping & Test Mode)
function telnetJanitor(ip, targetIp = 'all') { // 🌟 ADDED targetIp HERE
    return new Promise(async (resolve) => {
        
		// ==========================================
        // 🧪 TEST OVERRIDE MODE (Bypasses Port 23)
        // ==========================================
        // 🌟 ONLY TRIGGER IF A SPECIFIC SPEAKER WAS FORCED IN THE UI
        if (FORCE_TEST_JANITOR && targetIp === ip) { 
            console.log(`   ├─ 🚨 [TEST MODE] Forcing Janitor sequence on ${ip} without USB...`);
            console.log(`   ├─ [Janitor] Logging in as root...`);
            console.log(`   ├─ [Janitor] 🧹 Deleting legacy V1/V2 OverrideSdkPrivateCfg.xml...`);
            console.log(`   ├─ [Janitor] ✅ File successfully deleted from memory.`);
            console.log(`   ├─ [Janitor] Rebooting to clear memory...`);
            
			// 🌟 REAL HARDWARE REBOOT VIA PORT 17000 FOR TIMING TEST
            await injectPort17000Commands(ip, ['sys reboot']);
            
            setTimeout(() => resolve(true), 500);
            return; // 🛑 EXIT EARLY! Do not run the real telnet code below.
        }

        // ==========================================
        // 🏭 REAL PRODUCTION MODE
        // ==========================================
        const client = new net.Socket();
        client.setTimeout(2000); // Give up fast if port 23 is closed
        let shellOutput = "";

        client.on('error', () => resolve(false));
        client.on('timeout', () => { client.destroy(); resolve(false); });

        // Capture shell data to trap errors
        client.on('data', (data) => {
            shellOutput += data.toString();
        });

        client.connect(23, ip, () => {
            console.log(`   ├─ 🚨 [Janitor] PORT 23 (TELNET) IS OPEN! USB Drive detected.`);
            console.log(`   ├─ [Janitor] Logging in as root...`);

            setTimeout(() => {
                client.write('root\r\n');

                setTimeout(() => {
                    console.log(`   ├─ [Janitor] 🧹 Deleting legacy V1/V2 OverrideSdkPrivateCfg.xml...`);
                    // Use -v for verbose output to catch success
                    client.write('rm -fv /var/lib/Bose/PersistenceDataRoot/OverrideSdkPrivateCfg.xml\r\nsync\r\n');

                    setTimeout(() => {
                        // Error trapping based on shell response					
                        if (shellOutput.includes('No such file')) {
                            console.log(`   ├─ ⚠️ [Janitor] Notice: File was already gone. Skipping reboot.`);
                            client.destroy();
                            resolve(false);
                        } else if (shellOutput.toLowerCase().includes('error')) {
                            console.log(`   ├─ ❌ [Janitor] Error wiping file! Check shell output.`);
                            client.destroy();
                            resolve(false);
                        } else {
                            console.log(`   ├─ [Janitor] ✅ File successfully deleted from memory.`);
                            console.log(`   ├─ [Janitor] Rebooting to clear memory...`);
                            client.write('reboot\r\n');

                            setTimeout(() => {
                                client.destroy();
                                resolve(true); 
                            }, 500);
                        }							
						
                    }, 2000); 
                }, 1000); 
            }, 500); 
        });
    });
}
















// LEGACY USB WARNING BANNER
function showLegacyUSBWarning(ip) {
    console.log(`\n=======================================================================`);
    console.log(`🚨 LEGACY V1/V2 CONFIGURATION DETECTED ON ${ip}!`);
    console.log(`   The speaker is refusing the V3 update because an old USB HiJack file`);
    console.log(`   is overriding the internal memory.`);
    console.log(` `);
    console.log(`   TO FIX THIS AUTOMATICALLY:`);
    console.log(`   1. Plug your "remote_services" USB setup cable into the speaker.`);
    console.log(`   2. Reboot the speaker (unplug power, wait 10s, plug back in).`);
    console.log(`   3. Wait 1 minute for it to connect to Wi-Fi.`);
    console.log(`   4. Click "Restart SoundTouch Hybrid" in the System Tools menu.`);
    console.log(` `);
    console.log(`   The Telnet Janitor will detect the USB, safely wipe the file,`);
    console.log(`   reboot the speaker, and complete the V3 upgrade automatically!`);
    console.log(`=======================================================================\n`);
}

// PAUSE PREFLIGHT WHILE JANITOR REBOOTS SPEAKER
async function waitForJanitorReboot(ip) {
    console.log(`   ├─ ⏳ Allowing 35 seconds for ${ip} network stack to shut down...`);
    await new Promise(r => setTimeout(r, 35000)); // 🌟 THE FIX: Hard wait for hardware to drop
    
    let online = false, attempts = 0;
    process.stdout.write(`   ├─ ⏳ Polling ${ip} until network reconnects `);
    while (!online && attempts < 24) {
        try {
            await axios.get(`http://${ip}:8090/info`, { timeout: 2000 });
            online = true;
            console.log(` ✅ Back Online!`);
        } catch(e) {
            attempts++;
            process.stdout.write('.');
            await new Promise(r => setTimeout(r, 5000));
        }
    }
    return online;
}

async function runSetup(forceMode = false, targetIp = 'all') {
    const configPath = path.join(__dirname, '..', 'config', 'speakers.json');
    if (!fs.existsSync(configPath)) {
        console.error("[Pre-Flight] speakers.json not found!");
        return { success: false, rebootedIps: [] };
    }

    const SPEAKERS = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const APP_IP = process.env.APP_IP;
    const APP_PORT = process.env.APP_PORT;
    const parser = new xml2js.Parser({ explicitArray: false });
    const rebootedIps = [];

    // Safely extract string data from xml2js objects
    const extractString = (val) => {
        if (!val) return "";
        if (typeof val === 'string') return val;
        if (val._) return String(val._);
        return String(val);
    };

    for (const speaker of SPEAKERS) {	
        console.log(`[Pre-Flight] 🔍 Checking ${speaker.name} (${speaker.ip})...`);
        
        try {
            // 1. RUN TELNET JANITOR FIRST
			// 1. RUN TELNET JANITOR FIRST
            const justCleaned = await telnetJanitor(speaker.ip, targetIp); // 🌟 JUST ADD targetIp HERE
            //const justCleaned = await telnetJanitor(speaker.ip);
            if (justCleaned) {
                // If it cleaned it, the speaker is rebooting. We must wait!
                const isBack = await waitForJanitorReboot(speaker.ip);
                if (!isBack) {
                    console.log(`   └─ ⚠️ Timed out waiting for speaker. Moving on.`);
                    continue;
                }
                console.log(`   ├─ ✨ Speaker is clean. Proceeding with standard V3 Setup...`);
            }

			const res = await axios.get(`http://${speaker.ip}:8090/info`, { timeout: 2000 });
            const data = await parser.parseStringPromise(res.data);
            const info = data.info || {};
            
            // FIX 1: Extract from the deviceID attribute directly, fallback to a random 7-digit number
            const fallbackId = Math.floor(Math.random() * 10000000).toString();
            const macAddress = extractString(info.$ && info.$.deviceID) || fallbackId;          
            const currentMargeUrl = extractString(info.margeURL || info.margeServerUrl);
            const currentMargeId = extractString(info.margeAccountUUID);
			
			// FIX 2: Invalid list forces reconfiguration (Checks BOTH IP and Port)
            const isUrlConfigured = currentMargeUrl.includes(`${APP_IP}:${APP_PORT}`);
            const hasMargeId = currentMargeId !== "" && currentMargeId !== "0000000" && currentMargeId !== "UNKNOWN_MAC";
			
			// ==========================================================
            // --- SMART CLOCK AUDIT ---
            // checks every speaker
            // ==========================================================
            await auditSpeakerClock(speaker.ip, speaker.name);

            // --- FORCE INJECTION LOGIC ---
            const naturallyNeedsSetup = !isUrlConfigured || !hasMargeId;
            const isForceTarget = forceMode && (targetIp === 'all' || targetIp === speaker.ip);

            // If healthy AND not forced, skip it safely.
            if (!naturallyNeedsSetup && !isForceTarget) {
                console.log(`[Pre-Flight] ✅ ${speaker.name} is already fully configured (MargeID: ${currentMargeId}).`);
                continue; 
            }

            // Otherwise, injecting. Explain exactly why:
            if (naturallyNeedsSetup) {
                console.log(`[Pre-Flight] ⚠️ ${speaker.name} requires setup.`);
                if (!hasMargeId) console.log(`   ├─ Reason: Missing or invalid MargeID.`);
                if (!isUrlConfigured) console.log(`   ├─ Reason: Cloud URL mismatch (Found: "${currentMargeUrl}").`);
            } else if (isForceTarget) {
                console.log(`[Pre-Flight] 🚨 FORCE MODE ENABLED: Bypassing checks. Hybrid Setup Injecting ${speaker.name}...`);
            }
            // --- END FORCE INJECTION LOGIC ---

			console.log(`   ├─ Initiating NVRAM Injection sequence via Port 17000...`);

            const targetMargeId = hasMargeId ? currentMargeId : macAddress;
			// log too display MargeId
            console.log(`   ├─ 🎯 Target MargeID: ${targetMargeId}`);
            const commandList = [];
			
			// Stack URLs first so they don't get blocked by EPIPE
            commandList.push(`sys configuration bmxRegistryUrl http://${APP_IP}:${APP_PORT}/bmx/registry/v1/services`);
            commandList.push(`sys configuration statsServerUrl http://${APP_IP}:${APP_PORT}`);
            commandList.push(`sys configuration margeServerUrl http://${APP_IP}:${APP_PORT}/marge`);
            commandList.push(`sys configuration swUpdateUrl http://${APP_IP}:${APP_PORT}/updates/soundtouch`);
            commandList.push(`envswitch boseurls set http://${APP_IP}:${APP_PORT} http://${APP_IP}:${APP_PORT}/updates/soundtouch`);
            commandList.push(`sys remote_service on`);		
			// ADD COMMAND TO MATCH ISSUE 20 WORKAROUND - Force processor to pause and read its own config
            commandList.push(`getpdo CurrentSystemConfiguration`)
            // Push AccountId LAST like Issue 20 WorkAround
			if (!hasMargeId || isForceTarget) {
                commandList.push(`envswitch AccountId set ${targetMargeId}`);
            }

            console.log(`   ├─ ✍️  Writing configurations sequentially (this takes a few seconds)...`);
            const injectionSuccess = await injectPort17000Commands(speaker.ip, commandList);

            // Trap EPIPE failure and abort reboot
            if (!injectionSuccess) {
                console.log(`   └─ ❌ Injection failed due to socket error. Aborting setup for ${speaker.name}.`);
                continue; 
            }

            console.log(`   ├─ ⏳ Waiting 10 seconds for NVRAM to safely write to flash memory...`);
            await new Promise(resolve => setTimeout(resolve, 10000));

            console.log(`   └─ 🧠 Save complete. Rebooting ${speaker.name}...`);
            await injectPort17000Commands(speaker.ip, [`sys reboot`]);
            rebootedIps.push(speaker.ip);
        } catch (err) {
            console.log(`[Pre-Flight] ❌ Could not reach ${speaker.ip}: ${err.message}`);
        }
    }
    return { success: true, rebootedIps };
}

module.exports = { runSetup };