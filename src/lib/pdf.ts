import path from "node:path";
import { pathToFileURL } from "node:url";

export function getStandardFontDataUrl(): string {
  const fontPath = path.join(
    process.cwd(),
    "node_modules",
    "pdfjs-dist",
    "standard_fonts"
  );
  return `${pathToFileURL(fontPath).toString()}/`;
}
