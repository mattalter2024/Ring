# RingWatch — 24/7 Local Ring NVR, AI Package Detection & Multi-User Web Hub

**RingWatch** is a self-hosted **24/7 Network Video Recorder (NVR)**, **AI Package Detection Engine**, and **cross-platform Web Security Hub** for Ring cameras, doorbells, and Ring Alarm sensors.

It pairs a lightweight **Standalone Node.js Backend** (with a native Windows Service + Taskbar Tray Icon) with a responsive **Web Frontend** that runs seamlessly in **Windows and macOS** browsers (Chrome, Edge, Safari) or as an installable **PWA** across your local network.

---

## Screenshots

### Passkey & Multi-User Sign-In Gate
Passwordless sign-in with **FIDO2 Passkeys** (Windows Hello, macOS Touch ID, Face ID, or security keys) alongside multi-user username/password authentication.

![RingWatch Passkey Sign-In Gate](docs/screenshots/01-login-passkey.png)

### Live Cameras Wall
Real-time low-latency HLS multi-camera view, 24/7 NVR recording status badges, instant snapshots, floodlight/siren controls, one-click AI scans, and role-aware sidebar.

![RingWatch Live Cameras Wall](docs/screenshots/02-live-cameras.png)

### Interactive Multi-Camera Timeline
Smooth 60fps multi-track timeline scrubbing (`24h` down to `15m` zoom) with Windows mouse-wheel & macOS trackpad pinch/swipe support, motion/doorbell/AI/sensor markers, and one-click **Clear All**.

![RingWatch Interactive Timeline](docs/screenshots/03-timeline.png)

### Local MP4 Recordings Vault
Browse, filter, star/protect, stream (`HTTP 206 Range`), import `.mp4` files from any browser, export clips with tamper-evident **SHA-256 Evidence Bundles**, sync Ring Cloud clips, or clear the vault in one click.

![RingWatch Local MP4 Recordings Vault](docs/screenshots/04-recordings-vault.png)

### 24/7 NVR & Storage Console
Manage continuous per-camera recording, automatic internal/USB/NAS drive detection, primary + failover storage vaults, rolling storage quotas, retention policies, **Open Vault**, **Folder Path**, and **Clear All Videos**.

![RingWatch 24/7 NVR and Storage Console](docs/screenshots/05-nvr-storage.png)

### AI Package Detection & Alerts
Automatic box and parcel detection powered by **Google Gemini Vision** or **OpenAI Vision (GPT-4o / 4.1)** with before/after baseline comparison, zoomed ground/porch delivery-zone crop, local NVR scene-change triggering, and customizable chime + browser desktop alerts.

![RingWatch AI Package Detection](docs/screenshots/06-ai-packages.png)

### Multi-User Passkeys (WebAuthn) & RBAC Permissions
Enroll Windows Hello / Touch ID passkeys and assign **4 built-in role presets** or customize all **11 granular RBAC permissions** across Cameras, Recordings & NVR, Alarm & Sensors, AI Packages, and Administration.

![RingWatch Multi-User Passkeys and RBAC](docs/screenshots/07-access-passkeys.png)

### Settings, Encrypted Credentials & Troubleshooting Logs
Configure Ring account sign-in, encrypted Cloud Vision AI keys, browser desktop alerts, web access controls, and one-click **Troubleshooting Log** downloads.

![RingWatch Settings](docs/screenshots/08-settings.png)

---

## Key Features

- **24/7 Continuous Local NVR**: Records fragmented MP4 segments continuously to your local disk, external USB drive, or NAS with automatic failover, rolling quota/retention pruning, star-protected clips, and watchdog auto-recovery.
- **Native Windows Service & Taskbar Tray Icon**: Runs headless 24/7 as `RingWatchNvrService` (`RingWatchService.exe`) with automatic boot startup and crash recovery, paired with a native system tray icon (`RingWatchTray.exe`) offering Green/Amber/Red status, Start/Stop/Restart without UAC prompts, Live Log Viewer, Verbose Debug toggle, and one-click Troubleshooting Log export.
- **Cross-Platform Web UI (Windows & macOS)**: Native Apple SF typography & Safari HLS playback on macOS, Fluent/Segoe styling on Windows, smooth trackpad pinch-to-zoom & horizontal swipe on the Timeline, and installable PWA support.
- **AI Package Detection**: Supports OpenAI Vision and Google Gemini Vision with illumination-normalized local NVR visual scene-change detection (so package detection triggers reliably even during continuous 24/7 streaming), two-stage motion follow-up scans, and automatic Gemini 503 failover.
- **Multi-User Auth, Passkeys & RBAC**:
  - **Passkeys (WebAuthn / FIDO2)** + scrypt password sign-in with signed HTTP-only session cookies.
  - **4 Role Presets** (**Administrator**, **Home Operator**, **Read-Only Viewer**, **Guest Live Only**) plus **Custom Permission Sets** across 11 granular permissions enforced on every REST endpoint, media stream, and SSE event channel.
- **Local Vault & Evidence Bundles**: Stream recordings over HTTP 206 Range, upload/import `.mp4` files from any browser, export clips with SHA-256 `.evidence.json` manifests, auto-purge demo clips in Live Mode, and wipe all recordings cleanly via **Clear All Videos**.
- **Security-First Design**: AES-256-GCM encrypted local secret storage for Ring tokens & AI API keys, per-session media tokens, DNS-rebinding host validation, automatic secret redaction in troubleshooting logs, and zero runtime npm vulnerabilities.

---

## Architecture

1. **Standalone Node.js Backend (`server/`)** — Manages Ring WebRTC/HLS sessions, 24/7 FFmpeg MP4 recording, disk retention & failover, AI Vision scans, multi-user WebAuthn/RBAC auth, REST API (`/api/*`), authenticated media routes (`/media/<token>/...`), and Server-Sent Events (`/api/events`).
2. **React + TypeScript Web Frontend (`src/`)** — Connects over HTTP + SSE from any browser on Windows, macOS, tablet, or mobile.
3. **Native Windows Service & Tray Companion (`windows/`)** — Lightweight .NET service wrapper (`RingWatchService.exe`) and taskbar tray controller (`RingWatchTray.exe`) compiled cleanly in CI.

---

## Quick Start

### Option 1 — Windows Self-Contained Release Package (Recommended, No Node.js Required)

1. Download **`RingWatch-Windows-Server-v2.0.0.zip`** from the [**Latest GitHub Release**](https://github.com/mattalter2024/Ring/releases/latest).
2. Unzip it to a permanent folder (for example, `C:\RingWatch\`).
3. **Install as a 24/7 Windows Service + Taskbar Tray Icon**:
   - Double-click **`install-windows-service.bat`** and approve the Administrator prompt.
   - Installs and starts **`RingWatchNvrService`** (starts automatically at boot with crash recovery).
   - Launches **`RingWatchTray.exe`** in your taskbar showing **Green (Running)** / **Amber (Starting)** / **Red (Stopped)** status with right-click controls for **Open Web UI**, **Start / Stop / Restart**, **View Live Logs**, **Export Troubleshooting Log**, and **Verbose Debug Logging**.
   - To uninstall later, double-click **`uninstall-windows-service.bat`**.
4. **Or run in foreground without installing a service**:
   - Double-click **`start-ringwatch.bat`** to start the backend and open **`http://localhost:3456`** automatically.

*(The Windows ZIP already bundles `runtime\node.exe`, `ffmpeg.exe`, `RingWatchService.exe`, `RingWatchTray.exe`, the prebuilt Web UI, and all runtime dependencies.)*

### Option 2 — macOS / Linux / Cross-Platform Release Package (Node.js 20+ / 24 LTS)

1. Download **`RingWatch-CrossPlatform-v2.0.0.tar.gz`** from the [**Latest GitHub Release**](https://github.com/mattalter2024/Ring/releases/latest) (or clone this repo).
2. Extract and start:

```bash
tar -xzf RingWatch-CrossPlatform-v2.0.0.tar.gz
cd RingWatch-CrossPlatform
npm ci --omit=dev
npm start
```

Open **`http://localhost:3456`** in Safari, Chrome, or Edge (or access via your server's LAN IP from any Mac or Windows PC).

### Option 3 — Build & Run from Source

```bash
# 1. Install dependencies
npm install

# 2. Build both Web Frontend (dist/) and Backend (dist-server/)
npm run build

# 3. Start the NVR & AI backend (also serves the Web UI on port 3456)
npm start
```

---

## Development Mode (Hot-Reload Frontend + Live Backend)

```bash
npm run dev
```

- **Backend API / NVR / AI**: `http://127.0.0.1:3456`
- **Vite Web Frontend**: `http://127.0.0.1:5173` (automatically proxies `/api` and `/media` to the backend)

---

## Configuration (Environment Variables — All Optional)

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3456` | HTTP port for Web UI, REST API, SSE, and media streams |
| `HOST` | `0.0.0.0` | Bind address (`127.0.0.1` for local-only, `0.0.0.0` for LAN access) |
| `RINGWATCH_DATA_DIR` | `%APPDATA%\RingWatch` (Win) / `~/.ringwatch` | Config, encrypted secrets, user database, logs, and recordings index folder |
| `RINGWATCH_RECORDINGS_DIR` | `~/Videos/RingWatch` | Default primary NVR recordings directory |
| `RINGWATCH_DEBUG` | `0` | Set to `1` for verbose debug logging |
| `RINGWATCH_AUTH_PASSWORD` | *(unset — managed via Access & Passkeys UI)* | Optional environment-enforced fallback admin login password |

---

## Verification Scripts

```bash
npm audit --omit=dev --audit-level=high   # Zero high/critical runtime vulnerabilities
npm run typecheck                         # TypeScript checks for Web Frontend & Node.js Backend
npm test                                  # 39 unit & HTTP/SSE/RBAC/Vault integration tests
npm run build                             # Production build (dist/ + dist-server/)
```
