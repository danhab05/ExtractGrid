import path from "node:path";
import { pathToFileURL } from "node:url";
import { getStandardFontDataUrl } from "../pdf";
import { loadPdfJs } from "../pdfjs";
import type { BankParser, Transaction } from "./types";
import { normalizeSpaces, parseAmountFR } from "./utils";

type LineItem = { text: string; x: number };
type PdfLine = { text: string; items: LineItem[] };

type PendingOperation = {
  dateOperation: Date;
  dateValeur: Date | null;
  labelParts: string[];
  amount: number;
  raw: string[];
};

const DATE_REGEX = /\d{2}\/\d{2}\/\d{4}/;
const AMOUNT_REGEX = /\d{1,3}(?:[ \u00A0.]\d{3})*,\d{2}/;

const NOISE_PATTERNS = [
  /^RELEVE ET INFORMATIONS BANCAIRES/i,
  /^CREDIT INDUSTRIEL ET COMMERCIAL/i,
  /^CIC /i,
  /^INFORMATION SUR LA PROTECTION DES COMPTES/i,
  /^VOTRE CONSEILLER/i,
  /^C\/C /i,
  /^Page \d+/i,
  /^KV\./i,
  /^IBAN/i,
  /^BIC/i,
  /^SOLDE /i,
  /^TOTAL DES MOUVEMENTS/i,
  /^TOTAL PRELEVE /i,
  /^Date Date valeur/i,
  /^Date Commerce Ville/i,
];

function parseDateFRLong(token: string): Date {
  const [day, month, year] = token.split("/").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function isNoiseLine(text: string): boolean {
  return NOISE_PATTERNS.some((pattern) => pattern.test(text));
}

function findAmountItem(items: LineItem[]): LineItem | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const candidate = items[i];
    if (AMOUNT_REGEX.test(candidate.text.trim())) {
      return candidate;
    }
  }
  return null;
}

function extractLabel(
  items: LineItem[],
  amountItem: LineItem,
  fallbackText: string
): string {
  const dateItems = items.filter((item) => DATE_REGEX.test(item.text.trim()));
  if (dateItems.length >= 2) {
    const secondDate = dateItems[1];
    const labelItems = items.filter(
      (item) =>
        item.x > secondDate.x + 1 &&
        item.x < amountItem.x - 1 &&
        item.text.trim() !== ""
    );
    if (labelItems.length > 0) {
      return normalizeSpaces(labelItems.map((item) => item.text).join(" "));
    }
  }

  const withoutDates = fallbackText.replace(DATE_REGEX, "").replace(DATE_REGEX, "");
  const withoutAmount = withoutDates.replace(AMOUNT_REGEX, "");
  return normalizeSpaces(withoutAmount);
}

async function extractLinesFromPdf(buffer: Buffer): Promise<PdfLine[]> {
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
    data: new Uint8Array(buffer),
    standardFontDataUrl: getStandardFontDataUrl(),
  });
  const pdf = await loadingTask.promise;
  const lines: PdfLine[] = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const lineMap = new Map<number, LineItem[]>();

    for (const item of content.items) {
      if (!("str" in item)) continue;
      const [x, y] = viewport.convertToViewportPoint(
        item.transform[4],
        item.transform[5]
      );
      const yKey = Math.round(y / 2) * 2;
      const bucket = lineMap.get(yKey) ?? [];
      bucket.push({ text: item.str, x });
      lineMap.set(yKey, bucket);
    }

    const pageLines = [...lineMap.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([, items]) => {
        const sorted = items.sort((a, b) => a.x - b.x);
        const text = normalizeSpaces(sorted.map((it) => it.text).join(" "));
        return { text, items: sorted };
      })
      .filter((line) => line.text.length > 0);

    lines.push(...pageLines);
    page.cleanup();
  }

  return lines;
}

export const cicParser: BankParser = {
  bankId: "cic",
  detect: (pdfText) =>
    pdfText.toUpperCase().includes("CREDIT INDUSTRIEL ET COMMERCIAL") ||
    pdfText.toUpperCase().includes("CIC"),
  async parse(input) {
    if (typeof input === "string") {
      throw new Error("Le parsing CIC requiert le PDF brut.");
    }

    const lines = await extractLinesFromPdf(input);
    const transactions: Transaction[] = [];
    let currentOperation: PendingOperation | null = null;
    let debitX: number | null = null;
    let creditX: number | null = null;
    let inCardSection = false;

    const flush = () => {
      if (!currentOperation) return;
      const label = normalizeSpaces(currentOperation.labelParts.join(" "));
      transactions.push({
        dateOperation: currentOperation.dateOperation,
        dateValeur: currentOperation.dateValeur,
        label,
        amount: currentOperation.amount,
        meta: {
          raw: currentOperation.raw.join(" | "),
        },
      });
      currentOperation = null;
    };

    for (const line of lines) {
      const upper = line.text.toUpperCase();

      if (upper.includes("RELEVE DE VOTRE CARTE")) {
        flush();
        inCardSection = true;
        continue;
      }

      if (upper.includes("DATE") && upper.includes("DEBIT") && upper.includes("CREDIT")) {
        const debitItem = line.items.find((item) =>
          item.text.toUpperCase().includes("DEBIT")
        );
        const creditItem = line.items.find((item) =>
          item.text.toUpperCase().includes("CREDIT")
        );
        if (debitItem && creditItem) {
          debitX = debitItem.x;
          creditX = creditItem.x;
          inCardSection = false;
        }
        continue;
      }

      if (inCardSection) {
        continue;
      }

      if (isNoiseLine(line.text)) {
        continue;
      }

      const dateMatches = [...line.text.matchAll(new RegExp(DATE_REGEX, "g"))];
      if (dateMatches.length >= 2) {
        const amountItem = findAmountItem(line.items);
        if (!amountItem) continue;
        const amount = parseAmountFR(amountItem.text);
        const midpoint =
          debitX !== null && creditX !== null ? (debitX + creditX) / 2 : 455;
        const signedAmount = amountItem.x >= midpoint ? amount : -amount;
        const label = extractLabel(line.items, amountItem, line.text);
        const dateOperation = parseDateFRLong(dateMatches[0][0]);
        const dateValeur = parseDateFRLong(dateMatches[1][0]);

        flush();
        currentOperation = {
          dateOperation,
          dateValeur,
          labelParts: [label],
          amount: signedAmount,
          raw: [line.text],
        };
        continue;
      }

      if (currentOperation && line.text.length > 0) {
        if (!isNoiseLine(line.text)) {
          currentOperation.labelParts.push(line.text);
          currentOperation.raw.push(line.text);
        }
      }
    }

    flush();

    if (transactions.length === 0) {
      throw new Error("Format PDF non reconnu CIC");
    }

    return transactions;
  },
};
