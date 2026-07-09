// --- GITHUB UPDATE BANNER HTML ---
const updateBannerHTML = `
<div id="github-update-banner" class="banner banner-update">
    🚀 <strong>Update Available!</strong> Version <span id="update-version-text"></span> is out.
    <a id="update-link" class="banner-link" href="#" target="_blank">View Release Notes & Update</a>
    <button id="update-dismiss-btn" class="banner-button">Dismiss</button>
</div>
`;

// dismiss for the current session
window.dismissUpdateBanner = function(versionToDismiss) {
    document.getElementById('github-update-banner').style.display = 'none';
    // Save to sessionStorage wipes when closed.
    sessionStorage.setItem('dismissedUpdateVersion', versionToDismiss);
};

// Function to ping the backend and check for updates
async function checkForUpdates() {
    try {
        const res = await fetch(`/api/check_update?t=${Date.now()}`, { cache: 'no-store' });
        const data = await res.json();
        
        if (data.updateAvailable) {
            // Check the SESSION memory to see if we dismissed it during this active use
            const skippedVersion = sessionStorage.getItem('dismissedUpdateVersion');
            
            if (skippedVersion !== data.latest) {
                const banner = document.getElementById('github-update-banner');
                document.getElementById('update-version-text').innerText = data.latest;
                document.getElementById('update-link').href = data.url;
                
                document.getElementById('update-dismiss-btn').onclick = () => dismissUpdateBanner(data.latest);
                
                banner.style.display = 'block';
            }
        }
    } catch (e) {
        console.error("Failed to check for updates:", e);
    }
}

// --- UNIFIED MASS HEALTH MODAL HTML ---
const maHealthBannerHTML = `
<div id="mass-error-banner">
    <div class="banner-header">
        <span class="banner-title">🚨 Music Assistant Error</span>
        <button class="banner-close" onclick="dismissHealthModal()">&times;</button>
    </div>
    <div class="banner-body">
        Music Assistant reported a playback failure. How to fix it:
        <ul>
            <li>
                <strong>Invalid Media (Empty album, dead stream):</strong><br>
                No restart needed. <strong>Dismiss</strong> this message. It will clear on next successful playback.
            </li>
            <li>
                <strong>Dropped DLNA/AirPlay Socket:</strong><br>
                The speaker connection dropped. Try a quick <strong>Reload MA DLNA & AirPlay Providers</strong> first.
            </li>
            <li>
                <strong>Server Locked Up:</strong><br>
                If reconnecting fails, you must do a full <strong>Restart Service</strong>.
            </li>
        </ul>
    </div>
    <div class="banner-actions">
        <button class="btn-dismiss banner-button banner-button--success" onclick="dismissHealthModal()">✅ Dismiss</button>
        <button class="btn-reconnect banner-button" onclick="executeGlobalRecovery(this)">🔄 Reload MA DLNA & AirPlay Providers</button>
        <button class="btn-restart banner-button" onclick="executeGlobalRestart(this)">Restart Service</button>
    </div>
</div>
`;

// --- UNIFIED RECOVERY LOGIC ---
async function executeGlobalRecovery(btn) {
    const orig = btn.innerText;
    btn.innerText = "Reloading...";
    btn.disabled = true;

    try {
        // Reload MA DLNA provider
        await fetch('api/admin/rescan_ma', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ aggressive: true, provider: 'dlna' })
        });
        
        // Reload MA AirPlay provider
        await fetch('api/admin/rescan_ma', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ aggressive: true, provider: 'airplay' })
        });

        await fetch('api/health/reset', { method: 'POST' }); 
        btn.innerText = "✅ Sent";
        setTimeout(() => { dismissHealthModal(); }, 1500);

    } catch (e) {
        btn.innerText = "❌ Error";
        setTimeout(() => { btn.innerText = orig; btn.disabled = false; }, 3000);
    }
}

// Global hook to restart the docker container
async function executeGlobalRestart(btn) {
    if (!confirm("Are you sure you want to completely restart the Music Assistant container?")) return;
    const orig = btn.innerText;
    btn.innerText = "Restarting...";
    btn.disabled = true;
    window.isMaRestartingProcess = true; // Lock the UI loops

    try {
        await fetch('api/admin/restart_ma', { method: 'POST' });
        await fetch('api/health/reset', { method: 'POST' }); 
        
        btn.innerText = "✅ Sent";
        setTimeout(() => { 
            dismissHealthModal(); 
            window.isMaRestartingProcess = false; // Unlock after command clears
        }, 1500);
    } catch (e) {
        btn.innerText = "❌ Error";
        setTimeout(() => { 
            btn.innerText = orig; 
            btn.disabled = false; 
            window.isMaRestartingProcess = false; 
        }, 3000);
    }
}

function dismissHealthModal() {
    const banner = document.getElementById('mass-error-banner');
    if (banner) {
        banner.style.display = 'none';
        banner.dataset.dismissed = "true";
        banner.style.transform = ''; banner.style.left = ''; banner.style.top = '';
    }
    
    // Tell the backend we are ignoring the error so it stops bugging us
    fetch('api/health/reset', { method: 'POST' }).catch(() => console.log("Health reset suppressed")); 
}

// Inject the banner HTML into the DOM as soon as the page loads
document.addEventListener("DOMContentLoaded", () => {
    // BUG FIX: Changed from boseMassBannerHTML to the correct maHealthBannerHTML
    document.body.insertAdjacentHTML('afterbegin', maHealthBannerHTML); 
    document.body.insertAdjacentHTML('afterbegin', updateBannerHTML);
    makeBannerDraggable();
    checkForUpdates();
});

window.isMaRestartingProcess = false;

// --- MUSIC ASSISTANT HEALTH MONITOR (Runs every 5 seconds) ---
// This loop constantly checks if the Music Assistant backend is healthy.
setInterval(async () => {
    // STEP 1: Safety Check
    // If a restart or reconnect process is ALREADY happening, skip this check.
    if (window.isMaRestartingProcess) return;
    
    try {
        // STEP 2: Ping the Health Endpoint
        // append a timestamp (?t=...) to prevent the browser from caching an old response.
        const res = await fetch(`/api/health?t=${Date.now()}`, { cache: 'no-store' });
        const h = await res.json();
        const banner = document.getElementById('mass-error-banner');
        
        // STEP 3: Handle Unhealthy State (Connection Lost)
        if (h && h.healthy === false) {
            
            // Because the backend gatekeeper now intercepts auto-restarts silently,
            // if this returns false, it means the user WANTS to see the manual banner!
            if (banner && banner.style.display !== 'flex' && !banner.dataset.dismissed) {
                banner.style.display = 'flex';
            }
            
        } else {
            // STEP 4: Handle Healthy State (Recovery Successful)
            if (banner) {
                banner.style.display = 'none';
                banner.dataset.dismissed = ""; // Reset for next time
            }
        }
    } catch(e) {
        // Catch network errors silently to prevent console spam if the server goes completely offline.
    }
}, 5000);

function makeBannerDraggable() {
    const banner = document.getElementById('mass-error-banner');
    if (!banner) return;
    const header = banner.querySelector('.banner-header');
    if (!header) return;

    header.style.cursor = 'grab';
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;

    header.onmousedown = dragMouseDown; header.ontouchstart = dragTouchStart;

    function prepareDrag() {
        if (banner.style.transform !== 'none') {
            const rect = banner.getBoundingClientRect();
            banner.style.transform = 'none';
            banner.style.left = rect.left + 'px'; banner.style.top = rect.top + 'px'; banner.style.margin = '0'; 
        }
        header.style.cursor = 'grabbing';
    }

    function dragMouseDown(e) { e.preventDefault(); pos3 = e.clientX; pos4 = e.clientY; document.onmouseup = closeDragElement; document.onmousemove = elementDrag; prepareDrag(); }
    function dragTouchStart(e) { const touch = e.touches[0]; pos3 = touch.clientX; pos4 = touch.clientY; document.ontouchend = closeDragElement; document.ontouchmove = elementTouchDrag; prepareDrag(); }
    function elementDrag(e) { e.preventDefault(); pos1 = pos3 - e.clientX; pos2 = pos4 - e.clientY; pos3 = e.clientX; pos4 = e.clientY; banner.style.top = (banner.offsetTop - pos2) + "px"; banner.style.left = (banner.offsetLeft - pos1) + "px"; }
    function elementTouchDrag(e) { const touch = e.touches[0]; pos1 = pos3 - touch.clientX; pos2 = pos4 - touch.clientY; pos3 = touch.clientX; pos4 = touch.clientY; banner.style.top = (banner.offsetTop - pos2) + "px"; banner.style.left = (banner.offsetLeft - pos1) + "px"; }
    function closeDragElement() { document.onmouseup = null; document.onmousemove = null; document.ontouchend = null; document.ontouchmove = null; header.style.cursor = 'grab'; }
}


// --- GLOBAL SYSTEM ACTIONS ---
window.triggerGlobalAllOff = async function() {
    if(!confirm("Turn off ALL speakers?")) return;

    const btns = document.querySelectorAll('.btn-all-off');
    btns.forEach(b => b.style.opacity = '0.5');

    try {
        // 1. Fetch current states to know who is currently ON
        const res = await fetch('api/status');
        const devices = await res.json();

        // 2. OPTIMISTIC UI (Adapts to current page)
        // -> If user is on control.html
        if (typeof window.isPollingFrozen !== 'undefined') {
            window.isPollingFrozen = true;
        }
        if (window.LockManager && window.currentDevices) {
            window.currentDevices.forEach(d => {
                if (!d.isStandby) window.LockManager.set(d.ip, 'POWER', 'OFF');
            });
        }
        // -> If user is on admin.html
        devices.forEach(d => {
            const pwrBtn = document.getElementById(`pwr-${d.ip}`);
            const modeBadge = document.getElementById(`mode-${d.ip}`);
            if (pwrBtn && !d.isStandby) {
                pwrBtn.className = 'pwr-off'; 
                pwrBtn.innerText = 'OFF';
                if (modeBadge) modeBadge.innerText = '(STANDBY)';
            }
        });

        // 3. FILTER: Command only Masters and Standalone speakers
        const onDevices = devices.filter(d => {
            const isSlave = (d.zone && d.zone.master && d.zone.master !== d.mac);
            return !d.isStandby && !isSlave;
        });

        // 4. Send individual POWER keys
        for (const d of onDevices) {
            await fetch('api/key', { 
                method: 'POST', 
                headers: {'Content-Type': 'application/json'}, 
                body: JSON.stringify({ ip: d.ip, key: 'POWER' }) 
            });
        }

        // Wait 1.5s for hardware to process (Matches the individual toggle delay)
        await new Promise(r => setTimeout(r, 1500));

        // 5. Unfreeze and Quietly Refresh specific elements
        if (typeof window.isPollingFrozen !== 'undefined') {
            window.isPollingFrozen = false;
        }

        // Quietly fetch individual states instead of nuking the grid with loadAdmin()
        if (typeof window.fetchDeviceState === 'function') {
            devices.forEach(d => window.fetchDeviceState(d.ip));
        } else if (typeof window.loadStatus === 'function') {
            window.loadStatus();
        }
    } catch (e) {
        console.error("Failed to power off speakers", e);
    } finally {
        btns.forEach(b => b.style.opacity = '1');
    }
};

