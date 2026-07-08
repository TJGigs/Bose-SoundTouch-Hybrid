# <img src="public/images/hybrid_icon.png" width="30"> Bose SoundTouch Hybrid 2026 v4.0

**A free, open-source private cloud streaming service replacing the Bose Cloud Service to maintain 100% of the smart speaker functionality of your SoundTouch 10, 20, 30, Wave Speakers and Wireless Link. Physical Presets Included!**

<img src="public/images/bose_icon.png" width="20">  The Bose shut down of their SoundTouch Cloud Service (May 2026) degraded the Bose SoundTouch intelligent, multi-room audio speakers into "dumb" receivers dependent on a phone's active connection. This represents a **significant loss of functionality** for the SoundTouch 10, 20, and 30 Speakers and Wireless Link Adapter. 

<img src="public/images/hybrid_icon.png" width="20">  **This solution provides a self-hosted "Private Cloud" to emulate and replace the Bose Cloud Service**. It runs locally on your network (NAS, PC, etc.) and intercepts and actively manages the complex server handshakes required to keep the SoundTouch Speakers authenticated and functional, providing the **same phone-free audio streaming capabilities** as the original SoundTouch Application and Speakers. 

### ✨ V4 Enhancements:

* ✅ **Custom URL Streaming Library Integration:** Moved the "play custom URL stream" function to the Library Manager and added the ability to assign custom streams directly to favorites and physical speaker presets.

* ✅ **Advanced Global and Favorites Search:** Expanded the search functionality with additional filters, including the ability to perform provider-specific searches.

* ✅ **Auto-Resume Presets:** Speakers now remember if a preset was active when powered off and will automatically resume that specific preset upon the next power-on.

* ✅ **In-App Update Notifications:** Automatically checks for new releases and displays a notification banner within the UI when a new version is available.

* ✅ **Live Console Logging:** Integrated a real-time server log viewer directly into the System Tools page.

* ✅ **Streamlined GHCR Deployment:** Transitioned from manual repository cloning to a pre-built GitHub Container Registry image. The system now automatically generates required configuration templates on first boot and performs startup configuration and version validation checks.

* ✅ **Improved State Synchronization:** Completely replaced backend REST API polling with a more efficient, stable, and event-driven WebSocket architecture for improved speaker state and audio stream tracking.

* ✅ **Music Assistant Native DLNA Metadata:** Takes advantage of Music Assistant's improved DLNA streaming by reading track metadata directly from the audio stream. The original API-based fetch has been streamlined into a lightweight "Watchdog" function that executes as a fallback only when needed. *(MASS v2.8.5 or later required)*

* ✅ **Music Assistant Smart Startup & Version Checks:** On boot, the app now verifies the Music Assistant version and automatically launches the container if it detects it isn't running.  *(MASS v2.8.5 or later required)*


### ✨ Application Key Features:
* **100% Local Control:** Your data and control logic stay on your LAN. No reliance on external Bose servers.
* **Complete App Replacement:** A single, responsive web interface for **Desktop** and **Mobile** that handles both streaming and speaker maintenance, completely eliminating the need for the legacy SoundTouch app or provider-specific streaming apps. Includes support for initial speaker setup, factory resets, WiFi provisioning, and the one-time automated injection of a speaker's internal cloud emulation configuration (`OverrideSdkPrivateCfg.xml`).

* **Hardware Intelligence Preserved:** 
  * ✅ **Local Bose Cloud Emulation:** Local replacement emulating  the required Bose Cloud handshakes to keeping the speakers authenticated and fully functional.
  * ✅ **The Physical 1-6 Preset Buttons:** Remain assignable to any source via the Hybrid Bridge and work instantly.
  * ✅ **Volume, Power, & Presets:** Physical speaker buttons remain fully functional and sync perfectly with the new Hybrid app.
  * ✅ **Native Hardware Grouping:** Utilizes Bose's near-zero-latency Master/Slave hardware grouping instead of software-level sync. This guarantees perfect multi-speaker audio regardless of whether you are streaming from a new Hybrid cloud source or a local input.
* **Expanded Music Universe:** Bridges your speakers to modern sources powered by Music Assistant (MASS v2.8.5 or later requried) <img src="public/images/ma_icon.png" width="15">
  * Spotify, Apple Music, YouTube Music
  * Local NAS Files, Plex, Jellyfin
  * Internet Radio (TuneIn, DI.fm)
  * Others from MASS
  * Global Agnostic Search within SoundTouch Hybrid Library of all your MASS sources

## 🛠 Architecture
* **Backend:** Custom Node.js/server acting as the "Audio Engine" (Music Assistant <img src="public/images/ma_icon.png" width="15"> ) and local Bose Cloud Emulation ☁️.
* **Frontend:** Responsive Web App deployable to any browser.
* **Connectivity:** Direct IP control over Bose WebSockets & XML API. 
<img src="public/docs/ArchitectureIntro.png" alt="SoundTouch Hybrid Architecture Diagram" width="700">

### ☁️ BOSE CLOUD EMULATION AND HYBRID FEATURES:

### Authentication & Provisioning
* Full BMX Registry and MargeID handshakes
* Dynamic account profile generation
* Source Providers Authorization (e.g., `11`, `LOCAL_INTERNET_RADIO`)
* Automated injection of Hybrid Preset Physical Buttons (1-6)
* Automated Cloud Redirect Setup (points speakers to local server)

### Device Rescue (NVRAM Auto-Healer)
* Factory-reset speaker detection and setup
* Gabbo System Bus (Port `8080`) websocket backdoor access
* Automated UI setup bypass (Language → Name → Account Binding → Seal)
* Permanent NVRAM persistence flag generation (`<setupState state="SETUP_LEAVE" />`)

### System Traps & Speaker Protection
* Dummy radio base URL generation (streaming check bypass)
* DRM streaming token mocks
* Boot-loop prevention (Account deletion trap)
* Telemetry and analytics blocking
* Firmware update bypass 
* Factory reset request spoofing (Fake `201 Created`)
* Device rename and profile sync spoofing

### Server Stability & Caching
* Real-time speaker identity fetching (MAC, Serial, Name)
* Local identity caching to handle heavy network traffic
* Failsafe request dropping (protects busy speakers from accidental preset wipes)

## 📺 <img src="public/images/hybrid_icon.png" width="20"> Demo Videos
<a href="https://youtu.be/R6mbTRBEBYA" target="_blank">
  <img src="https://img.youtube.com/vi/R6mbTRBEBYA/maxresdefault.jpg" alt="Bose SoundTouch Hybrid 2026 Initial Demo Video" width="300">
</a>
<a href="https://youtu.be/3BhAkpsZjBI" target="_blank">
  <img src="https://img.youtube.com/vi/3BhAkpsZjBI/maxresdefault.jpg" alt="Bose SoundTouch Hybrid 2026 V2 Enhancements Demo Video" width="300">
</a>
<a href="https://youtu.be/ERsoMmyOpEU" target="_blank">
  <img src="https://img.youtube.com/vi/ERsoMmyOpEU/maxresdefault.jpg" alt="Bose SoundTouch Hybrid 2026 V3 Enhancements Demo Video" width="300">
</a>



---

## Installations

### <img src="public/images/ma_icon.png" width="18"> Setting up Music Assistant (MASS)

***You must verify your SoundTouch speakers and streaming providers are fully working inside of Music Assistant before installing SoundTouch Hybrid.***

Install Music Assistant (MASS): ***version 2.9.5 or later is required***

1. **For installation instructions and troubleshooting, use Music Assistant Help** — setup, providers, speaker testing, playback issues, etc.
   * See [MASS GitHub](https://github.com/music-assistant/server) and [MASS Website](https://www.music-assistant.io/installation)
   * If you're running MASS as its own standalone Docker container (not the Home Assistant add-on), `mass_docker.yml` and `mass_package.json` in the `examples` folder are provided as a reference for my configuration. Your setup may differ.

2. **Initial Setup:** Once MASS is installed, go to its web interface and create your login. Bose SoundTouch Hybrid supports either way of authenticating to MASS:
   * **Username / Password:** your MASS login.
   * **Auth Token:** a long-lived access token generated from MASS's own Settings page

3. **Add/Configure Player Providers:** Add the DLNA provider. If desired also add AirPlay provider.
   * **DLNA is the recommended "Preferred Output Protocol"** for SoundTouch Hybrid, based on experience with greater stability and responsiveness:
      - It's the original protocol built into the SoundTouch speakers' internal OS; AirPlay was added later as a software add-on.
      - SoundTouch Hybrid's self-healing, latency management, and state sync logic are all optimized for DLNA.
      - The physical remote-control cabability and hijacks are more functional using DLNA including next/prev track and a more responsive pause/play.
   * **AirPlay** is supported. It does provide continuous live track-title updates on the speaker's LED display where as Music Assistant's DLNA stream currently only updates the speakers's LED display for the first track of a multi-track stream.

4. **Add/Configure Music Sources:** Add your streaming providers (Spotify, TuneIn, local NAS, etc). Uncheck any options to sync/import/cache the source into the local Music Assistant database. This ensures your your providers are live rather than copied to a local cache 

5. **Configure Players (Speakers):** For each SoundTouch speaker Music Assistant discovers, set its **"Preferred Output Protocol"** to **DLNA** (recommended) or AirPlay. Change it from the **Auto-Select** default.
   * SoundTouch Hybrid enforces Preferred Output Protocal specific requried settings on startup and can also be triggered manaully on the Tools page. 
   * SoundTouch Hybrid uses Music Assistant only as the backend streaming engine. Once it's set up, there's no need to go back into its UI. MASS features like speaker grouping, automations, and favorites aren't used by SoundTouch Hybrid; leave them disabled.

6. **Very Important:** Confirm Music Assistant itself can play audio to every speaker and from every provider, and that you actually hear it on each speaker. Do this completely independent of Bose SoundTouch Hybrid. If Music Assistant can't reach a speaker, SoundTouch Hybrid can't either.

---

### <img src="public/images/hybrid_icon.png" width="18"> Installing SoundTouch Hybrid

### Common to All Install Methods

* **Redirect to Local Cloud:** Happens automatically on first boot — no USB stick, no manual firmware injection. Confirmed in the console/Pre-Flight log.
* **Speaker Discovery:** Runs automatically on first boot and re-syncs on every subsequent boot — you never manually look up, enter, or edit a speaker list. Discovery scans the same subnet as your Music Assistant server, so your SoundTouch speakers need to be on that same subnet to be found.
* *A static IP address for each speaker is recommended, however, dynamic speaker IP addresses are supported.*

### Standalone Docker (NAS / PC)

1. **Create Directory & Download the Compose File:** Create a folder named `bose-soundtouch-hybrid` on your NAS or server. Download `bose-soundtouch-hybrid.yml` from this repository into it.

2. **Configure the Volume Path & Timezone:** Open `bose-soundtouch-hybrid.yml` and edit the followings:
   * **Volume path** Use the mount method that matches how you're deploying:
     - **Method A — Plain Docker Compose / CLI (default, already active):** `- ./:/app/config` mounts the same folder the compose file lives in. No changes needed if you run `docker compose` from that folder.
     - **Method B — NAS GUI (QNAP Container Station, Synology, Portainer, etc.):** these interfaces don't know where you saved the file on disk. Comment out Method A's line (add a `#` in front of it), then uncomment the Method B line and replace `/your/actual/absolute/path/here` with the real absolute path to your `bose-soundtouch-hybrid` folder on the NAS. Only one method can be active at a time.
   * **Timezone** — under `environment:`, change `TZ=America/Los_Angeles` to your own timezone. Find your exact format at [nodatime.org/TimeZones](https://nodatime.org/TimeZones).

3. **Initial Deploy:** Launch the container to generate your configuration files.
   * NAS/GUI: import `bose-soundtouch-hybrid.yml` into your container manager (Container Station, Portainer, etc.) and deploy.
   * Command line: `docker compose -f bose-soundtouch-hybrid.yml up -d`
   * The container downloads the image, writes its config files into your folder, and pauses waiting for you to fill in `.env`.
   * <img width="686" height="191" alt="image" src="https://github.com/user-attachments/assets/f1727099-a2f4-4b94-b884-3a25cb13900c" />
   * <img width="577" height="221" alt="image" src="https://github.com/user-attachments/assets/f0a7d781-adce-4559-a81e-868e96a7e786" />

4. **Configure `.env`:** Open the generated `.env` and fill in:
   * **APP_IP / APPS_PORT**: Bose SOundtouch Hybrid's own LAN IP. (port defaults to 3000).
   * **MASS_IP / MASS_PORT**: Music Assistant server's IP (port defaults to 8095).
   * **Authentication**: either **MASS_TOKEN** (an auth token generated from Music Assistant's own Settings page), or **MASS_USERNAME** + **MASS_PASSWORD**: Provide one method, not both.
   * **MASS_CONTAINER_NAME**:
     - Standalone MASS Docker container: the container's actual name (commonly `music-assistant-server`, or whatever you named it).
     - MASS running inside Home Assistant: click **Music Assistant** in the HA sidebar, then copy everything after the port number and slash from the browser's address bar — e.g. `http://<ha-ip>:8123/d5369777_music_assistant` → `d5369777_music_assistant`. 
   * **HA_TOKEN / HA_PORT**: If HA/MASS runs on a separate machine from SoundTouch Hybrid set a Home Assistant long-lived access token (port defaults to 8123).

5. **Restart the Container:** Once `.env` is filled in, restart to launch SoundTouch Hybrid.
   * NAS/GUI: click **Restart** on the container.
   * Command line: `docker compose -f bose-soundtouch-hybrid.yml restart`
   * Watch the console log. It lists every speaker it found and confirms your Bose Cloud redirect happened automatically (no USB stick, no manual firmware step).

6. **Install the Web App:** On your phone, open `http://<YOUR_SERVER_IP>:3000/control.html` and tap **"Add to Home Screen"** to add the SoundTouch Hybrid icon and link to your home screen.

### Home Assistant Add-on

1. **Before you install:** Music Assistant must already be installed and fully working — see "Setting up Music Assistant" above.

2. In Home Assistant: **Settings → Add-ons → Add-on Store → ⋮ → Repositories**, add:
   `https://github.com/TJGigs/Bose-SoundTouch-Hybrid-2026`
3. Find **Bose SoundTouch Hybrid** in the store and click **Install**.
4. Open the **Configuration** tab before starting it:
   * **App IP / Music Assistant IP** — leave both blank if Music Assistant runs on this same HA instance; the add-on auto-detects the host address. Only set **Music Assistant IP** if MASS runs elsewhere.
   * **Music Assistant Auth Token** — generate one from MASS's own Settings page.
   * **Music Assistant Username / Password** — an alternative to the token above. Both methods are fully supported; provide one or the other, not both.
5. Start the add-on. On first boot it scans your network and finds your SoundTouch speakers automatically.
6. Open the add-on's panel from the Home Assistant sidebar to use the web app. It's also reachable directly at `http://<your-HA-host-IP>:3000/control.html`.
7. **Install the Web App:** On your phone, open `http://<YOUR_SERVER_IP>:3000/control.html` and tap **"Add to Home Screen"** to add the SoundTouch Hybrid icon and link to your home screen.

---
