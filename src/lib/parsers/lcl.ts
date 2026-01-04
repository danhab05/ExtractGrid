import path from "node:path";
import { pathToFileURL } from "node:url";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import { getStandardFontDataUrl } from "../pdf";
import type { BankParser, Transaction } from "./types";
import {
  findAmountsInLine,
  normalizeSpaces,
  parseAmountFR,
  parseDateFR,
} from "./utils";

type LineItem = { text: string; x: number };
type PdfLine = { text: string; items: LineItem[] };

const IGNORE_LINE_PATTERNS = [
  /SOLDE\s+INTERMEDIAIRE/i,
  /SOLDE\s+EN\s+EUROS/i,
  /TOTAUX/i,
  /SOUS\s+TOTAL/i,
  /RELEVE\s+DE\s+COMPTE/i,
  /MONTANT\s+COMPTABILISE/i,
  /PAGE\s+\d+/i,
  /CREDIT\s+LYONNAIS/i,
  /RELEVE\s+D'IDENTITE/i,
];

const SECTION_KEYWORDS = [
  "PAIEMENTS PAR CARTE",
  "PAIEMENTS PAR CARTES",
  "CHEQUES EMIS",
  "CHEQUES",
];

function shouldIgnoreLine(line: string): boolean {
  return IGNORE_LINE_PATTERNS.some((pattern) => pattern.test(line));
}

function parseShortDate(token: string, reference: Date): Date {
  const [day, month] = token.split(/[./]/).map(Number);
  return new Date(Date.UTC(reference.getUTCFullYear(), month - 1, day));
}

function normalizeDateToken(token: string): string {
  const normalized = token.replace(/\//g, ".");
  const match = normalized.match(/^(\d{2})\.(\d{2})\.(\d{2,4})$/);
  if (!match) return normalized;
  const year = match[3].slice(-2);
  return `${match[1]}.${match[2]}.${year}`;
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

    const pageLines = Array.from(lineMap.entries())
      .sort((a, b) => b[0] - a[0])
      .map(([, items]) => {
        const ordered = items
          .filter((it) => it.text.trim().length > 0)
          .sort((a, b) => a.x - b.x);
        const text = normalizeSpaces(ordered.map((it) => it.text).join(" "));
        return { text, items: ordered };
      })
      .filter((line) => line.text.length > 0);

    lines.push(...pageLines);
    page.cleanup();
  }

  return lines;
}

function parseLclLines(lines: PdfLine[]): Transaction[] {
  let debitX: number | null = null;
  let creditX: number | null = null;
  let currentSection: string | undefined;
  const transactions: Transaction[] = [];
  let periodStart: Date | null = null;

  for (const line of lines) {
    const upper = line.text.toUpperCase();
    if (
      upper.includes("DATE") &&
      upper.includes("LIBELLE") &&
      upper.includes("VALEUR")
    ) {
      const debitItem = line.items.find((it) =>
        it.text.toUpperCase().includes("DEBIT")
      );
      const creditItem = line.items.find((it) =>
        it.text.toUpperCase().includes("CREDIT")
      );
      debitX = debitItem?.x ?? debitX;
      creditX = creditItem?.x ?? creditX;
      if (debitX !== null && creditX !== null) break;
    }
  }

  for (const line of lines) {
    const text = line.text;
    if (!text) continue;
    if (!periodStart) {
      const periodMatch = text.match(/du\s+(\d{2}[./]\d{2}[./]\d{4})/i);
      if (periodMatch) {
        const token = normalizeDateToken(periodMatch[1]);
        periodStart = parseDateFR(token);
      }
    }
    if (shouldIgnoreLine(text)) {
      continue;
    }

    const upper = text.toUpperCase();
    const sectionMatch = SECTION_KEYWORDS.find((keyword) =>
      upper.includes(keyword)
    );
    if (sectionMatch) {
      currentSection = sectionMatch;
      continue;
    }

    if (
      upper.includes("DATE") &&
      upper.includes("LIBELLE") &&
      upper.includes("VALEUR")
    ) {
      continue;
    }

    const dateOpMatch = text.match(/\b\d{2}[./]\d{2}\b/);
    const dateValueMatch = text.match(
      /\b\d{2}[./]\d{2}[./]\d{2,4}\b/
    );

    if (/ANCIEN\s+SOLDE/i.test(text)) {
      const amountMatch = text.match(
        /\d{1,3}(?:[ \u00A0]\d{3})*,\d{2}/
      );
      if (amountMatch) {
        const amount = parseAmountFR(amountMatch[0]);
        let sign = -1;
        const amountItem = line.items.find((it) =>
          it.text.includes(amountMatch[0])
        );
        if (amountItem && creditX !== null && debitX !== null) {
          sign =
            Math.abs(amountItem.x - creditX) <
            Math.abs(amountItem.x - debitX)
              ? 1
              : -1;
        }
        const fallbackDate = periodStart ?? new Date();
        const dateOpToken = dateOpMatch?.[0]?.replace(/\//g, ".");
        const dateOperation = dateOpToken
          ? parseShortDate(dateOpToken, fallbackDate)
          : fallbackDate;
        transactions.push({
          dateOperation,
          dateValeur: dateOperation,
          label: "ANCIEN SOLDE",
          amount: amount * sign,
          meta: { raw: text, section: currentSection },
        });
      }
      continue;
    }

    if (!dateOpMatch || !dateValueMatch) {
      continue;
    }

    const valueToken = normalizeDateToken(dateValueMatch[0]);
    const valueDate = parseDateFR(valueToken);
    const operationDate = parseShortDate(
      dateOpMatch[0].replace(/\//g, "."),
      valueDate
    );

    const amountItems = line.items.filter((it) =>
      /\d{1,3}(?:[ \u00A0]\d{3})*,\d{2}/.test(it.text)
    );
    const amountText = amountItems.map((it) => it.text).join(" ");
    const amounts = findAmountsInLine(amountText);

    let amountValue: number | null = null;
    if (amounts.length > 0) {
      const amount = parseAmountFR(amounts[amounts.length - 1]);
      let sign = 1;
      const amountItem = amountItems[amountItems.length - 1];

      if (amountItem.text.includes("-")) {
        sign = -1;
      } else if (creditX !== null && debitX !== null) {
        sign =
          Math.abs(amountItem.x - creditX) <
          Math.abs(amountItem.x - debitX)
            ? 1
            : -1;
      } else if (currentSection) {
        const upperSection = currentSection.toUpperCase();
        if (
          upperSection.includes("PAIEMENTS PAR CARTE") ||
          upperSection.includes("CHEQUES")
        ) {
          sign = -1;
        }
      }

      amountValue = amount * sign;
    }

    const dateOpIndex = line.items.findIndex((it) =>
      it.text.includes(dateOpMatch[0])
    );
    const valueIndex = line.items.findIndex((it) =>
      it.text.includes(dateValueMatch[0])
    );
    const amountIndex = line.items.findIndex((it) =>
      /\d{1,3}(?:[ \u00A0]\d{3})*,\d{2}/.test(it.text)
    );
    const labelEnd =
      valueIndex > -1 ? valueIndex : amountIndex > -1 ? amountIndex : undefined;
    const labelParts = line.items
      .slice(dateOpIndex + 1, labelEnd)
      .map((it) => it.text)
      .filter((part) => part.trim().length > 0);
    const label = normalizeSpaces(labelParts.join(" ")) || text;

    if (amountValue === null) {
      continue;
    }

    transactions.push({
      dateOperation: operationDate,
      dateValeur: valueDate,
      label,
      amount: amountValue,
      meta: {
        raw: text,
        section: currentSection,
      },
    });
  }

  return transactions;
}

export const lclParser: BankParser = {
  bankId: "lcl",
  detect: (pdfText) => {
    const upper = pdfText.toUpperCase();
    return (
      upper.includes("CREDIT LYONNAIS") ||
      upper.includes("LCL.FR") ||
      upper.includes("WWW.LCL.FR") ||
      upper.includes("LCL BANQUE")
    );
  },
  async parse(input) {
    if (typeof input === "string") {
      const lines = input
        .split(/\r?\n/)
        .map((line) => normalizeSpaces(line))
        .filter(Boolean)
        .map((line) => ({ text: line, items: [] }));
      return parseLclLines(lines);
    }

    const lines = await extractLinesFromPdf(input);
    return parseLclLines(lines);
  },
};
