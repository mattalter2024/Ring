# RingWatch — Web Frontend + Standalone 24/7 NVR & AI Backend

RingWatch is split into two cleanly separated parts:

1. **Standalone Node.js Backend (`server/`)** — Runs 24/7 headless on Windows (or Linux/macOS) to manage:
   - Ring camera WebRTC connections, continuous 24/7 fragmented-MP4 NVR recording, and local disk retention/failover
   - Live low-latency HLS streaming & HTTP 206 Range recording playback (`/media/<token>/...`)
   - AI Package Detection (OpenAI / Gemini Vision) with before/after baseline comparison, delivery-zone zoom crop, and local NVR scene-change detection
   - Ring Alarm & sensor monitoring, REST API (`/api/*`), and real-time Server-Sent Events (`/api/events`)
   - Encrypted secret storage (AES-256-GCM keyfile) and optional web login password gate
2. **React Web Frontend (`src/`)** — Connects over HTTP + SSE from any browser on localhost or your LAN (PC, laptop, tablet, phone) with live multi-camera view, timeline scrubbing, recordings vault, sensor monitor, AI package alerts, and browser desktop notifications.

---

## Quick Start on Windows

### Option 1 — Install as a Windows Service + Taskbar Icon (Recommended, No Node.js install needed)
1. Download **`RingWatch-Windows-Server.zip`** from the latest **Build RingWatch Web & Backend** GitHub Actions run.
2. Unzip it to a permanent folder (e.g. `C:\RingWatch\`).
3. Double-click **`install-windows-service.bat`** (approve the Administrator prompt).
   - Installs and starts the **`RingWatchNvrService`** Windows Service (`Automatic` boot start + automatic crash recovery).
   - Launches the **RingWatch Taskbar Tray Icon** (`RingWatchTray.exe`) showing live **Green (Running)** / **Amber (Starting)** / **Red (Stopped)** status.
   - Right-click the tray icon anytime for **Open Web UI**, **Start / Stop / Restart Backend**, **View Live Logs**, **Export Troubleshooting Log**, **Open Logs Folder**, and **Verbose Debug Logging**.
   - To uninstall later, double-click **`uninstall-windows-service.bat`**.

### Option 2 — Quick Foreground Launch (No Service Install)
- Unzip `RingWatch-Windows-Server.zip` and double-click **`start-ringwatch.bat`**. Your browser opens **`http://localhost:3456`** automatically.

*(The ZIP already bundles `runtime\node.exe`, `ffmpeg.exe`, `RingWatchService.exe`, `RingWatchTray.exe`, and all runtime dependencies.)*

### Option 3 — Run from Source (Node.js 20+ / 24 LTS)

```powershell
# 1. Install dependencies
npm install

# 2. Build both Web Frontend (dist/) and Backend (dist-server/)
npm run build

# 3. Start the NVR & AI backend (also serves the Web UI)
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
| `RINGWATCH_DATA_DIR` | `%APPDATA%\RingWatch` (Win) / `~/.ringwatch` | Config, encrypted secrets, and recordings index folder |
| `RINGWATCH_RECORDINGS_DIR` | `~/Videos/RingWatch` | Default primary NVR recordings directory |
| `RINGWATCH_AUTH_PASSWORD` | *(unset — open on LAN)* | Enables password login gate across the Web UI & API (can also be configured in **Settings -> Web Access & Notifications**) |

---

## Verification Scripts

```bash
npm run typecheck   # TypeScript checks for both Web Frontend and Node.js Backend
npm test            # Unit & backend HTTP/SSE/Auth integration tests
npm run build       # Production build (dist/ + dist-server/)
```
