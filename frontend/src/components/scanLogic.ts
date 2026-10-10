// Lógica pura del lector (sin cámara), para poder probarla.

export interface Detection {
  text: string;
  /** Centro del código, en coordenadas del cuadro. */
  cx: number;
  cy: number;
}

/** En la hoja de etiquetas hay varias juntas: se toma la más cercana al centro del cuadro (la mira). */
export function pickCentered(detections: Detection[], width: number, height: number): Detection | null {
  let best: Detection | null = null;
  let bestDist = Infinity;
  for (const d of detections) {
    if (!d.text) continue;
    const dist = Math.hypot(d.cx - width / 2, d.cy - height / 2);
    if (dist < bestDist) {
      best = d;
      bestDist = dist;
    }
  }
  return best;
}

export interface Rect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/** Zona del cuadro de video que se analiza: la parte que el usuario ve alrededor de la mira.
 *  El video se muestra con `object-fit: cover` en un contenedor de `cw`×`ch`, así que solo una parte del
 *  cuadro (`vw`×`vh`) es visible; de esa parte se toma el centro (`fw` y `fh`: fracción de ancho y alto).
 *  Analizar solo esa zona, a resolución completa, da más píxeles por barra que reducir el cuadro entero. */
export function aimCrop(vw: number, vh: number, cw: number, ch: number, fw = 0.9, fh = 0.5): Rect {
  const scale = Math.max(cw / vw, ch / vh) || 1;
  const visW = Math.min(vw, cw / scale);
  const visH = Math.min(vh, ch / scale);
  const sw = Math.round(visW * fw);
  const sh = Math.round(visH * fh);
  return { sx: Math.round((vw - sw) / 2), sy: Math.round((vh - sh) / 2), sw, sh };
}

/** Confirma una lectura cuando el mismo texto aparece en `need` de los últimos `window` cuadros.
 *  Evita lecturas falsas de un solo cuadro movido. Tras confirmar, olvida el historial. */
export function createConfirmer(need = 2, window = 5) {
  let history: (string | null)[] = [];
  return {
    push(text: string | null): string | null {
      history = [...history, text].slice(-window);
      if (text == null) return null;
      const hits = history.filter((t) => t === text).length;
      if (hits >= need) {
        history = [];
        return text;
      }
      return null;
    },
    reset() {
      history = [];
    },
  };
}
