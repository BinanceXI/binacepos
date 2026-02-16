import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Camera, Flashlight, FlashlightOff, RefreshCw, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useZxing } from "react-zxing";
import { toast } from "sonner";

interface BarcodeScannerProps {
  isOpen: boolean;
  onClose: () => void;
  onScan: (barcode: string) => void;
}

type CameraGateState = "requesting" | "ready" | "denied" | "error";

const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  video: {
    facingMode: { ideal: "environment" },
    width: { ideal: 1280 },
    height: { ideal: 720 },
  },
  audio: false,
};

function stopVideoStream(video: HTMLVideoElement | null) {
  try {
    const stream = (video?.srcObject || null) as MediaStream | null;
    stream?.getTracks?.().forEach((t) => t.stop());
    if (video) video.srcObject = null;
  } catch {
    // ignore
  }
}

function explainCameraError(err: any) {
  const name = String(err?.name || "UnknownError");
  if (name === "NotAllowedError" || name === "SecurityError") {
    return {
      state: "denied" as const,
      title: "Camera permission denied",
      message:
        "Allow Camera permission, then tap Retry. On Android: Settings → Apps → BinanceXI POS → Permissions → Camera → Allow.",
    };
  }
  if (name === "NotFoundError") {
    return { state: "error" as const, title: "No camera found", message: "No camera was detected on this device." };
  }
  if (name === "NotReadableError") {
    return {
      state: "error" as const,
      title: "Camera busy",
      message: "Camera is in use by another app. Close other camera apps and tap Restart.",
    };
  }
  if (name === "OverconstrainedError") {
    return {
      state: "error" as const,
      title: "Camera not supported",
      message: "This device does not support the requested camera constraints. Try Restart.",
    };
  }
  return { state: "error" as const, title: "Camera error", message: err?.message || name };
}

async function probeCameraPermission(): Promise<{ ok: true } | { ok: false; error: any }> {
  if (!navigator?.mediaDevices?.getUserMedia) return { ok: false, error: { name: "NotSupportedError" } };
  try {
    const stream = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);
    stream.getTracks().forEach((t) => t.stop());
    return { ok: true };
  } catch (error: any) {
    return { ok: false, error };
  }
}

function playBeep() {
  try {
    const audio = new Audio("/beep.mp3");
    audio.play().catch(() => {});
  } catch {
    // ignore
  }
}

function ScannerSurface({
  onScan,
  onCameraError,
  scanDedupe,
}: {
  onScan: (code: string) => void;
  onCameraError: (error: any) => void;
  scanDedupe: { last: MutableRefObject<string>; at: MutableRefObject<number> };
}) {
  const { ref, torch } = useZxing({
    constraints: CAMERA_CONSTRAINTS,
    timeBetweenDecodingAttempts: 160,
    onDecodeResult(result) {
      const code = String(result?.getText?.() || "").trim();
      if (!code) return;

      const now = Date.now();
      const last = scanDedupe.last.current;
      const lastAt = scanDedupe.at.current;
      if (code === last && now - lastAt < 1500) return;

      scanDedupe.last.current = code;
      scanDedupe.at.current = now;

      playBeep();
      onScan(code);
    },
    onError(error) {
      onCameraError(error);
    },
    onDecodeError() {
      // ignore decode failures; keep scanning
    },
  });

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    video.setAttribute("playsinline", "true");
    video.muted = true;
    video.autoplay = true;
    const onMeta = () => video.play().catch(() => {});
    video.addEventListener("loadedmetadata", onMeta);
    return () => {
      video.removeEventListener("loadedmetadata", onMeta);
      stopVideoStream(video);
    };
  }, [ref]);

  const toggleFlash = async () => {
    if (!torch.isAvailable) {
      toast.message("Flashlight not available on this device");
      return;
    }
    try {
      if (torch.isOn) await torch.off();
      else await torch.on();
    } catch (e: any) {
      toast.error(e?.message || "Failed to toggle flashlight");
    }
  };

  return (
    <>
      <video ref={ref} className="w-full h-full object-cover" />

      {/* SCANNING OVERLAY */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="relative w-64 h-40 border-2 border-white/50 rounded-lg shadow-[0_0_0_9999px_rgba(0,0,0,0.5)]">
          {/* Corner Markers */}
          <div className="absolute -top-0.5 -left-0.5 w-6 h-6 border-t-4 border-l-4 border-blue-500 rounded-tl-lg" />
          <div className="absolute -top-0.5 -right-0.5 w-6 h-6 border-t-4 border-r-4 border-blue-500 rounded-tr-lg" />
          <div className="absolute -bottom-0.5 -left-0.5 w-6 h-6 border-b-4 border-l-4 border-blue-500 rounded-bl-lg" />
          <div className="absolute -bottom-0.5 -right-0.5 w-6 h-6 border-b-4 border-r-4 border-blue-500 rounded-br-lg" />

          {/* Laser Line */}
          <AnimatePresence>
            <motion.div
              initial={{ top: "10%", opacity: 0 }}
              animate={{ top: ["10%", "90%", "10%"], opacity: 1 }}
              transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
              className="absolute left-2 right-2 h-0.5 bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.8)]"
            />
          </AnimatePresence>
        </div>
      </div>

      {/* Flashlight Control */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-20">
        <Button
          variant="outline"
          size="icon"
          onClick={toggleFlash}
          disabled={!torch.isAvailable}
          className="rounded-full h-12 w-12 bg-white/10 border-white/20 hover:bg-white/20 text-white backdrop-blur-md"
          title={torch.isAvailable ? "Toggle flashlight" : "Flashlight not available"}
        >
          {torch.isOn ? <FlashlightOff className="w-6 h-6" /> : <Flashlight className="w-6 h-6" />}
        </Button>
      </div>
    </>
  );
}

export const BarcodeScanner = ({ isOpen, onClose, onScan }: BarcodeScannerProps) => {
  const [gate, setGate] = useState<{
    state: CameraGateState;
    title?: string;
    message?: string;
  }>({ state: "requesting" });

  const [scannerKey, setScannerKey] = useState(0);

  const lastScannedRef = useRef<string>("");
  const lastScanAtRef = useRef<number>(0);

  const scanDedupe = useMemo(() => ({ last: lastScannedRef, at: lastScanAtRef }), []);

  const restart = useCallback(() => {
    lastScannedRef.current = "";
    lastScanAtRef.current = 0;
    setScannerKey((k) => k + 1);
  }, []);

  const requestAndStart = useCallback(async () => {
    setGate({ state: "requesting" });
    const res = await probeCameraPermission();
    if (res.ok) {
      setGate({ state: "ready" });
      restart();
      return;
    }
    const info = explainCameraError("error" in res ? res.error : null);
    setGate({ state: info.state, title: info.title, message: info.message });
  }, [restart]);

  useEffect(() => {
    if (!isOpen) return;
    requestAndStart();
  }, [isOpen, requestAndStart]);

  // Fix "black camera" after background/foreground: restart when app becomes visible again.
  useEffect(() => {
    if (!isOpen) return;
    const onVis = () => {
      if (document.hidden) {
        // Unmount ScannerSurface so the camera track is released.
        setGate({ state: "requesting" });
        return;
      }
      requestAndStart();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [isOpen, requestAndStart]);

  if (!isOpen) return null;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md p-0 overflow-hidden bg-black border-slate-800">
        <DialogHeader className="p-4 pb-2 bg-slate-900/80 backdrop-blur-sm absolute top-0 left-0 right-0 z-10">
          <DialogTitle className="flex items-center gap-2 text-white">
            <Camera className="w-5 h-5" />
            Scan Product
          </DialogTitle>
        </DialogHeader>
        
        <div className="relative aspect-[4/3] bg-black overflow-hidden">
          {gate.state === "ready" ? (
            <ScannerSurface
              key={scannerKey}
              scanDedupe={scanDedupe}
              onScan={onScan}
              onCameraError={(e) => {
                const info = explainCameraError(e);
                setGate({ state: info.state, title: info.title, message: info.message });
                toast.error(info.title);
              }}
            />
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-6">
              <div className="mb-3 inline-flex items-center justify-center rounded-full bg-white/10 border border-white/20 w-12 h-12 text-white">
                <ShieldAlert className="w-6 h-6" />
              </div>
              <div className="text-white font-semibold">{gate.title || "Camera required"}</div>
              <div className="text-xs text-slate-300 mt-1 max-w-sm">
                {gate.message || "Please allow camera access to scan barcodes."}
              </div>

              <div className="mt-4 flex gap-2">
                <Button variant="secondary" onClick={requestAndStart} className="gap-2">
                  <RefreshCw className="w-4 h-4" /> {gate.state === "requesting" ? "Requesting…" : "Retry"}
                </Button>
                <Button variant="outline" onClick={onClose} className="bg-transparent text-white border-white/20 hover:bg-white/10">
                  Close
                </Button>
              </div>
            </div>
          )}
        </div>

        <div className="p-4 bg-slate-900 text-center">
          <p className="text-sm text-slate-400 mb-4">
            Point camera at a barcode to scan.
          </p>
          <Button variant="secondary" onClick={onClose} className="w-full">
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
