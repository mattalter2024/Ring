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

### Option 1 — Pre-Built Self-Contained ZIP (No Node.js or FFmpeg install needed)
1. Download **`RingWatch-Windows-Server.zip`** from the latest **Build RingWatch Web & Backend** GitHub Actions run.
2. Unzip it anywhere (e.g. `C:\RingWatch\`).
3. Double-click **`start-ringwatch.bat`**.
4. Your browser opens **`http://localhost:3456`** automatically (or open `http://<your-pc-ip>:3456` from another device on your LAN).

*(The ZIP already bundles `runtime\node.exe`, `ffmpeg.exe`, and all runtime dependencies.)*

### Option 2 — Run from Source (Node.js 20+ / 24 LTS)

```powershell
# 1. Install dependencies
npm install

# 2. Build both Web Frontend (dist/) and Backend (dist-server/)
npm run build

# 3. Start the NVR & AI backend (also serves the Web UI)
npm start
```

### Optional: Auto-Start in Background on Windows Boot
```powershell
.\install-windows-startup.ps1
# To remove later:
.\install-windows-startup.ps1 -Uninstall
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
