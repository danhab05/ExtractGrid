import path from "node:path";
import { pathToFileURL } from "node:url";
import { getStandardFontDataUrl } from "../pdf";
import { loadPdfJs } from "../pdfjs";
import type { BankParser, Transaction } from "./types";
import { normalizeSpaces, parseAmountFR } from "./utils";

function parseDateFromHeader(pdfText: string): number {
  const match = pdfText.match(/Du\s+\d{2}\/\d{2}\/(\d{4})/i);
  if (match) return Number(match[1]);
  return new Date().getUTCFullYear();
}

function parseShortDate(token: string, year: number): Date {
  const [day, month] = token.split("/").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function parseQontoText(pdfText: string): Transaction[] {
  const year = parseDateFromHeader(pdfText);
  const normalized = pdfText
    .replace(/\r/g, "\n")
    .replace(/(\d{2}\/\d{2})(?=\s)/g, "\n$1")
    .replace(/\n{2,}/g, "\n");

  const lines = normalized
    .split(/\r?\n/)
    .map(normalizeSpaces)
    .filter((line) => line.length > 0);

  const transactions: Transaction[] = [];

  for (const line of lines) {
    if (!/^\d{2}\/\d{2}\b(?!\/\d{4})/.test(line)) continue;
    if (/^ENVY DE LIVE/i.test(line)) continue;
    if (line.toUpperCase().includes("DATE DE VALEUR")) continue;

    const dateToken = line.slice(0, 5);
    const amountMatch = line.match(/([+-])\s*([\d.,]+)\s*EUR/i);
    if (!amountMatch) continue;

    const sign = amountMatch[1] === "-" ? -1 : 1;
    const amount = parseAmountFR(amountMatch[2]);
    const amountIndex = line.lastIndexOf(amountMatch[0]);
    const label = normalizeSpaces(line.slice(5, amountIndex));

    transactions.push({
      dateOperation: parseShortDate(dateToken, year),
      dateValeur: parseShortDate(dateToken, year),
      label,
      amount: amount * sign,
    });
  }

  return transactions;
}

export const qontoParser: BankParser = {
  bankId: "qonto",
  detect: (pdfText) => {
    const upper = pdfText.toUpperCase();
    return upper.includes("QONTO") || upper.includes("QNTOFRP");
  },
  async parse(input) {
    if (typeof input === "string") {
      return parseQontoText(input);
    }
    const workerPath = path.join(
      process.cwd(),
      "node_modules",
      "pdfjs-dist",
      "legacy",
      "build",
      "pdf.worker.min.mjs"
    );
    const { getDocument, GlobalWorkerOptions } = await loadPdfJs();
    GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).toString();
    const loadingTask = getDocument({
      data: new Uint8Array(input),
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
    return parseQontoText(text);
  },
};
