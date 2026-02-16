// File: src/lib/imageCompress.ts
export type CompressOptions = {
    targetBytes?: number; // default 800KB
    maxDimension?: number; // default 1400px
    initialQuality?: number; // default 0.82
    minQuality?: number; // default 0.55
    step?: number; // default 0.07
    preferWebp?: boolean; // default true
  };
  
  function clamp(n: number, a: number, b: number) {
    return Math.max(a, Math.min(b, n));
  }
  
  function pickOutputType(inputType: string, preferWebp: boolean) {
    if (preferWebp && inputType !== "image/gif") return "image/webp";
    return "image/jpeg";
  }
  
  async function fileToImageBitmap(file: File): Promise<ImageBitmap> {
    return await createImageBitmap(file);
  }
  
  function drawToCanvas(img: ImageBitmap, maxDim: number) {
    const w = img.width;
    const h = img.height;
  
    const scale = Math.min(1, maxDim / Math.max(w, h));
    const outW = Math.max(1, Math.round(w * scale));
    const outH = Math.max(1, Math.round(h * scale));
  
    const canvas = document.createElement("canvas");
    canvas.width = outW;
    canvas.height = outH;
  
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas not supported");
  
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, outW, outH);
  
    return canvas;
  }
  
  function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number) {
    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("Image encode failed"))),
        type,
        quality
      );
    });
  }
  
  export async function compressImageFile(file: File, opts: CompressOptions = {}) {
    const {
      targetBytes = 800 * 1024,
      maxDimension = 1400,
      initialQuality = 0.82,
      minQuality = 0.55,
      step = 0.07,
      preferWebp = true,
    } = opts;
  
    // Don’t compress GIFs (animated)
    if (file.type === "image/gif") {
      return { blob: file as unknown as Blob, contentType: file.type };
    }
  
    const img = await fileToImageBitmap(file);
    const canvas = drawToCanvas(img, maxDimension);
  
    const outType = pickOutputType(file.type, preferWebp);
  
    let q = clamp(initialQuality, minQuality, 0.95);
    let best: Blob | null = null;
  
    while (q >= minQuality) {
      const b = await canvasToBlob(canvas, outType, q);
      best = b;
  
      if (b.size <= targetBytes) break;
      q -= step;
    }
  
    if (best && best.size > targetBytes) {
      const canvas2 = drawToCanvas(img, Math.max(900, Math.round(maxDimension * 0.75)));
      const b2 = await canvasToBlob(canvas2, outType, minQuality);
      best = b2;
    }
  
    return { blob: best!, contentType: outType };
  }