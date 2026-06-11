// routes/bose_cloud.js
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const xml2js = require('xml2js');

const IP = process.env.APP_IP;
const PORT = process.env.APP_PORT;
const LOG_DIR = path.resolve(process.cwd(), "config", "logs");
const identityCache = {};

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

async function evaluateHandshake(ip) {
    const state = handshakeTracker[ip];
    if (!state) return;

    // Evaluate success condition once to keep the code below clean and readable
    const isSuccess = state.presets && state.sourceProviders && state.bmx;

    if (isDebug()) {
        console.log(`\n=======================================================================`);
        console.log(`[Bose Cloud] HANDSHAKE DIAGNOSTIC REPORT FOR ${ip}`);
        console.log(`=======================================================================`);
        console.log(` 1. Power On Event Received:   ${state.powerOn ? '✅ YES' : '❌ NO'}`);
        console.log(` 2. BMX Registry Requested:    ${state.bmx ? '✅ YES' : '❌ NO'}`);
        console.log(` 3. Marge Source Prov. Req.:   ${state.sourceProviders ? '✅ YES' : '❌ NO'}`);
        console.log(` 4. Marge Presets (Profile):   ${state.presets ? '✅ YES' : '❌ NO'}`);
        console.log(`-----------------------------------------------------------------------`);

        if (isSuccess) {
            console.log(`[Bose Cloud] 🎉 STATUS: Good. Cloud Routing fully working.`);
        } else {
            console.log(`[Bose Cloud] ⚠️ STATUS: INCOMPLETE HANDSHAKE. Check network stability.`);
        }
        console.log(`=======================================================================\n`);
        
	} else {
        // Standard (Non-Debug) Logging
        if (isSuccess) {
            console.log(`[Bose Cloud] ✅ Cloud Handshake Sequence Complete for ${ip}`);
        } else {
            console.log(`[Bose Cloud] ⚠️ NOTE: Handshake unconfirmed for ${ip} (possible network/timing delay). If presets fail, enable Debug Mode.`);
        }
    }
    
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

function generateProviderSettingsXml(reqIp) {
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<providerSettings>
    <provider id="11">
        <name>LOCAL_INTERNET_RADIO</name>
        <status>READY</status>
    </provider>
</providerSettings>`;
    
    // WRITE TO FILE
    fs.writeFileSync(path.join(LOG_DIR, `${reqIp}_provider_settings.xml`), xml);
    return xml;
}

function generatePresetsXml() {
    const time = getTimestamp();
    let presetsXml = '<presets>';
    
    for (let i = 1; i <= 6; i++) {
        const streamUrl = `http://${IP}:${PORT}/preset/${i}.mp3`;
        presetsXml += `
        <preset buttonNumber="${i}">
            <contentItemType>stationurl</contentItemType>
            <location>${streamUrl}</location>
            <name>Hybrid Preset ${i}</name>
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
    next();
});

const getIp = (req) => (req.ip || req.connection.remoteAddress || '').replace('::ffff:', '');

router.get('/', (req, res) => {
    res.send('<?xml version="1.0" encoding="UTF-8" ?><marge><status>success</status></marge>');
});

// 1. Power On Signal
router.post('/streaming/support/power_on', (req, res) => {
    const reqIp = getIp(req);
    if (isDebug()) console.log(`[Bose Cloud] ⚡ Power On Signal Handled for ${reqIp}`);
    res.send('<status>success</status>'); 
	
	// FIX: Only initialize the tracker if one doesn't already exist.
    // This prevents late power_on pings from erasing a successful handshake!
    if (!handshakeTracker[reqIp]) {
        handshakeTracker[reqIp] = { powerOn: true, bmx: false, sourceProviders: false, presets: false };
        
        // Give slow speakers 30 seconds to fully boot and pull XMLs instead of 15
        setTimeout(() => evaluateHandshake(reqIp), 30000);
    }
});

// 2. BMX Registry (Cloud Routing)
router.get('/bmx/registry/v1/services', (req, res) => {
    const reqIp = getIp(req);
    if (handshakeTracker[reqIp]) handshakeTracker[reqIp].bmx = true;
    if (isDebug()) console.log(`[Bose Cloud] ☁️ Delivered BMX Registry to ${reqIp}`);
    res.set('Content-Type', 'application/json');
    
    const registryData = {
        "_links": { "bmx_services_availability": { "href": "../servicesAvailability" } },
        "askAgainAfter": 1230482,
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
    if (handshakeTracker[reqIp]) handshakeTracker[reqIp].sourceProviders = true;
    console.log(`[Bose Cloud] 📋 Delivered SourceProviders to ${reqIp}`);
    res.send(generateSourceProviders(reqIp));
});

// 4. Full Account Profile (The Preset Injector)
router.get('/streaming/account/:id/full', async (req, res) => {
    const reqIp = getIp(req);
	// TESTING ONLY: Allow browser to spoof the speaker's IP using ?ip=
    //const reqIp = req.query.ip || getIp(req);
    const accountId = req.params.id;
    
    if (handshakeTracker[reqIp]) handshakeTracker[reqIp].presets = true;
    console.log(`[Bose Cloud] 📥 Account Profile requested by ${reqIp}. Fetching identity...`);
    
    const identity = await getSpeakerIdentity(reqIp);
    if (identity.deviceId === "UNKNOWN") {
        return res.status(503).send("Speaker Busy");
    }

    res.send(generateAccountXml(reqIp, accountId, identity.deviceId, identity.serialNumber, identity.name)); 
});

router.get('/streaming/account/:id/device/:deviceId/presets', (req, res) => {
    const reqIp = getIp(req);
	// TESTING ONLY: Allow browser to spoof the speaker's IP using ?ip=
    //const reqIp = req.query.ip || getIp(req);
    console.log(`[Bose Cloud] 🔄 Standby Preset Sync requested by ${reqIp}. Delivering Hybrid Presets...`);
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${generatePresetsXml()}`);
});

router.get('/streaming/account/:id/provider_settings', (req, res) => {
    const reqIp = getIp(req);
	// TESTING ONLY: Allow browser to spoof the speaker's IP using ?ip=
    //const reqIp = req.query.ip || getIp(req);
    console.log(`[Bose Cloud] ⚙️ Provider Settings requested by ${reqIp}. Delivering valid settings...`);
    res.send(generateProviderSettingsXml(reqIp));
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

// Express 5 Native RegExp Catch-Alls (No quotes!)
router.post(/^\/events.*/, (req, res) => res.status(200).send("OK"));
router.post(/^\/v1\/scmudc.*/, (req, res) => res.status(200).send());
router.get(/^\/updates.*/, (req, res) => res.status(404).send("Not Found"));

// Standard Express 5 Parameter Routes
router.delete('/streaming/account/:id/device/:deviceId', (req, res) => res.send('<?xml version="1.0" encoding="UTF-8" ?><status>success</status>'));
router.post(['/streaming/account/:id/device', '/streaming/account/:id/device/'], (req, res) => res.status(201).send('<?xml version="1.0" encoding="UTF-8" ?><status>success</status>'));
router.put('/streaming/account/:id/device/:deviceId', (req, res) => res.send('<?xml version="1.0" encoding="UTF-8" ?><status>success</status>'));
router.get('/streaming/software/update/account/:id', (req, res) => res.send('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><software_update><softwareUpdateLocation></softwareUpdateLocation></software_update>'));
router.get('/streaming/device/:id/streaming_token', (req, res) => res.status(404).send('Not Found'));
router.use('/radio', (req, res) => res.status(200).send("OK"));

module.exports = router;