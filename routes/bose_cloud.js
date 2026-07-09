// routes/bose_cloud.js
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const xml2js = require('xml2js');
const utils = require('./utils');

const IP = process.env.APP_IP;
const PORT = process.env.APP_PORT;
const LOG_DIR = path.resolve(process.cwd(), "config", "logs");
const identityCache = {};

// ⚠️ TEST FLAG — SET TO true TO DELIVER EMPTY PRESETS DURING CLOUD HANDSHAKE.
// SET BACK TO false BEFORE COMMITTING.
const FORCE_EMPTY_PRESETS = false;

// Use the global debug variable set by tools.html / admin.js
const isDebug = () => global.DEBUG_MODE === true;

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function getTimestamp() {
    return new Date().toISOString();
}

// Helper to wrap responses in standard Bose SOAP envelope
const sendBoseEnvelope = (res, bodyContent) => {
    const envelope = `<?xml version="1.0" encoding="UTF-8"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"><SOAP-ENV:Body>${bodyContent}</SOAP-ENV:Body></SOAP-ENV:Envelope>`;
    res.type('application/xml').send(envelope);
};

// ============================================================================
// HANDSHAKE DIAGNOSTIC TRACKER
// ============================================================================
const handshakeTracker = {};

// 10-second rolling buffer of pre-BMX endpoint hits per IP.
// Captures steps (sourceProviders, presets) that arrive before power_on/BMX
// initializes the tracker — fixes false INCOMPLETE on parallel firmware threads.
const preBmxBuffer = {};

function notePreBmxStep(ip, flag) {
    if (!preBmxBuffer[ip]) preBmxBuffer[ip] = [];
    const now = Date.now();
    preBmxBuffer[ip] = preBmxBuffer[ip].filter(e => now - e.ts < 10000);
    preBmxBuffer[ip].push({ flag, ts: now });
}

function applyPreBmxBuffer(ip) {
    if (!preBmxBuffer[ip]) return;
    const now = Date.now();
    for (const entry of preBmxBuffer[ip]) {
        if (now - entry.ts < 10000 && handshakeTracker[ip]) {
            if (!handshakeTracker[ip][entry.flag]) {
                handshakeTracker[ip][entry.flag] = true;
                handshakeTracker[ip].timestamps[entry.flag] = entry.ts - handshakeTracker[ip].initTs;
            }
        }
    }
    delete preBmxBuffer[ip];
}

function initTracker(ip) {
    if (handshakeTracker[ip]) return;
    const now = Date.now();
    const invalidSourceTs = global.PRE_BMX_SIGNAL?.[ip];
    const invalidSourceBeforeBmx = invalidSourceTs && (now - invalidSourceTs < 10000);
    if (invalidSourceBeforeBmx) delete global.PRE_BMX_SIGNAL[ip];
    handshakeTracker[ip] = {
        powerOn: false, bmx: false, sourceProviders: false, presets: false,
        invalidSourceBeforeBmx: !!invalidSourceBeforeBmx,
        initTs: now,
        timestamps: { powerOn: null, bmx: null, sourceProviders: null, presets: null }
    };
    setTimeout(() => evaluateHandshake(ip), 30000);
    utils.queryPresetsForSpeaker(ip, 'before');
    applyPreBmxBuffer(ip);
}

function buildHandshakeDiagnosis(state) {
    const { powerOn, bmx, sourceProviders, presets, invalidSourceBeforeBmx } = state;
    const invalidSourceNote = invalidSourceBeforeBmx
        ? ' Speaker reported INVALID_SOURCE before cloud contact — firmware had active but invalid streaming context (NVRAM clear pattern).'
        : '';
    if (!bmx && !sourceProviders && !presets) {
        return `Power-on signal received but BMX registry was never requested. The cloud emulator may not have been reachable at the time of power-on, or the speaker aborted before contacting it.${invalidSourceNote}`;
    }
    if (bmx && !sourceProviders && !presets) {
        return powerOn
            ? `Power-on with stalled handshake. BMX registry delivered but speaker stopped before requesting source providers or account profile.${invalidSourceNote}`
            : `BMX-only re-validation. Speaker contacted cloud for service routing but never requested source providers or account profile. Firmware likely cleared NVRAM expecting full cloud re-delivery that did not complete.${invalidSourceNote}`;
    }
    if (bmx && sourceProviders && !presets) {
        return powerOn
            ? `Partial handshake following power-on. Source providers delivered but account profile (preset injection) was not requested within the 30s window.${invalidSourceNote}`
            : `Partial re-validation. BMX and source providers delivered but account profile (preset injection) was not requested.${invalidSourceNote}`;
    }
    return `Incomplete handshake — one or more required steps did not complete within the 30s evaluation window.${invalidSourceNote}`;
}

async function evaluateHandshake(ip) {
    const state = handshakeTracker[ip];
    if (!state) return;

    const isSuccess = state.presets && state.sourceProviders && state.bmx;
    const stepLine = `PowerOn: ${state.powerOn ? '✅' : '❌'}  BMX: ${state.bmx ? '✅' : '❌'}  SourceProviders: ${state.sourceProviders ? '✅' : '❌'}  Account/Presets: ${state.presets ? '✅' : '❌'}`;

    // Build timing_ms: ms from tracker init to each step (null = never fired).
    const timing_ms = {};
    for (const key of ['powerOn', 'bmx', 'sourceProviders', 'presets']) {
        timing_ms[key] = state.timestamps[key] ?? null;
    }

    if (global.WATCHDOG_SPEAKERS?.includes(ip)) {
        utils.appendWatchdogLog(ip, {
            type:                  'handshake_result',
            success:               isSuccess,
            steps:                 { powerOn: state.powerOn, bmx: state.bmx, sourceProviders: state.sourceProviders, presets: state.presets },
            invalidSourceBeforeBmx: state.invalidSourceBeforeBmx,
            timing_ms
        });
    }

    if (isSuccess) {
        console.log(`[Bose Cloud] ✅ Cloud Handshake Complete for ${ip} — ${stepLine}`);
    } else {
        const diagnosis = buildHandshakeDiagnosis(state);
        console.log(
            `\n[Bose Cloud] ⚠️ INCOMPLETE HANDSHAKE — ${ip}\n` +
            `   ${stepLine}\n` +
            `   Diagnosis: ${diagnosis}` +
            (!state.presets ? `\n   Action: WAPI preset recovery scheduled in 30s.` : '')
        );

        if (!state.presets) {
            if (global.WATCHDOG_SPEAKERS?.includes(ip)) {
                utils.appendWatchdogLog(ip, {
                    type:     'handshake_recovery',
                    action:   'wapi_push_scheduled',
                    diagnosis,
                    delay_ms: 30000
                });
            }
            setTimeout(async () => {
                console.log(`[Bose Cloud] WAPI Preset Recovery: pushing presets to ${ip}...`);
                try {
                    await utils.pushPresetsToSpeaker(ip);
                    console.log(`[Bose Cloud] ✅ WAPI Preset Recovery complete for ${ip}.`);
                    if (global.WATCHDOG_SPEAKERS?.includes(ip)) {
                        utils.appendWatchdogLog(ip, { type: 'handshake_recovery', action: 'wapi_push_complete' });
                        await utils.queryPresetsForSpeaker(ip, 'post_recovery');
                    }
                } catch (e) {
                    console.log(`[Bose Cloud] ❌ WAPI Preset Recovery FAILED for ${ip} — ${e.message}`);
                    if (global.WATCHDOG_SPEAKERS?.includes(ip)) {
                        utils.appendWatchdogLog(ip, { type: 'handshake_recovery', action: 'wapi_push_failed', error: e.message });
                    }
                }
            }, 30000);
        }
    }

    await utils.queryPresetsForSpeaker(ip, 'after');
    delete handshakeTracker[ip];
}

// ============================================================================
// XML GENERATORS & FILE LOGGERS
// ============================================================================
async function getSpeakerIdentity(ip) {
    if (identityCache[ip]) return identityCache[ip];
	
    for (let attempt = 1; attempt <= 5; attempt++) {
        try {
            const infoRes = await axios.get(`http://${ip}:8090/info`, { timeout: 2000 });
            const parser = new xml2js.Parser({ explicitArray: false });
            const infoData = await parser.parseStringPromise(infoRes.data);
            
            if (infoData && infoData.info) {
                const deviceId = infoData.info.$.deviceID || infoData.info.deviceID || "UNKNOWN";
                const name = infoData.info.name || "Bose Speaker";
                let serialNumber = "UNKNOWN";
                
                const comps = infoData.info.components?.component;
                const compArray = Array.isArray(comps) ? comps : [comps];
                const scm = compArray.find(c => c.componentCategory === 'SCM');
                if (scm && scm.serialNumber) serialNumber = scm.serialNumber;
				
                if (deviceId !== "UNKNOWN") {
                    identityCache[ip] = { deviceId, name, serialNumber };
                }			
                return { deviceId, name, serialNumber };
            }
        } catch (e) {
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    return { deviceId: "UNKNOWN", name: "Bose Speaker", serialNumber: "UNKNOWN" };
}

function generateSourceProviders(reqIp) {
    const time = getTimestamp();
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sourceProviders>
    <sourceprovider id="11">
        <name>LOCAL_INTERNET_RADIO</name>
        <createdOn>${time}</createdOn>
        <updatedOn>${time}</updatedOn>
    </sourceprovider>
</sourceProviders>`;
    
    // WRITE TO FILE
    fs.writeFileSync(path.join(LOG_DIR, `${reqIp}_sourceproviders.xml`), xml);
    return xml;
}

// RESEARCH NOTE: /streaming/account/:id/provider_settings is a subscription/trial
// eligibility endpoint for premium services (Spotify, SiriusXM, etc.) — NOT a
// LOCAL_INTERNET_RADIO status endpoint. Two sources confirm this:
//
//   1. julius-d UberBoseOpenAPI spec (github.com/julius-d/ueberboese-api):
//      description: "Unclear. Returns empty 200 ok response for me"
//      — the real Bose cloud returned an EMPTY body, not XML.
//
//   2. soundcork (github.com/deborahgu/soundcork), marge.py line ~287:
//      comment: "this seems to report information like if you're eligible for a free trial"
//      — it returns subscription eligibility data for provider IDs like 14 (Spotify),
//      NOT provider 11 (LOCAL_INTERNET_RADIO).
//
// Returning LOCAL_INTERNET_RADIO XML here was wrong. The 3x repeat requests were likely
// the speaker polling multiple provider IDs for subscription status and getting back
// a response it didn't understand, causing retries. Empty 200 OK matches real cloud behavior.

function generatePresetsXml() {
    if (FORCE_EMPTY_PRESETS) return '<presets/>';
    const time = getTimestamp();
    // Sourced from utils.getHybridPresetDefinitions() so this cloud-delivered XML and
    // the Preset Watchdog's direct WAPI storePreset write "Hybrid Preset N" the same
    const definitions = utils.getHybridPresetDefinitions();
    let presetsXml = '<presets>';

    for (const preset of definitions) {
        presetsXml += `
        <preset buttonNumber="${preset.id}">
            <contentItemType>stationurl</contentItemType>
            <location>${preset.url}</location>
            <name>${preset.name}</name>
            <createdOn>${time}</createdOn>
            <updatedOn>${time}</updatedOn>
            <source id="1001" type="Audio">
                <credential type="token" />
                <sourceproviderid>11</sourceproviderid>
                <createdOn>${time}</createdOn>
                <updatedOn>${time}</updatedOn>
            </source>
        </preset>`;
    }
    presetsXml += '</presets>';
    return presetsXml;
}

function generateAccountXml(reqIp, accountId, deviceId, serialNumber, deviceName) {
    const time = getTimestamp();
    const updateTime = Math.floor(Date.now() / 1000);

	const presetsXml = generatePresetsXml();

    const sourcesXml = `
    <sources>
        <source id="1001" type="Audio">
            <credential type="token" />
            <sourceproviderid>11</sourceproviderid>
            <createdOn>${time}</createdOn>
            <updatedOn>${time}</updatedOn>
        </source>
    </sources>`;

    const fullXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<account id="${accountId}">
    <accountStatus>OK</accountStatus>
    <updateTimestamp>${updateTime}</updateTimestamp>
    <devices>
        <device deviceid="${deviceId}">
            <name>${deviceName}</name>
            <serialnumber>${serialNumber}</serialnumber>
            <createdOn>${time}</createdOn>
            <updatedOn>${time}</updatedOn>
            <setupState>SETUP_LANG_SET</setupState>
            ${presetsXml}
        </device>
    </devices>
    <mode>global</mode>
    ${sourcesXml}
</account>`;

    // WRITE TO FILE
    fs.writeFileSync(path.join(LOG_DIR, `${reqIp}_account.xml`), fullXml);
    return fullXml;
}

// ============================================================================
// MIDDLEWARE & ROUTING
// ============================================================================
router.use((req, res, next) => {
    if (req.url.includes('/streaming') || req.url === '/') {
        res.set('Content-Type', 'application/vnd.bose.streaming-v1.2+xml');
    }
    res.set('Etag', Date.now().toString());

    // Watchdog observe mode: log every cloud hit for monitored speakers.
    // Globals are kept in sync by updateWatchdogGlobals() (called on startup
    // and after every settings save) so this check is a pure memory read.
    if (Array.isArray(global.WATCHDOG_SPEAKERS)) {
        const reqIp = getIp(req);
        if (global.WATCHDOG_SPEAKERS.includes(reqIp)) {
            const rawBody = req.body
                ? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body))
                : undefined;
            utils.appendWatchdogLog(reqIp, {
                ts:     new Date().toISOString(),
                type:   'cloud_event',
                method: req.method,
                path:   req.url,
                ...(rawBody ? { body: rawBody } : {})
            });
        }
    }

    next();
});

const getIp = (req) => (req.ip || req.connection.remoteAddress || '').replace('::ffff:', '');

router.get('/', (req, res) => {
    res.send('<?xml version="1.0" encoding="UTF-8" ?><marge><status>success</status></marge>');
});

// 1. Power On Signal
router.post('/streaming/support/power_on', (req, res) => {
    const reqIp = getIp(req);
    if (isDebug()) console.log(`[Bose Cloud] Power On Signal Handled for ${reqIp}`);
    res.send('<status>success</status>');
    initTracker(reqIp);
    handshakeTracker[reqIp].powerOn = true;
    handshakeTracker[reqIp].timestamps.powerOn = Date.now() - handshakeTracker[reqIp].initTs;
});

// 2. BMX Registry (Cloud Routing)
router.get('/bmx/registry/v1/services', (req, res) => {
    const reqIp = getIp(req);
    initTracker(reqIp);
    handshakeTracker[reqIp].bmx = true;
    handshakeTracker[reqIp].timestamps.bmx = Date.now() - handshakeTracker[reqIp].initTs;
    if (isDebug()) console.log(`[Bose Cloud] Delivered BMX Registry to ${reqIp}`);
    res.set('Content-Type', 'application/json');
    
    // askAgainAfter: how long (ms) the speaker waits before re-checking BMX services.
    // Real Bose cloud used 1230482 (~20.5 min) per julius-d's UberBoseOpenAPI capture.
    // Set to 7 days (604800000) to minimize mid-standby re-validation events that wipe presets.
    // Nightly preset audit is safety net for any preset loss that still occurs.
    const registryData = {
        "_links": { "bmx_services_availability": { "href": "../servicesAvailability" } },
        "askAgainAfter": 604800000,
        "bmx_services": [
            {
                "id": { "name": "LOCAL_INTERNET_RADIO", "value": 11 },
                "baseUrl": `http://${IP}:${PORT}/radio`,
                "_links": { "bmx_token": { "href": "/token" }, "self": { "href": "/" } },
                "askAdapter": false,
                "authenticationModel": { "anonymousAccount": { "autoCreate": true, "enabled": true } },
                "streamTypes": ["liveRadio"],
                "assets": { "name": "Hybrid Radio" }
            }
        ]
    };
    
    // WRITE TO FILE
    fs.writeFileSync(path.join(LOG_DIR, `${reqIp}_bmx_registry.json`), JSON.stringify(registryData, null, 2));
    res.json(registryData);
});

// 3. Source Providers (Internet Radio Local Bypass)
router.get('/streaming/sourceproviders', (req, res) => {
    const reqIp = getIp(req);
	// TESTING ONLY: Allow browser to spoof the speaker's IP using ?ip=
    //const reqIp = req.query.ip || getIp(req);
    notePreBmxStep(reqIp, 'sourceProviders');
    if (handshakeTracker[reqIp] && !handshakeTracker[reqIp].sourceProviders) {
        handshakeTracker[reqIp].sourceProviders = true;
        handshakeTracker[reqIp].timestamps.sourceProviders = Date.now() - handshakeTracker[reqIp].initTs;
    }
    console.log(`[Bose Cloud] Delivered SourceProviders to ${reqIp}`);
    res.send(generateSourceProviders(reqIp));
});

// 4. Full Account Profile (The Preset Injector)
router.get('/streaming/account/:id/full', async (req, res) => {
    const reqIp = getIp(req);
	// TESTING ONLY: Allow browser to spoof the speaker's IP using ?ip=
    //const reqIp = req.query.ip || getIp(req);
    const accountId = req.params.id;
    
    console.log(`[Bose Cloud] Account Profile requested by ${reqIp}. Fetching identity...`);

    const identity = await getSpeakerIdentity(reqIp);
    if (identity.deviceId === "UNKNOWN") {
        console.log(`[Bose Cloud] ⚠️ Account Profile FAILED for ${reqIp} — speaker identity unresolvable (port 8090 not ready). Returned 503. Presets NOT delivered.`);
        if (global.WATCHDOG_SPEAKERS?.includes(reqIp)) {
            utils.appendWatchdogLog(reqIp, { ts: new Date().toISOString(), type: 'account_profile_failed', reason: 'speaker identity unresolvable (port 8090 not ready)' });
        }
        return res.status(503).send("Speaker Busy");
    }

    notePreBmxStep(reqIp, 'presets');
    if (handshakeTracker[reqIp] && !handshakeTracker[reqIp].presets) {
        handshakeTracker[reqIp].presets = true;
        handshakeTracker[reqIp].timestamps.presets = Date.now() - handshakeTracker[reqIp].initTs;
    }
    res.send(generateAccountXml(reqIp, accountId, identity.deviceId, identity.serialNumber, identity.name));
});

router.get('/streaming/account/:id/device/:deviceId/presets', (req, res) => {
    const reqIp = getIp(req);
	// TESTING ONLY: Allow browser to spoof the speaker's IP using ?ip=
    //const reqIp = req.query.ip || getIp(req);
    console.log(`[Bose Cloud] Standby Preset Sync requested by ${reqIp}. Delivering Hybrid Presets...`);
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${generatePresetsXml()}`);
});

router.get('/streaming/account/:id/provider_settings', (req, res) => {
    const reqIp = getIp(req);
    console.log(`[Bose Cloud] Provider Settings requested by ${reqIp}. Return 200 matching real Bose cloud UberBose/SoundCork Findings).`);
    res.set('Content-Type', 'application/vnd.bose.streaming-v1.2+xml');
    res.status(200).send('');
});

// ============================================================================
// ST10 STEREO PAIRING GROUP HIJACK
// ============================================================================
const stereoPairsFile = path.join(process.cwd(), 'config', 'stereo_pairs.json');

router.get('/streaming/account/:id/device/:deviceId/group/', async (req, res) => {
    const reqIp = getIp(req);
//	const reqIp = req.query.ip || getIp(req); //TESTING ONLY REMOVE BEFORE PROD

    if (fs.existsSync(stereoPairsFile)) {
        const pairs = JSON.parse(fs.readFileSync(stereoPairsFile, 'utf8'));
        const activePair = pairs.find(p => p.leftIp === reqIp || p.rightIp === reqIp);

        if (activePair) {
            console.log(`[Bose Cloud] 👯 ST10 Stereo Sync requested by ${reqIp}. Compiling GroupService.xml for: ${activePair.name}`);

            const leftIdentity = await getSpeakerIdentity(activePair.leftIp);
            const rightIdentity = await getSpeakerIdentity(activePair.rightIp);

            const groupXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<group id="${activePair.id}">
    <masterDeviceId>${leftIdentity.deviceId}</masterDeviceId>
    <name>${activePair.name}</name>
    <roles>
        <groupRole>
            <deviceId>${leftIdentity.deviceId}</deviceId>
            <role>LEFT</role>
        </groupRole>
        <groupRole>
            <deviceId>${rightIdentity.deviceId}</deviceId>
            <role>RIGHT</role>
        </groupRole>
    </roles>
</group>`;
            
            return res.type('application/xml').send(groupXml);
        }
    }

    res.type('application/xml').send('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><group/>');
});



// ============================================================================
// NOISY BOSE TELEMETRY TRAPS (Silently dropped)
// ============================================================================

// Express 5 Native RegExp Catch-Alls
router.post(/^\/events.*/, (req, res) => res.status(200).send("OK"));
router.post(/^\/v1\/scmudc.*/, (req, res) => {
    //console.log(`[scmudc] 📡 Telemetry from ${getIp(req)}: ${JSON.stringify(req.body)}`);
	// This is all you get so nothing actionable to use here  WS Raw [192.168.4.48]: <userActivityUpdate deviceID="9884E384F8B2" />
    res.status(200).send();
});
router.get(/^\/updates.*/, (req, res) => res.status(404).send("Not Found"));

// Standard Express 5 Parameter Routes
router.delete('/streaming/account/:id/device/:deviceId', (req, res) => res.send('<?xml version="1.0" encoding="UTF-8" ?><status>success</status>'));
router.post(['/streaming/account/:id/device', '/streaming/account/:id/device/'], (req, res) => res.status(201).send('<?xml version="1.0" encoding="UTF-8" ?><status>success</status>'));
router.put('/streaming/account/:id/device/:deviceId', (req, res) => res.send('<?xml version="1.0" encoding="UTF-8" ?><status>success</status>'));
router.get('/streaming/software/update/account/:id', (req, res) => res.send('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><software_update><softwareUpdateLocation></softwareUpdateLocation></software_update>'));
router.get('/streaming/device/:id/streaming_token', (req, res) => res.status(404).send('Not Found'));
router.use('/radio', (req, res) => res.status(200).send("OK"));

module.exports = router;