import { NextResponse } from "next/server";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import { parserRegistry } from "@/lib/parsers";
import { getStandardFontDataUrl } from "@/lib/pdf";

const MAX_FILE_SIZE = 15 * 1024 * 1024;

export const runtime = "nodejs";

async function extractPdfText(buffer: Buffer): Promise<string> {
  const workerPath = path.join(
    process.cwd(),
    "node_modules",
    "pdfjs-dist",
    "legacy",
    "build",
    "pdf.worker.min.mjs"
  );
  GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).toString();

  const loadingTask = getDocument({
    data: new Uint8Array(buffer),
    standardFontDataUrl: getStandardFontDataUrl(),
  });
  const pdf = await loadingTask.promise;
  let text = "";
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    text += content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join("");
    text += "\n";
    page.cleanup();
  }
  return text;
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { error: "Fichier manquant." },
        { status: 400 }
      );
    }

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: "Fichier trop volumineux (max 15MB)." },
        { status: 400 }
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const pdfText = await extractPdfText(buffer);

    const detected =
      Object.values(parserRegistry).find(
        (parser) => parser.detect && parser.detect(pdfText)
      )?.bankId ?? null;

    return NextResponse.json({ bankId: detected });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Erreur inconnue.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
