import { useState, useRef, useEffect } from 'react';
import { Code, Fingerprint, Aperture, Loader2, Download, Camera, AlertTriangle, RefreshCw } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

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

        // Get image data for edge detection
        const imageData = ctx.getImageData(0, 0, SIZE, SIZE);
        const data = imageData.data;
        
        const outputData = ctx.createImageData(SIZE, SIZE);
        const out = outputData.data;

        // Enhanced Sobel-style edge detection tuned for mobile camera blur on skin
        for (let y = 1; y < SIZE - 1; y++) {
          for (let x = 1; x < SIZE - 1; x++) {
            const idx = (y * SIZE + x) * 4;
            const idxRight = (y * SIZE + (x + 1)) * 4;
            const idxDown = ((y + 1) * SIZE + x) * 4;

            // Accurate luminance conversion
            const luminance = (data[idx] * 0.3 + data[idx+1] * 0.59 + data[idx+2] * 0.11);
            const luminanceRight = (data[idxRight] * 0.3 + data[idxRight+1] * 0.59 + data[idxRight+2] * 0.11);
            const luminanceDown = (data[idxDown] * 0.3 + data[idxDown+1] * 0.59 + data[idxDown+2] * 0.11);

            const edgeX = Math.abs(luminance - luminanceRight);
            const edgeY = Math.abs(luminance - luminanceDown);
            // Boost raw edge contrast heavily to extract faint patterns
            const edge = (edgeX + edgeY) * 2.0; 

            // Much lower threshold to pick up micro-contrast of blurry skin
            const intensity = edge > 3 ? Math.min(255, edge * 15) : 0;

            // Map to Digital Alchemist Gold
            out[idx] = intensity;           // R
            out[idx+1] = intensity * 0.8;   // G
            out[idx+2] = intensity * 0.2;   // B
            out[idx+3] = intensity > 0 ? 255 : 0; // Alpha
          }
        }
        
        ctx.putImageData(outputData, 0, 0);
      }

      animationFrameId.current = requestAnimationFrame(processFrame);
    };

    processFrame();
  };

  const captureImage = () => {
    if (status !== 'camera_ready' || !processingCanvasRef.current || !videoRef.current) return;

    setErrorMessage('');

    // --- Quality Check Phase ---
    const SIZE = 256;
    const canvas = processingCanvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    const imageData = ctx.getImageData(0, 0, SIZE, SIZE);
    const data = imageData.data;
    
    let significantEdges = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 50) significantEdges++; // Count energetic pixels
    }
    
    // We expect at least ~0.7% of the frame to have trackable contrast/edges. 
    // If it's a completely black void or flat white wall, reject it.
    if (significantEdges < (SIZE * SIZE) * 0.007) {
       setErrorMessage('Image quality too low. Pattern lacks detail. Please ensure your finger covers the lens with sufficient lighting and try again.');
       return; // Abort transition to 'scanning', remain in 'camera_ready'
    }


    // --- Composite Final Captured Image Phase ---
    // Instead of a transparent PNG with just edges, composite the video under the edges for a great visual
    const video = videoRef.current;
    const finalCanvas = document.createElement('canvas');
    finalCanvas.width = video.videoWidth || 640;
    finalCanvas.height = video.videoHeight || 640;
    const fCtx = finalCanvas.getContext('2d');
    
    if (fCtx) {
      // Mirror context so final saved export matches the screen display
      fCtx.translate(finalCanvas.width, 0);
      fCtx.scale(-1, 1);

      // Draw the raw video frame stylized as monochromatic/stylized background
      fCtx.filter = 'grayscale(80%) contrast(150%) brightness(50%)';
      
      const minDimX = Math.min(video.videoWidth, video.videoHeight);
      const startXX = (video.videoWidth - minDimX) / 2;
      const startYY = (video.videoHeight - minDimX) / 2;
      
      // Draw a square crop to match viewport
      fCtx.drawImage(video, startXX, startYY, minDimX, minDimX, 0, 0, finalCanvas.width, finalCanvas.height);

      // Overlay the rich processed Gold ridges on top
      fCtx.filter = 'none';
      fCtx.globalCompositeOperation = 'screen';
      fCtx.drawImage(processingCanvasRef.current, 0, 0, finalCanvas.width, finalCanvas.height);
      
      setCapturedImage(finalCanvas.toDataURL('image/png', 0.9));
    }

    // --- Transition to Scanning Status ---
    video.pause(); // Freeze the live feed to simulate snapshot processing
    setStatus('scanning');

    // After scanning concludes, finalize and stop resources
    setTimeout(() => {
      setStatus('complete');
      if (videoRef.current?.srcObject) {
        const stream = videoRef.current.srcObject as MediaStream;
        stream.getTracks().forEach((track) => track.stop());
      }
    }, 3000);
  };

  const resetScan = () => {
    setStatus('idle');
    setCapturedImage(null);
    setErrorMessage('');
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
        <div className="flex justify-between items-center w-full px-6 py-4 max-w-screen-2xl mx-auto font-headline tracking-tight">
          <div className="flex items-center gap-4">
            <span className="text-2xl font-black tracking-tighter text-primary-container border-2 border-primary-container px-3 py-1 rounded-sm shadow-[0_0_15px_rgba(255,204,0,0.2)]">
              FINGASCAN
            </span>
          </div>
          <nav className="hidden md:flex items-center gap-6">
            <div className="flex items-center gap-2">
              <button
                aria-label="code"
                className="w-10 h-10 rounded-full flex items-center justify-center text-on-surface opacity-70 hover:text-primary hover:drop-shadow-[0_0_10px_rgba(255,204,0,0.5)] transition-all active:scale-95 duration-200 glass-panel border border-outline-variant/20"
              >
                <Code className="w-5 h-5" />
              </button>
            </div>
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
              <h2 className="font-headline text-3xl font-bold tracking-tight text-on-surface mb-2">
                Initialize Sequence
              </h2>
              <p className="font-body text-sm sm:text-base text-on-surface-variant tracking-[0.01em]">
                {status === 'camera_ready' 
                  ? "Hold your finger 2-4 inches from the camera for focus, or press tightly for an abstract read." 
                  : "Start the sequence to enable real-time tracking."}
              </p>
              <div className="absolute left-0 top-1/2 w-8 sm:w-12 h-px bg-surface-high -translate-y-1/2"></div>
              <div className="absolute right-0 top-1/2 w-8 sm:w-12 h-px bg-surface-high -translate-y-1/2"></div>
            </div>

            {/* Scanner Viewport */}
            <div className="relative w-72 h-72 sm:w-80 sm:h-80  rounded-3xl bg-surface-lowest flex items-center justify-center p-2 scanner-glow outline outline-outline-variant/20 overflow-hidden group">
              <div className="absolute inset-0 rounded-3xl glass-panel z-10 pointer-events-none"></div>
              
              <div className="relative w-full h-full rounded-[1.25rem] bg-surface overflow-hidden border-2 border-primary-container/30">
                {/* Physical video feed - Visible now, so user sees their camera */}
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className={`absolute inset-0 w-full h-full object-cover transition-all duration-300 ${
                    status === 'camera_ready' ? 'opacity-80 saturate-50' : 
                    status === 'scanning' ? 'opacity-40 grayscale sepia hue-rotate-15 contrast-125 saturate-50 mix-blend-screen' : 'opacity-0'
                  }`}
                  style={{ transform: 'scaleX(-1)' }} // Mirroring looks more natural
                />
                
                {/* The Real-Time Processed CV Edge output overlaid dynamically */}
                <canvas 
                  ref={processingCanvasRef}
                  className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-300 mix-blend-screen ${
                    status === 'camera_ready' || status === 'scanning' || status === 'complete' ? 'opacity-100' : 'opacity-0'
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
            <div className="w-full max-w-70 mt-4 flex flex-col items-center">
              {errorMessage && (
                <div className="w-full mb-4 px-4 py-3 rounded-lg border border-error/50 bg-error/10 text-error flex gap-2 items-start opacity-100 shadow-[0_0_15px_rgba(255,180,171,0.15)] animate-in fade-in slide-in-from-bottom-2">
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span className="text-[11px] leading-relaxed font-body">{errorMessage}</span>
                </div>
              )}

              <button
                onClick={
                  (status === 'idle' || status === 'error' && !errorMessage.includes('quality'))
                    ? initializeCamera
                    : captureImage
                }
                disabled={status === 'initializing' || status === 'scanning' || status === 'complete'}
                className={`gold-gradient text-on-primary-container font-headline font-bold text-lg px-8 py-4 rounded-full flex items-center gap-3 transition-all duration-200 btn-hover-glow w-full justify-center shadow-lg 
                  ${(status === 'initializing' || status === 'scanning' || status === 'complete') 
                    ? 'opacity-80 scale-95 cursor-not-allowed grayscale-[0.2]' 
                    : 'active:scale-95'}`}
              >
                {status === 'initializing' && (
                  <><Loader2 className="w-6 h-6 animate-spin" /><span>Starting...</span></>
                )}
                {(status === 'idle' || (status === 'error' && !errorMessage.includes('quality'))) && (
                  <><Camera className="w-6 h-6" /><span>Start Sequence</span></>
                )}
                {(status === 'camera_ready' || (status === 'error' && errorMessage.includes('quality'))) && (
                   <><Aperture className="w-6 h-6 animate-pulse" /><span>Capture Frame</span></>
                )}
                {status === 'scanning' && (
                  <><Loader2 className="w-6 h-6 animate-spin" /><span>Extracting</span></>
                )}
                {status === 'complete' && (
                  <><Fingerprint className="w-6 h-6" /><span>Captured</span></>
                )}
              </button>
              
              <div className="label-text text-[10px] text-primary-container opacity-60 mt-6 text-center h-4 tracking-[0.2em] font-semibold">
                STATUS: {
                  status === 'idle' ? 'AWAITING_CAMERA' :
                  (status === 'error' && !errorMessage.includes('quality')) ? 'CONNECTION_FAILED' :
                  (status === 'camera_ready' || (status === 'error' && errorMessage.includes('quality'))) ? 'READY_FOR_LENS_INPUT' : 
                  status === 'scanning' ? 'EXTRACTING_PATTERN' : 
                  status === 'complete' ? 'VERIFIED' : 'CONNECTING_LENS'
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
                      <h3 className="font-headline text-4xl sm:text-5xl font-extrabold text-primary-container tracking-tighter leading-none uppercase drop-shadow-sm">
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
