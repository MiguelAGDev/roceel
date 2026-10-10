// Lector Code 128 con la cámara del celular (contrato §5: todas las etiquetas son Code 128).
// - Dos motores: BarcodeDetector cuando el navegador lo trae con Code 128 (Chrome en Android) y ZXing en
//   WebAssembly. Si el nativo no ve nada, se intercala ZXing (en Android el nativo depende de Google Play
//   Services y puede fallar sin avisar). Safari en iOS no tiene BarcodeDetector: ahí va solo ZXing.
//   El .wasm viaja dentro del build: sin CDN en la demo.
// - Se analiza solo la zona alrededor de la mira, a resolución completa: más píxeles por barra.
// - Enfoque continuo cuando la cámara lo permite (sin eso, muchas se quedan enfocadas al infinito).
// - Toma el código más cercano al centro (en la hoja de etiquetas hay varios juntos) y confirma cuando
//   el mismo texto sale en 2 de los últimos 5 cuadros.
// - Zoom y linterna si la cámara los ofrece; pitido y vibración al confirmar.
// - Emite el texto CRUDO: los SKU traen espacios, puntos, comas y diagonales.
import { useEffect, useRef, useState } from "react";
import zxingWasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";
import { IconFlash, IconZoom } from "./icons";
import { aimCrop, createConfirmer, pickCentered, type Detection } from "./scanLogic";

type Detect = (source: HTMLCanvasElement) => Promise<Detection[]>;
type Engine = { name: string; detect: Detect };

interface NativeDetector {
  detect(source: CanvasImageSource): Promise<{ rawValue: string; boundingBox: DOMRectReadOnly }[]>;
}
interface NativeDetectorCtor {
  new (opts: { formats: string[] }): NativeDetector;
  getSupportedFormats(): Promise<string[]>;
}

const FRAME_MS = 100;
const COOLDOWN_MS = 1500;
const MAX_CROP_WIDTH = 1600; // zona analizada; más ancho solo cuesta tiempo
const NATIVE_GRACE_MS = 1500; // sin lecturas del nativo por este tiempo → se intercala ZXing

async function nativeEngine(): Promise<Engine | null> {
  const Native = (window as unknown as { BarcodeDetector?: NativeDetectorCtor }).BarcodeDetector;
  if (!Native) return null;
  try {
    if (!(await Native.getSupportedFormats()).includes("code_128")) return null;
    const detector = new Native({ formats: ["code_128"] });
    return {
      name: "nativo",
      detect: async (canvas) =>
        (await detector.detect(canvas)).map((b) => ({
          text: b.rawValue,
          cx: b.boundingBox.x + b.boundingBox.width / 2,
          cy: b.boundingBox.y + b.boundingBox.height / 2,
        })),
    };
  } catch {
    return null;
  }
}

async function zxingEngine(): Promise<Engine> {
  const zxing = await import("zxing-wasm/reader");
  zxing.prepareZXingModule({
    overrides: { locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? zxingWasmUrl : prefix + path) },
  });
  return {
    name: "ZXing",
    detect: async (canvas) => {
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const results = await zxing.readBarcodes(image, { formats: ["Code128"], tryHarder: true, maxNumberOfSymbols: 8 });
      return results
        .filter((r) => r.isValid)
        .map((r) => {
          const p = r.position;
          return {
            text: r.text,
            cx: (p.topLeft.x + p.topRight.x + p.bottomLeft.x + p.bottomRight.x) / 4,
            cy: (p.topLeft.y + p.topRight.y + p.bottomLeft.y + p.bottomRight.y) / 4,
          };
        });
    },
  };
}

// Pitido corto con WebAudio. El navegador solo deja sonar audio tras un toque del usuario:
// el contexto se crea/reanuda con el primer toque en la página.
let audio: AudioContext | null = null;
function unlockAudio() {
  try {
    audio ??= new AudioContext();
    if (audio.state === "suspended") void audio.resume();
  } catch {
    /* sin audio */
  }
}
function beep() {
  try {
    if (!audio || audio.state !== "running") return;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = 1760;
    gain.gain.setValueAtTime(0.15, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.12);
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.12);
  } catch {
    /* sin audio */
  }
}

type ZoomCaps = { min: number; max: number; step?: number };
type ExtraCaps = MediaTrackCapabilities & { zoom?: ZoomCaps; torch?: boolean; focusMode?: string[] };

function cameraError(err: unknown): string {
  if (!window.isSecureContext) {
    return "La cámara necesita HTTPS. Abre esta página por https://<ip-de-la-pc>:8443/ui/ o teclea el código abajo.";
  }
  const name = (err as Error)?.name;
  if (name === "NotAllowedError") return "No se dio permiso para usar la cámara. Actívalo en el navegador o teclea el código abajo.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No se encontró una cámara. Teclea el código abajo.";
  if (name === "NotReadableError") return "Otra app está usando la cámara. Ciérrala o teclea el código abajo.";
  return "No se pudo abrir la cámara. Teclea el código abajo.";
}

export default function Scanner({ onScan, paused = false }: { onScan: (text: string) => void; paused?: boolean }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const trackRef = useRef<MediaStreamTrack | null>(null);

  const [message, setMessage] = useState<string | null>("Abriendo cámara…");
  const [status, setStatus] = useState("");
  const [seen, setSeen] = useState<string | null>(null);
  const [hit, setHit] = useState(false);
  const [zoomCaps, setZoomCaps] = useState<ZoomCaps | null>(null);
  const [zoom, setZoom] = useState(1);
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torch, setTorch] = useState(false);
  const [visible, setVisible] = useState(document.visibilityState === "visible");

  useEffect(() => {
    const onVis = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVis);
    document.addEventListener("pointerdown", unlockAudio, { once: true });
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // Cámara: se abre al montar y se libera al desmontar o al ocultar la pestaña.
  useEffect(() => {
    if (!visible) return;
    let stopped = false;
    let stream: MediaStream | null = null;
    let timer: number | undefined;
    const canvas = document.createElement("canvas");
    const confirmer = createConfirmer(2, 5);
    let lastText = "";
    let lastAt = 0;

    async function start() {
      setMessage("Abriendo cámara…");
      if (!navigator.mediaDevices?.getUserMedia) {
        setMessage(cameraError(null));
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        });
      } catch (err) {
        setMessage(cameraError(err));
        return;
      }
      if (stopped) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const video = videoRef.current!;
      video.muted = true; // iOS solo reproduce en línea sin gesto si el video está mudo
      video.srcObject = stream;
      await video.play().catch(() => undefined);

      const track = stream.getVideoTracks()[0];
      trackRef.current = track;
      const caps = (track.getCapabilities?.() ?? {}) as ExtraCaps;
      setZoomCaps(caps.zoom && caps.zoom.max > caps.zoom.min ? caps.zoom : null);
      setTorchAvailable(Boolean(caps.torch));
      setZoom(1);
      setTorch(false);
      // Sin esto, muchas cámaras de Android se quedan enfocadas al infinito y la etiqueta de cerca sale borrosa.
      if (caps.focusMode?.includes("continuous")) {
        await track.applyConstraints({ advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet] }).catch(() => undefined);
      }

      let native: Engine | null = null;
      let zxing: Engine | null = null;
      try {
        native = await nativeEngine();
        zxing = native ? null : await zxingEngine();
      } catch {
        if (!native) {
          setMessage("No se pudo cargar el lector. Teclea el código abajo.");
          return;
        }
      }
      // Con nativo, ZXing se carga aparte (de respaldo) sin retrasar el arranque.
      if (native) zxingEngine().then((z) => { zxing = z; }, () => undefined);
      setMessage(null);

      let frame = 0;
      let lastNativeHit = Date.now();
      let lastStatus = "";

      const loop = async () => {
        if (stopped) return;
        const box = boxRef.current;
        if (!pausedRef.current && box && video.readyState >= 2 && video.videoWidth) {
          // Zona de la mira, en coordenadas del cuadro de video.
          const crop = aimCrop(video.videoWidth, video.videoHeight, box.clientWidth, box.clientHeight);
          const scale = Math.min(1, MAX_CROP_WIDTH / crop.sw);
          canvas.width = Math.max(1, Math.round(crop.sw * scale));
          canvas.height = Math.max(1, Math.round(crop.sh * scale));
          canvas.getContext("2d", { willReadFrequently: true })!
            .drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, canvas.width, canvas.height);

          // Nativo en cada cuadro; si lleva rato sin ver nada, cada tercer cuadro va con ZXing.
          frame++;
          const useZxing = !native || (zxing && Date.now() - lastNativeHit > NATIVE_GRACE_MS && frame % 3 === 0);
          const engine = useZxing ? zxing : native;
          const engines = native && zxing ? "nativo + ZXing" : native ? "nativo" : "ZXing";
          const s = `${video.videoWidth}×${video.videoHeight} · ${engines}`;
          if (s !== lastStatus) {
            lastStatus = s;
            setStatus(s);
          }
          if (engine) {
            try {
              const found = await engine.detect(canvas);
              if (engine === native && found.length) lastNativeHit = Date.now();
              const best = pickCentered(found, canvas.width, canvas.height);
              if (best) setSeen(best.text);
              const confirmed = confirmer.push(best?.text ?? null);
              const now = Date.now();
              // Pausa corta tras cada lectura, y más larga si es la misma etiqueta (sigue frente a la cámara).
              const fresh = confirmed !== lastText || now - lastAt > COOLDOWN_MS * 2;
              if (confirmed && fresh && now - lastAt > COOLDOWN_MS) {
                lastText = confirmed;
                lastAt = now;
                beep();
                navigator.vibrate?.(60);
                setHit(true);
                window.setTimeout(() => setHit(false), 400);
                onScanRef.current(confirmed);
              }
            } catch {
              /* un cuadro fallido no detiene el lector */
            }
          }
        }
        timer = window.setTimeout(loop, FRAME_MS);
      };
      void loop();
    }

    void start();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
      trackRef.current = null;
    };
  }, [visible]);

  async function applyZoom(next: number) {
    setZoom(next);
    try {
      await trackRef.current?.applyConstraints({ advanced: [{ zoom: next } as MediaTrackConstraintSet] });
    } catch {
      /* la cámara no lo permitió */
    }
  }

  async function toggleTorch() {
    const next = !torch;
    setTorch(next);
    try {
      await trackRef.current?.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
    } catch {
      setTorch(!next);
    }
  }

  // Zoom en pasos 1× → 2× → 3× (dentro de lo que permita la cámara) → 1×.
  const nextZoom = zoomCaps ? (zoom + 1 > Math.min(zoomCaps.max, 3) ? Math.max(zoomCaps.min, 1) : zoom + 1) : 1;

  return (
    <div>
      <div ref={boxRef} className={`scanner${hit ? " hit" : ""}`}>
        <video ref={videoRef} muted playsInline autoPlay aria-label="Vista de la cámara para escanear" />
        {message ? <div className="scanner-msg" role="status">{message}</div> : <div className="aim" aria-hidden="true" />}
        {!message && (
          <div className="scanner-tools">
            {zoomCaps && (
              <button type="button" className="btn" onClick={() => applyZoom(nextZoom)} aria-label={`Zoom ${zoom}×`}>
                <IconZoom />{zoom}×
              </button>
            )}
            {torchAvailable && (
              <button type="button" className="btn" onClick={toggleTorch} aria-pressed={torch} aria-label="Linterna">
                <IconFlash />
              </button>
            )}
          </div>
        )}
      </div>
      {/* Estado del lector: ayuda a saber si la cámara lee algo (y qué) cuando no avanza. */}
      {!message && (
        <div className="hint scanner-status">
          {seen ? <>Leído: <span className="tag">{seen}</span></> : "Centra la etiqueta en el recuadro, a unos 15 cm"}
          <span className="muted"> · {status}</span>
        </div>
      )}
    </div>
  );
}
