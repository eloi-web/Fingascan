# FingaScan

> Generative fingerprint art — scan your fingertip through your camera and watch your unique ridge patterns emerge in real time.

FingaScan uses your device's rear camera combined with Sobel edge detection and multi-frame accumulation to build a rich, artistic rendering of the micro-texture on your finger. This is **not** biometric security — it's a fun, generative art piece. Every scan is unique and shareable.

---

## Features

- **Live edge detection** — real-time Sobel operator highlights ridge micro-contrast as you position your finger
- **True frame accumulation** — the scanning phase blends ~90 consecutive frames, building depth that a single snapshot cannot capture
- **Quality gate** — rejects scans with insufficient edge data before wasting a full scan cycle
- **Composite output** — final export merges the accumulated ridge layer over a darkened video frame background for a tactile, cinematic look
- **Save to device** — download the result as a PNG with one tap

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | React 19 + TypeScript |
| Bundler | Vite 6 |
| Styling | Tailwind CSS v4 |
| Animation | Motion (Framer Motion) |
| Image processing | Canvas API + Sobel edge detection |
| Icons | Lucide React |
| Font | Dynamix (local) + Space Grotesk + Plus Jakarta Sans |

No TensorFlow.js dependency — the edge detection is implemented with a pure Canvas API pixel loop, keeping the bundle small and the processing fast.

---

## How It Works

```
Camera feed (getUserMedia)
        │
        ▼
  processFrame() [rAF loop]
        │
        ├─ camera_ready ──► Sobel edge detection ──► processingCanvasRef (live preview)
        │
        └─ scanning ──────► Sobel edge detection ──► processingCanvasRef (live preview)
                                                  └─► accumCanvasRef (screen-blend, α=0.04, ×90 frames)
                                                              │
                                                              ▼
                                                    finalize: video bg + ridge overlay ──► PNG
```

**Edge detection** — for each pixel, luminance difference between the pixel and its right/down neighbours is computed and amplified. Values above a threshold are mapped to gold tones (R full, G 80%, B 20%).

**Accumulation** — each processed frame is blended into an off-screen canvas using `globalCompositeOperation = 'screen'` at `globalAlpha = 0.04`. After 90 frames (~3 seconds), consistent ridge edges reinforce while noise averages out, producing a cleaner pattern than any single frame could.

---

## Getting Started

### Prerequisites

- Node.js 18+
- A device with a camera (works best on mobile with a rear camera)

### Install & Run

```bash
npm install
npm run dev
```

Open `http://localhost:3000` in your browser (or the LAN address on mobile).

### Build

```bash
npm run build
npm run preview
```

---

## Usage

1. Tap **Start Sequence** — the app requests camera permission and starts the live edge-detection preview
2. Hold your fingertip **2–4 cm from the lens** so the ridges are loosely in focus, or press it directly against the lens for a more abstract read
3. Tap **Capture Frame** when you see good edge activity in the viewport
4. Hold still for ~3 seconds while frames accumulate
5. Your fingerprint art appears — tap **Save** to download it as a PNG

---

## Disclaimer

FingaScan does not store, transmit, or process biometric data. The camera feed is processed entirely on-device in the browser. No images ever leave your device.

---

## Project Status

Active development. Core scanning pipeline is functional. Planned improvements: shareable link generation, pattern color themes, WebGL-accelerated accumulation.
