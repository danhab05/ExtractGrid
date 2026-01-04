import DOMMatrix from "dommatrix";

const globalAny = globalThis as typeof globalThis & {
  DOMMatrix?: typeof DOMMatrix;
  ImageData?: unknown;
  Path2D?: unknown;
};

export async function loadPdfJs() {
  if (!globalAny.DOMMatrix) {
    globalAny.DOMMatrix = DOMMatrix;
  }
  if (!globalAny.ImageData) {
    const ImageDataPolyfill = class ImageData {
      data: Uint8ClampedArray;
      width: number;
      height: number;
      constructor(
        data: Uint8ClampedArray,
        width: number,
        height: number
      ) {
        this.data = data;
        this.width = width;
        this.height = height;
      }
    };
    globalAny.ImageData = ImageDataPolyfill as unknown as typeof ImageData;
  }
  if (!globalAny.Path2D) {
    const Path2DPolyfill = class Path2D {};
    globalAny.Path2D = Path2DPolyfill as unknown as typeof Path2D;
  }
  return import("pdfjs-dist/legacy/build/pdf.mjs");
}
