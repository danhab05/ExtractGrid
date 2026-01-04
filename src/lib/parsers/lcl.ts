import path from "node:path";
import { pathToFileURL } from "node:url";
import { getStandardFontDataUrl } from "../pdf";
import { loadPdfJs } from "../pdfjs";
import type { BankParser, Transaction } from "./types";
import {
  findAmountsInLine,
  normalizeSpaces,
  parseAmountFR,
  parseDateFR,
} from "./utils";

type LineItem = { text: string; x: number };
type PdfLine = { text: string; items: LineItem[]; page: number };

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

const SHORT_DATE_REGEX = /^\d{2}[./]\d{2}$/;
const LONG_DATE_REGEX = /^\d{2}[./]\d{2}[./]\d{2,4}$/;
const ANY_DATE_REGEX = /\b\d{2}[./]\d{2}(?:[./]\d{2,4})?\b/;
const CARD_VALUE_DATE_REGEX = /\d{2}\/\d{2}\/\d{4}/;

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

function findPeriodStart(lines: PdfLine[]): Date | null {
  for (const line of lines) {
    const match = line.text.match(/du\s+(\d{2}[./]\d{2}[./]\d{4})/i);
    if (match) {
      const token = normalizeDateToken(match[1]);
      return parseDateFR(token);
    }
  }
  return null;
}

function resolveDateItems(line: PdfLine) {
  const dateItems = line.items.filter((it) =>
    ANY_DATE_REGEX.test(it.text.trim())
  );
  const shortItems = dateItems
    .filter((it) => SHORT_DATE_REGEX.test(it.text.trim()))
    .sort((a, b) => a.x - b.x);
  const longItems = dateItems
    .filter((it) => LONG_DATE_REGEX.test(it.text.trim()))
    .sort((a, b) => a.x - b.x);

  const operationItem = shortItems[0] ?? longItems[0] ?? null;
  const valueItem = longItems.length > 0 ? longItems[longItems.length - 1] : null;

  return { operationItem, valueItem };
}

function parseCardValueDate(text: string): Date | null {
  const match = text.match(CARD_VALUE_DATE_REGEX);
  if (!match) return null;
  return parseDateFR(normalizeDateToken(match[0]));
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

    const pageLines = Array.from(lineMap.entries())
      .sort((a, b) => b[0] - a[0])
      .map(([, items]) => {
        const ordered = items
          .filter((it) => it.text.trim().length > 0)
          .sort((a, b) => a.x - b.x);
        const text = normalizeSpaces(ordered.map((it) => it.text).join(" "));
        return { text, items: ordered, page: pageNum };
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
  const periodStart = findPeriodStart(lines);
  const cardTransactions: Transaction[] = [];
  let cardDetailsFound = false;

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
    const upper = text.toUpperCase();
    if (shouldIgnoreLine(text)) {
      continue;
    }

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

    const { operationItem, valueItem } = resolveDateItems(line);

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
        const dateOpToken = operationItem?.text.replace(/\//g, ".");
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

    if (!operationItem || !valueItem) {
      continue;
    }

    const valueToken = normalizeDateToken(valueItem.text);
    const valueDate = parseDateFR(valueToken);
    const operationDate = parseShortDate(
      operationItem.text.replace(/\//g, "."),
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

    const amountItem = amountItems[amountItems.length - 1];
    const labelRightBound =
      valueItem?.x ?? amountItem?.x ?? Number.POSITIVE_INFINITY;
    const labelParts = line.items
      .filter((it) => it.x > operationItem.x + 1 && it.x < labelRightBound - 1)
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

  let cardValueDate: Date | null = null;
  for (const line of lines) {
    if (/MONTANT COMPTABILISE/i.test(line.text)) {
      cardValueDate = parseCardValueDate(line.text);
      break;
    }
  }
  const cardLongDateToken = /\d{2}[./]\d{2}[./]\d{2,4}/;
  for (const line of lines) {
    const text = line.text;
    const upper = text.toUpperCase();
    if (
      upper.includes("LIBELLE") ||
      upper.includes("SOUS TOTAL") ||
      upper.includes("TOTAUX") ||
      upper.includes("MONTANT COMPTABILISE") ||
      upper.includes("SOLDE") ||
      upper.includes("CARTE N") ||
      upper.includes("PAIEMENTS PAR CARTE")
    ) {
      continue;
    }
    const amounts = findAmountsInLine(text);
    const opDateMatch = text.match(/\bLE\s*(\d{2}[./]\d{2})\b/i);
    if (amounts.length > 0 && opDateMatch && !cardLongDateToken.test(text)) {
      const amount = parseAmountFR(amounts[amounts.length - 1]);
      const amountRegex = new RegExp(
        `${amounts[amounts.length - 1].replace(".", "\\.")}$`
      );
      let label = normalizeSpaces(text.replace(amountRegex, ""));
      label = normalizeSpaces(label.replace(opDateMatch[0], ""));

      const fallbackDate = cardValueDate ?? periodStart ?? new Date();
      const operationDate = parseShortDate(
        opDateMatch[1].replace(/\//g, "."),
        fallbackDate
      );
      const valueDate = cardValueDate ?? operationDate;

      cardTransactions.push({
        dateOperation: operationDate,
        dateValeur: valueDate,
        label,
        amount: -Math.abs(amount),
        meta: { raw: text, section: "PAIEMENTS PAR CARTE" },
      });
      cardDetailsFound = true;
    }
  }

  const baseTransactions = cardDetailsFound
    ? transactions.filter((tx) => !/RELEVE CB/i.test(tx.label))
    : transactions;

  return [...baseTransactions, ...cardTransactions];
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
        .map((line) => ({ text: line, items: [], page: 1 }));
      return parseLclLines(lines);
    }

    const lines = await extractLinesFromPdf(input);
    return parseLclLines(lines);
  },
};
