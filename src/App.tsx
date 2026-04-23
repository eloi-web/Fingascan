import { useState, useRef, useEffect } from 'react';
import { Fingerprint, Loader2, Download, Camera, AlertTriangle, RefreshCw } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// Seeded PRNG (LCG) — same seed always produces the same pattern
function makePrng(seed: number) {
  let s = Math.abs(Math.floor(seed)) % 2147483647 || 1;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

// Procedural fingerprint ridge generator seeded by camera pixel data
function drawProceduralFingerprint(
  ctx: CanvasRenderingContext2D,
  size: number,
  seed: number,
  rAvg: number,
  gAvg: number,
  bAvg: number
) {
  const rng = makePrng(seed);
  const hue = ((Math.atan2(bAvg - gAvg, rAvg - gAvg) * 180 / Math.PI) + 40 + 360) % 360;
  const patternType = Math.floor(rng() * 4); // 0=arch 1=left-loop 2=right-loop 3=whorl
  const cx = size * (0.5 + (rng() - 0.5) * 0.12);
  const cy = size * (0.48 + (rng() - 0.5) * 0.08);
  const numRidges = 24 + Math.floor(rng() * 10);
  const ridgeSpacing = (size * 0.44) / numRidges;

  ctx.save();
  ctx.globalCompositeOperation = 'screen';

  for (let r = 0; r < numRidges; r++) {
    const t = r / numRidges;
    const radius = ridgeSpacing * (r + 1);
    ctx.beginPath();
    ctx.lineWidth = 0.8 + rng() * 0.7;
    ctx.strokeStyle = `hsla(${hue + rng() * 12}, 80%, 62%, ${0.5 + rng() * 0.35})`;
    const STEPS = 128;
    for (let step = 0; step <= STEPS; step++) {
      const angle = (step / STEPS) * Math.PI * 2;
      let distortion = 0;
      if (patternType === 0) distortion = -Math.sin(angle) * radius * (0.3 + t * 0.25);
      else if (patternType === 1) distortion = Math.sin(angle + t * 1.2) * radius * 0.42;
      else if (patternType === 2) distortion = Math.sin(angle - t * 1.2) * radius * 0.42;
      else distortion = Math.sin(angle * 2 + r * 0.3) * radius * 0.1;
      const noise = (rng() - 0.5) * ridgeSpacing * 0.55;
      const rd = radius + distortion + noise;
      const px = cx + rd * Math.cos(angle);
      const py = cy + rd * Math.sin(angle) * 0.72;
      if (step === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.stroke();
  }

  // Radial vignette to focus attention on the center
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.55);
  grad.addColorStop(0.65, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.9)');
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  ctx.restore();
}

// Full 3x3 Sobel operator — returns a gold-tinted RGBA magnitude buffer
function applySobel(width: number, height: number, data: Uint8ClampedArray): Uint8ClampedArray {
  const output = new Uint8ClampedArray(data.length);
  const Gx = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
  const Gy = [-1, -2, -1, 0, 0, 0, 1, 2, 1];

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      let sumX = 0;
      let sumY = 0;

      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          const pos = ((y + ky) * width + (x + kx)) * 4;
          // Luminance from RGB
          const lum = data[pos] * 0.299 + data[pos + 1] * 0.587 + data[pos + 2] * 0.114;
          const ki = (ky + 1) * 3 + (kx + 1);
          sumX += lum * Gx[ki];
          sumY += lum * Gy[ki];
        }
      }

      // Amplify heavily — finger-on-lens has very low contrast
      const magnitude = Math.min(255, Math.sqrt(sumX * sumX + sumY * sumY) * 6);
      const idx = (y * width + x) * 4;
      output[idx] = magnitude;           // R — gold
      output[idx + 1] = magnitude * 0.8;     // G
      output[idx + 2] = magnitude * 0.2;     // B
      output[idx + 3] = magnitude > 0 ? 255 : 0;
    }
  }
  return output;
}

export default function App() {
  const [status, setStatus] = useState<
    'idle' | 'initializing' | 'camera_ready' | 'scanning' | 'complete' | 'error'
  >('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const resultRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Real-time processing
  const processingCanvasRef = useRef<HTMLCanvasElement>(null);
  const animationFrameId = useRef<number | null>(null);
  const statusRef = useRef(status);

  // Frame accumulation for scanning
  const accumCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const scanFrameCountRef = useRef(0);
  const SCAN_FRAMES = 45; // ~1.5s at 30fps

  const [capturedImage, setCapturedImage] = useState<string | null>(null);

  // Keep a ref of status to use inside the requestAnimationFrame loop
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const initializeCamera = async () => {
    setStatus('initializing');
    setErrorMessage('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        },
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.onloadedmetadata = () => {
          videoRef.current?.play().then(() => {
            setStatus('camera_ready');
            startRealtimeProcessing();
          }).catch(() => {
            setStatus('error');
            setErrorMessage('Failed to play video stream.');
          });
        };
      }
    } catch (err) {
      setStatus('error');
      setErrorMessage(
        err instanceof Error ? err.message : 'Camera access denied by device or browser.'
      );
    }
  };

  const startRealtimeProcessing = () => {
    const video = videoRef.current;
    const canvas = processingCanvasRef.current;
    if (!video || !canvas) return;

    if (animationFrameId.current) {
      cancelAnimationFrame(animationFrameId.current);
    }

    // High performance processing buffer
    const SIZE = 256;
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    if (!ctx) return;

    const processFrame = () => {
      // Loop only when actively tracking or finalizing
      if (statusRef.current !== 'camera_ready' && statusRef.current !== 'scanning') {
        animationFrameId.current = null;
        return;
      }

      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        const minDim = Math.min(video.videoWidth, video.videoHeight);
        const startX = (video.videoWidth - minDim) / 2;
        const startY = (video.videoHeight - minDim) / 2;

        ctx.drawImage(video, startX, startY, minDim, minDim, 0, 0, SIZE, SIZE);

        // Get image data and run full Sobel
        const imageData = ctx.getImageData(0, 0, SIZE, SIZE);
        const data = imageData.data;

        // Run full Sobel on the raw frame
        const sobelOut = applySobel(SIZE, SIZE, data);
        const outputData = ctx.createImageData(SIZE, SIZE);
        outputData.data.set(sobelOut);
        ctx.putImageData(outputData, 0, 0);

        // Accumulate Sobel frames during scanning via screen-blend
        if (statusRef.current === 'scanning' && accumCanvasRef.current) {
          const accumCtx = accumCanvasRef.current.getContext('2d');
          if (accumCtx) {
            accumCtx.globalCompositeOperation = 'screen';
            accumCtx.globalAlpha = 0.10;
            accumCtx.drawImage(canvas, 0, 0);
            scanFrameCountRef.current++;

            if (scanFrameCountRef.current >= SCAN_FRAMES) {
              // Sample raw frame colors for the procedural seed
              let rS = 0, gS = 0, bS = 0, n = 0;
              for (let i = 0; i < data.length; i += 16) {
                rS += data[i]; gS += data[i + 1]; bS += data[i + 2]; n++;
              }
              rS /= n; gS /= n; bS /= n;
              const seed = rS * 31337 + gS * 17777 + bS * 7919 + Date.now() % 10000;

              const OUT_SIZE = 512;
              const finalCanvas = document.createElement('canvas');
              finalCanvas.width = OUT_SIZE;
              finalCanvas.height = OUT_SIZE;
              const fCtx = finalCanvas.getContext('2d')!;

              // Dark background
              fCtx.fillStyle = '#0a0a0a';
              fCtx.fillRect(0, 0, OUT_SIZE, OUT_SIZE);

              // Subtle darkened video frame underneath
              fCtx.save();
              fCtx.filter = 'grayscale(100%) brightness(18%) contrast(250%)';
              fCtx.translate(OUT_SIZE, 0);
              fCtx.scale(-1, 1);
              const minDimF = Math.min(video.videoWidth, video.videoHeight);
              const startXF = (video.videoWidth - minDimF) / 2;
              const startYF = (video.videoHeight - minDimF) / 2;
              fCtx.drawImage(video, startXF, startYF, minDimF, minDimF, 0, 0, OUT_SIZE, OUT_SIZE);
              fCtx.restore();

              // Layer 1: accumulated Sobel texture from camera (whatever the camera actually saw)
              fCtx.filter = 'none';
              fCtx.globalCompositeOperation = 'screen';
              fCtx.globalAlpha = 0.55;
              fCtx.drawImage(accumCanvasRef.current, 0, 0, OUT_SIZE, OUT_SIZE);

              // Layer 2: procedural fingerprint ridges seeded by camera colors
              fCtx.globalAlpha = 1;
              drawProceduralFingerprint(fCtx, OUT_SIZE, seed, rS, gS, bS);

              setCapturedImage(finalCanvas.toDataURL('image/png', 0.9));
              setStatus('complete');

              if (video.srcObject) {
                (video.srcObject as MediaStream).getTracks().forEach(t => t.stop());
              }
              animationFrameId.current = null;
              return;
            }
          }
        }
      }

      animationFrameId.current = requestAnimationFrame(processFrame);
    };

    processFrame();
  };

  const startAccumulation = () => {
    const SIZE = 256;
    const accumCanvas = document.createElement('canvas');
    accumCanvas.width = SIZE;
    accumCanvas.height = SIZE;
    const accumCtx = accumCanvas.getContext('2d')!;
    accumCtx.fillStyle = '#000000';
    accumCtx.fillRect(0, 0, SIZE, SIZE);
    accumCanvasRef.current = accumCanvas;
    scanFrameCountRef.current = 0;
    setStatus('scanning');
  };

  const scanNow = () => {
    startAccumulation();
  };

  const resetScan = () => {
    setStatus('idle');
    setCapturedImage(null);
    setErrorMessage('');
    accumCanvasRef.current = null;
    scanFrameCountRef.current = 0;
    if (videoRef.current?.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach((track) => track.stop());
      videoRef.current.srcObject = null;
    }
  };

  useEffect(() => {
    if (status === 'complete' && resultRef.current) {
      if (window.innerWidth < 1024) {
        resultRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  }, [status]);

  // Start scanning immediately the moment the camera is ready — no countdown
  useEffect(() => {
    if (status === 'camera_ready') {
      startAccumulation();
    }
  }, [status]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (animationFrameId.current) {
        cancelAnimationFrame(animationFrameId.current);
      }
      if (videoRef.current?.srcObject) {
        const stream = videoRef.current.srcObject as MediaStream;
        stream.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  return (
    <div className="min-h-screen flex flex-col selection:bg-primary-container selection:text-on-primary-container overflow-x-hidden">
      {/* Header */}
      <header className="docked full-width top-0 sticky bg-transparent shadow-none z-50">
        <div className="flex justify-between items-center w-full px-6 py-4 max-w-screen-2xl mx-auto tracking-tight">
          <div className="flex items-center gap-4">
            <span className="font-headline text-2xl tracking-tighter text-white px-3 py-1">
              FINGASCAN
            </span>
          </div>
          <nav className="flex gap-1 sm:gap-2 items-center font-headline tracking-tighter uppercase font-medium glass-panel px-2 sm:px-4 py-1.5 sm:py-2 rounded-full">
            <a href="https://github.com/eloi-web" className="text-white hover:text-primary-container transition-colors flex items-center gap-2 px-2 sm:px-3 py-1.5 rounded-full disabled">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" className="bi bi-github" viewBox="0 0 16 16"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8"></path>
              </svg>
              <span className="hidden md:block text-sm">GitHub</span>
            </a>
          </nav>
        </div>
      </header>

      {/* Main Content */}
      <main className="grow flex flex-col justify-center px-4 sm:px-10 md:px-20 py-12 max-w-400 mx-auto w-full">
        <div className={`flex flex-col lg:flex-row gap-12 lg:gap-24 items-center justify-center w-full transition-all duration-700 ease-in-out`}>

          {/* Left Column: Scanner */}
          <section className="flex flex-col items-center gap-6 sm:gap-8 w-full max-w-md shrink-0">
            {/* Instruction Header */}
            <div className="text-center w-full relative mb-4">
              <h2 className="font-body text-3xl tracking-tight text-on-surface mb-2">
                Initialize Sequence
              </h2>
              <p className="font-body text-sm sm:text-base text-on-surface-variant tracking-[0.01em]">
                {status === 'scanning'
                  ? 'Hold your finger over the lens — building your pattern...'
                  : status === 'complete'
                    ? 'Scan complete. Your unique pattern is ready.'
                    : 'Press Start, then cover the lens with your finger.'}
              </p>
              <div className="absolute left-0 top-1/2 w-8 sm:w-12 h-px bg-surface-high -translate-y-1/2"></div>
              <div className="absolute right-0 top-1/2 w-8 sm:w-12 h-px bg-surface-high -translate-y-1/2"></div>
            </div>

            {/* Scanner Viewport */}
            <div className="relative w-72 h-72 sm:w-80 sm:h-80  rounded-3xl bg-surface-lowest flex items-center justify-center p-2 scanner-glow outline outline-outline-variant/20 overflow-hidden group">
              <div className="relative w-full h-full rounded-[1.25rem] bg-surface overflow-hidden border-2 border-primary-container/30">
                {/* Physical video feed - Visible now, so user sees their camera */}
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className={`absolute inset-0 w-full h-full object-cover transition-all duration-300 ${status === 'camera_ready' ? 'opacity-80 saturate-50' :
                    status === 'scanning' ? 'opacity-40 grayscale sepia hue-rotate-15 contrast-125 saturate-50 mix-blend-screen' : 'opacity-0'
                    }`}
                  style={{ transform: 'scaleX(-1)' }} // Mirroring looks more natural
                />

                {/* The Real-Time Processed CV Edge output overlaid dynamically */}
                <canvas
                  ref={processingCanvasRef}
                  className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-300 mix-blend-screen ${status === 'camera_ready' || status === 'scanning' || status === 'complete' ? 'opacity-100' : 'opacity-0'
                    }`}
                  style={{ transform: 'scaleX(-1)' }}
                />

                {/* Decorative Grid overlays CV output slightly */}
                <div className={`absolute inset-0 bg-grid-pattern opacity-30 ${status === 'camera_ready' ? 'mix-blend-overlay' : ''}`}></div>

                {/* Center Icon (Fades out heavily when tracking starts) */}
                <div className={`absolute inset-0 flex items-center justify-center mix-blend-screen text-primary-container z-20 pointer-events-none transition-opacity duration-500 ${(status === 'camera_ready' || status === 'scanning' || status === 'complete') ? 'opacity-10' : 'opacity-40'}`}>
                  <Fingerprint className="w-32 h-32 stroke-[0.5]" />
                </div>


                {/* Animated Scanning Line (Only mounts during "scanning" state. Disappears in "complete") */}
                <AnimatePresence>
                  {status === 'scanning' && (
                    <motion.div
                      initial={{ top: 0, opacity: 0 }}
                      animate={{ top: ['0%', '100%', '0%'], opacity: 0.7 }}
                      transition={{ duration: 1.5, ease: 'linear', repeat: Infinity }}
                      exit={{ opacity: 0, transition: { duration: 0.2 } }}
                      className="absolute left-0 right-0 h-1 bg-primary-container shadow-[0_0_20px_#ffcc00] z-30"
                    />
                  )}
                </AnimatePresence>

                {/* Static indicator when idle */}
                {(status === 'idle' || status === 'error') && (
                  <div className="absolute top-1/4 left-0 right-0 h-1 bg-primary-container shadow-[0_0_15px_#ffcc00] z-30 opacity-70 hidden group-hover:block transition-all duration-300"></div>
                )}
              </div>

              {/* Corner Reticles */}
              <div className="absolute w-[calc(100%-2rem)] h-[calc(100%-2rem)] inset-4 pointer-events-none z-20">
                <div className="absolute top-0 left-0 w-4 h-4 border-t-2 border-l-2 border-primary-container opacity-50"></div>
                <div className="absolute top-0 right-0 w-4 h-4 border-t-2 border-r-2 border-primary-container opacity-50"></div>
                <div className="absolute bottom-0 left-0 w-4 h-4 border-b-2 border-l-2 border-primary-container opacity-50"></div>
                <div className="absolute bottom-0 right-0 w-4 h-4 border-b-2 border-r-2 border-primary-container opacity-50"></div>
              </div>
            </div>

            {/* Action Area */}
            <div className="font-body w-full max-w-70 mt-4 flex flex-col items-center">
              {errorMessage && (
                <div className="w-full mb-4 px-4 py-3 rounded-lg border border-error/50 bg-error/10 text-error flex gap-2 items-start opacity-100 shadow-[0_0_15px_rgba(255,180,171,0.15)] animate-in fade-in slide-in-from-bottom-2">
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span className="text-[11px] leading-relaxed">{errorMessage}</span>
                </div>
              )}

              <button
                onClick={initializeCamera}
                disabled={status !== 'idle' && status !== 'error'}
                className={`gold-gradient text-on-primary-container font-body text-lg px-8 py-4 rounded-full flex items-center gap-3 transition-all duration-200 btn-hover-glow w-full justify-center shadow-lg 
                  ${(status !== 'idle' && status !== 'error')
                    ? 'opacity-80 scale-95 cursor-not-allowed grayscale-[0.2]'
                    : 'active:scale-95'}`}
              >
                {status === 'initializing' && (
                  <><Loader2 className="w-6 h-6 animate-spin" /><span>Starting...</span></>
                )}
                {(status === 'idle' || status === 'error') && (
                  <><Camera className="w-6 h-6" /><span>Start Sequence</span></>
                )}
                {(status === 'camera_ready' || status === 'scanning') && (
                  <><Loader2 className="w-6 h-6 animate-spin" /><span>Scanning...</span></>
                )}
                {status === 'complete' && (
                  <><Fingerprint className="w-6 h-6" /><span>Captured</span></>
                )}
              </button>

              <div className="label-text text-[10px] text-white opacity-60 mt-6 text-center h-4 tracking-[0.2em]">
                STATUS: {
                  status === 'idle' ? 'AWAITING_CAMERA' :
                    status === 'error' ? 'CONNECTION_FAILED' :
                      (status === 'initializing' || status === 'camera_ready') ? 'CONNECTING_LENS' :
                        status === 'scanning' ? 'EXTRACTING_PATTERN' :
                          status === 'complete' ? 'VERIFIED' : 'AWAITING_CAMERA'
                }
              </div>
            </div>
          </section>

          {/* Right Column: Result */}
          <AnimatePresence>
            {status === 'complete' && !!capturedImage && (
              <motion.section
                ref={resultRef}
                initial={{ opacity: 0, x: 20, scale: 0.95 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                transition={{ duration: 0.5, ease: 'easeOut', delay: 0.1 }}
                className="flex-col w-full max-w-lg flex shrink-0"
              >
                {/* Result Card */}
                <div className="relative w-full bg-surface-low rounded-xl p-6 sm:p-8 flex flex-col min-h-100 sm:min-h-125 border border-outline-variant/20 shadow-[0_20px_40px_rgba(241,193,0,0.02)] overflow-hidden">
                  {/* Decorative Glow */}
                  <div className="absolute -right-20 -top-20 w-64 h-64 bg-primary-container rounded-full blur-[100px] opacity-10 pointer-events-none"></div>

                  {/* Header */}
                  <div className="flex justify-between items-start mb-8 sm:mb-12 relative z-10">
                    <div className="flex flex-col">
                      <span className="label-text text-[10px] sm:text-xs text-on-surface-variant mb-1">
                        ANALYSIS COMPLETE
                      </span>
                      <h3 className="font-body text-4xl sm:text-5xl font-extrabold text-primary-container tracking-tighter leading-none uppercase drop-shadow-sm">
                        GOT YOU
                      </h3>
                    </div>
                    <div className="bg-surface-highest px-3 py-1 rounded text-xs font-mono text-primary-container/80 border border-primary-container/20 shadow-inner">
                      ID: ALCH-77X
                    </div>
                  </div>

                  {/* Artwork Canvas */}
                  <div className="grow flex items-center justify-center w-full bg-surface-lowest rounded-lg mb-6 sm:mb-8 p-4 relative overflow-hidden group border border-outline-variant/10 shadow-[inset_0_4px_20px_rgba(0,0,0,0.5)]">

                    {/* Displaying our actively composite extracted Map */}
                    <img
                      src={capturedImage}
                      alt="Extracted Fingerprint Map merged with camera"
                      className="absolute inset-0 w-full h-full object-cover opacity-90 transition-opacity duration-500 hover:scale-105"
                    />

                    <div className="absolute inset-0 bg-linear-to-t from-surface-lowest via-transparent to-surface-lowest/50 pointer-events-none"></div>

                    <div className="relative z-10 text-center flex flex-col items-center opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                      <Fingerprint className="w-10 h-10 text-primary-container mb-2 stroke-1 drop-shadow-lg" />
                      <span className="label-text text-xs text-primary-container drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]">
                        COMPOSITE PATTERN
                      </span>
                    </div>
                  </div>

                  {/* Footer Actions */}
                  <div className="flex justify-between items-center relative z-10 mt-auto pt-4 border-t border-surface-highest flex-wrap gap-4">
                    <div className="flex flex-col gap-1 w-full sm:w-auto text-center sm:text-left">
                      <span className="text-[10px] sm:text-xs text-on-surface-variant font-mono tracking-wider">
                        HASH: 0x{Math.random().toString(16).substring(2, 10).toUpperCase()}
                      </span>
                      <span className="text-[10px] sm:text-xs font-mono tracking-wider text-primary-container">
                        QUALITY: {(85 + Math.random() * 14).toFixed(1)}%
                      </span>
                    </div>
                    <div className="flex justify-center flex-wrap gap-3 w-full sm:w-auto">
                      <button
                        className="flex justify-center items-center gap-2 px-4 py-2 rounded-md border border-outline-variant/40 text-on-surface hover:bg-surface-high transition-all font-body font-semibold text-sm active:scale-95 duration-200"
                        onClick={resetScan}
                      >
                        <RefreshCw className="w-4 h-4" />
                        Try Again
                      </button>
                      <button
                        className="flex justify-center items-center gap-2 px-6 py-2 rounded-md border border-outline-variant/40 text-primary-container hover:bg-primary-container/10 transition-all font-body font-semibold text-sm active:scale-95 duration-200 hover:shadow-[0_0_15px_rgba(255,204,0,0.1)]"
                        onClick={() => {
                          const a = document.createElement('a');
                          a.href = capturedImage;
                          a.download = 'alchemist-scan.png';
                          a.click();
                        }}
                      >
                        <Download className="w-4 h-4" />
                        Save
                      </button>
                    </div>
                  </div>
                </div>
              </motion.section>
            )}
          </AnimatePresence>
        </div>
      </main>
    </div>
  );
}
