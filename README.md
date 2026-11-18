# RingWatch for Windows

A native Windows desktop console (Electron + React + TypeScript) for managing **Ring cameras, live video streams, local & cloud recordings, Ring Alarm / smart sensors, and Cloud Vision AI package detection**.

## Features

- **Live Video Streaming**: Low-latency HLS live camera viewing powered by `ring-client-api` + FFmpeg inside a responsive multi-camera grid and expandable Focus Theater mode.
- **Interactive Multi-Camera Timeline Tool**:
  - Zoomable 1h / 6h / 12h / 24h multi-track NVR timeline displaying local MP4 recording bars per camera overlaid with motion, doorbell ring, AI package detection, and Ring sensor event pins.
  - Draggable playhead scrubber with hover timestamps, playback speed (`0.5x`–`4x`), previous/next event jump, auto-advance across clips, and one-click clip locking/export.
- **Local Video Storage & Cloud Vault**:
  - Save MP4 recordings directly to any local Windows folder (default: `Videos\RingWatch`) manually or automatically on **motion**, **doorbell press**, or **AI package detection**.
  - Built-in disk usage meter, configurable **GB storage quota cap**, **retention days auto-cleanup**, **Star/Protect lock** so important clips are never pruned, **Import MP4**, **Export Copy**, and **Rescan Disk** reconciliation.
  - Browse recent Ring Cloud camera events and download MP4 clips straight into your local vault.
- **Sensors & Real-Time Event Stream**:
  - Live Ring Alarm mode control (**Disarmed / Home / Away**).
  - Real-time status monitoring for door/window contact sensors, motion detectors, flood & freeze sensors, alarm keypads, and camera lights/sirens.
  - Filterable chronological event timeline.
- **AI Package Detection Automation (OpenAI Vision & Google Gemini Vision)**:
  - Automatically analyzes camera snapshots on **motion**, **doorbell press**, or a **scheduled interval** using your OpenAI (`gpt-4o-mini`, `gpt-4.1-mini`, `gpt-4o`) or Google Gemini (`gemini-2.5-flash`, `gemini-2.0-flash`, `gemini-2.5-pro`) API key.
  - Returns package count, carrier hint, placement description, and confidence score with configurable minimum threshold and alert cooldown.
  - Triggers **native Windows desktop toast notifications** (clicking opens the camera directly) and **synthesized alert chimes** (4 sound profiles + volume control).
- **Windows-Native Security & Background Operation**:
  - Ring refresh tokens and AI API keys are encrypted locally with Windows DPAPI (`safeStorage`).
  - Automatic Ring refresh token rotation persistence.
  - Windows System Tray integration with Minimize-to-Tray background monitoring.
- **Instant Demo Mode**: Launch and test live camera previews, MP4 clip recording, sensor toggles, and package detection immediately before signing into Ring.

## Quick Start (Development)

```bash
npm install
npm run dev
```

## Building the Windows Installer (`.exe`)

Run on Windows (or via Windows CI runner) to generate both an NSIS setup installer and a portable executable under `release/`:

```bash
npm run build:win
```

Or build only the portable `.exe`:

```bash
npm run build:win:portable
```

## Connecting Your Ring Account

1. Open **Settings** inside RingWatch.
2. Either:
   - Sign in directly with your **Ring Email + Password** (RingWatch interactively prompts for your Ring 2FA code), **or**
   - Generate a refresh token using `npx -p ring-client-api ring-auth-cli` and paste it into the Refresh Token field.
3. Add your **OpenAI** or **Google Gemini** API key in **Settings → Cloud Vision AI** and click **Test Vision API Connection**.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run Vite renderer + Electron main concurrently |
| `npm run build` | Production build of React UI and Electron TypeScript |
| `npm run build:win` | Package Windows NSIS installer and portable `.exe` |
| `npm run typecheck` | Type-check both renderer and Electron main processes |
| `npm test` | Run automated Vitest test suite |
