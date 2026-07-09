# Bose SoundTouch Hybrid — Home Assistant Add-on

Self-hosted replacement for Bose's discontinued SoundTouch Cloud service. Restores physical presets, multi-room grouping, and streaming via Music Assistant — running as a native Home Assistant add-on instead of a standalone Docker container.

---

## Setting up Music Assistant (MASS)

***You must verify your SoundTouch speakers and streaming providers are fully working inside of Music Assistant before installing SoundTouch Hybrid.***

Install Music Assistant (MASS): ***version 2.9.5 or later is required***

1. **For installation instructions and troubleshooting, use Music Assistant Help** — setup, providers, speaker testing, playback issues, etc.
   * See [MASS GitHub](https://github.com/music-assistant/server) and [MASS Website](https://www.music-assistant.io/installation)
   * If you're running MASS as its own standalone Docker container (not the Home Assistant add-on), `mass_docker.yml` and `mass_package.json` in the `examples` folder of the main repository are provided as a reference for one working configuration. Your setup may differ.

2. **Initial Setup:** Once MASS is installed, go to its web interface and create your login. Bose SoundTouch Hybrid supports either way of authenticating to MASS:
   * **Username / Password:** your MASS login.
   * **Auth Token:** a long-lived access token generated from MASS's own Settings page

3. **Add/Configure Player Providers:** Add the DLNA provider. If desired also add AirPlay provider.
   * **DLNA is the recommended "Preferred Output Protocol"** for SoundTouch Hybrid, based on experience with greater stability and responsiveness:
     - It's the original protocol built into the SoundTouch speakers' internal OS; AirPlay was added later as a software add-on.
     - SoundTouch Hybrid's self-healing, latency management, and state sync logic are all optimized for DLNA.
     - The physical remote-control capability and hijacks are more complete with DLNA, including next/prev track and a more responsive pause/play.
   * **AirPlay** is supported. It does provide continuous live track-title updates on the speaker's LED display, whereas Music Assistant's DLNA stream currently only updates the speaker's LED display for the first track of a multi-track stream.

4. **Add/Configure Music Sources:** Add your streaming providers (Spotify, TuneIn, local NAS, etc). Uncheck any options to sync/import/cache the source into the local Music Assistant database. This ensures your providers are live rather than copied to a local cache.

5. **Configure Players (Speakers):** For each SoundTouch speaker Music Assistant discovers, set its **"Preferred Output Protocol"** to **DLNA** (recommended) or AirPlay. Change it from the **Auto-Select** default.
   * SoundTouch Hybrid enforces Preferred Output Protocol-specific required settings on startup and can also be triggered manually on the Tools page.
   * SoundTouch Hybrid uses Music Assistant only as the backend streaming engine. Once it's set up, there's no need to go back into its UI. MASS features like speaker grouping, automations, and favorites aren't used by SoundTouch Hybrid; leave them disabled.

6. **Very Important:** Confirm Music Assistant itself can play audio to every speaker and from every provider, and that you actually hear it on each speaker. Do this completely independent of Bose SoundTouch Hybrid. If Music Assistant can't reach a speaker, SoundTouch Hybrid can't either.

---

## Common to All Install Methods

* **Redirect to Local Cloud:** Happens automatically on first boot — no USB stick, no manual firmware step. Confirmed in the console/Pre-Flight log.
* **Speaker Discovery:** Runs automatically on first boot and re-syncs on every subsequent boot — you never manually look up, enter, or edit a speaker list. Discovery scans the same subnet as your Music Assistant server, so your SoundTouch speakers need to be on that same subnet to be found.
* *A static IP address for each speaker is recommended, however, dynamic speaker IP addresses are supported.*

## Installing This Add-on

**Before you install:** Music Assistant must already be installed and fully working — see "Setting up Music Assistant" above.

1. In Home Assistant: **Settings → Add-ons → Add-on Store → ⋮ → Repositories**, add:
   `https://github.com/TJGigs/Bose-SoundTouch-Hybrid-2026`
2. Find **Bose SoundTouch Hybrid** in the store and click **Install**.
3. Open the **Configuration** tab before starting it:
   * **App IP / Music Assistant IP** — leave both blank if Music Assistant runs on this same HA instance; the add-on auto-detects the host address. Only set **Music Assistant IP** if MASS runs elsewhere.
   * **Music Assistant Auth Token** — generate one from MASS's own Settings page.
   * **Music Assistant Username / Password** — an alternative to the token above. Both methods are fully supported; provide one or the other, not both.
4. Start the add-on. On first boot it scans your network and finds your SoundTouch speakers automatically.
5. Open the add-on's panel from the Home Assistant sidebar to use the web app. It's also reachable directly at `http://<your-HA-host-IP>:3000/control.html`.
6. **Install the Web App:** On your phone, open `http://<YOUR_SERVER_IP>:3000/control.html` and tap **"Add to Home Screen"** to add the SoundTouch Hybrid icon and link to your home screen.

---

## Notes Specific to the Home Assistant Install

- This add-on requires **host networking** (`host_network: true`) — this is what lets your physical speakers reach the add-on directly at your HA host's real LAN address for the preset backdoor. It requires full network access and cannot run with bridge or otherwise restricted networking.
- This add-on can request Supervisor restart the Music Assistant add-on on your behalf if it detects MASS isn't running — this uses Home Assistant's own Supervisor API and needs no separate token from you.

## Getting Help

Full technical documentation, architecture notes, and the standalone-Docker install path live in the main repository README:
[github.com/TJGigs/Bose-SoundTouch-Hybrid-2026](https://github.com/TJGigs/Bose-SoundTouch-Hybrid-2026)
