import path from "node:path";
import { pathToFileURL } from "node:url";
import { getStandardFontDataUrl } from "../pdf";
import { loadPdfJs } from "../pdfjs";
import type { BankParser, Transaction } from "./types";
import { normalizeSpaces, parseAmountFR } from "./utils";

type LineItem = { text: string; x: number };
type PdfLine = { text: string; items: LineItem[] };

const START_MARKER = "DATE VALEUR";
const END_MARKERS = ["TOTAUX DES MOUVEMENTS", "NOUVEAU SOLDE"];

const CREDIT_HINTS = ["REMISE CB", "VIR RECU", "REMISE CHEQUE"];
const DEBIT_HINTS = [
  "PRELEVEMENT",
  "VRST GAB",
  "VIR EUROPEEN EMIS",
  "VIR INSTANTANE EMIS",
  "DEBIT",
  "COTIS",
  "FRAIS",
  "ECHEANCE",
  "CHEQUE ",
];

function parseDateFRLong(token: string): Date {
  const [day, month, year] = token.split("/").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
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

function extractTableText(pdfText: string): string {
  const upper = pdfText.toUpperCase();
  const startIndex = upper.indexOf(START_MARKER);
  if (startIndex === -1) return "";
  const sliced = pdfText.slice(startIndex + START_MARKER.length);
  const upperSliced = sliced.toUpperCase();
  let endIndex = sliced.length;
  for (const marker of END_MARKERS) {
    const idx = upperSliced.indexOf(marker);
    if (idx !== -1 && idx < endIndex) {
      endIndex = idx;
    }
  }
  return sliced.slice(0, endIndex);
}

function inferSign(line: string): number {
  const upper = line.toUpperCase();
  if (upper.includes("*")) return -1;
  if (CREDIT_HINTS.some((hint) => upper.includes(hint))) return 1;
  if (DEBIT_HINTS.some((hint) => upper.includes(hint))) return -1;
  return -1;
}

function parseSgText(pdfText: string): Transaction[] {
  const tableText = extractTableText(pdfText);
  if (!tableText) {
    throw new Error("Format PDF non reconnu Societe Generale");
  }

  const normalizedTable = normalizeSpaces(
    tableText
      .replace(/\r/g, "\n")
      .replace(/\n+/g, " ")
      .replace(
        /N[º°] ADEME[\s\S]*?Date Valeur Nature de l'opération Débit Crédit/gi,
        " "
      )
      .replace(/SOCIETE GENERALE[\s\S]*?Date Valeur Nature/gi, " ")
      .replace(/RELEVE DE COMPTE[\s\S]*?Date Valeur Nature/gi, " ")
      .replace(/SUITE\s*>>>/gi, " ")
  );

  const transactions: Transaction[] = [];
  const entryStartRegex = /(\d{2}\/\d{2}\/\d{4})\s*(\d{2}\/\d{2}\/\d{4})/g;
  const entryMatches = [...normalizedTable.matchAll(entryStartRegex)];

  for (let i = 0; i < entryMatches.length; i += 1) {
    const match = entryMatches[i];
    const startIndex = match.index ?? 0;
    const endIndex =
      i + 1 < entryMatches.length
        ? entryMatches[i + 1].index ?? normalizedTable.length
        : normalizedTable.length;
    let chunk = normalizeSpaces(normalizedTable.slice(startIndex, endIndex));
    let upper = chunk.toUpperCase();
    if (upper.includes("SOLDE PRECEDENT")) continue;

    const stopMarkers = [
      "SUITE >>>",
      "N° ADEME",
      "Nº ADEME",
      "RELEVE DE COMPTE",
      "RELEV DE COMPTE",
      "SOCIETE GENERALE",
      "PAGE ",
    ];
    let cutIndex = -1;
    for (const marker of stopMarkers) {
      const idx = upper.indexOf(marker);
      if (idx !== -1 && (cutIndex === -1 || idx < cutIndex)) {
        cutIndex = idx;
      }
    }
    if (cutIndex !== -1) {
      chunk = normalizeSpaces(chunk.slice(0, cutIndex));
      upper = chunk.toUpperCase();
    }

    const dateValeurRaw = match[1];
    const dateOperationRaw = match[2];
    const dateValeur = parseDateFRLong(dateValeurRaw);
    const dateOperation = parseDateFRLong(dateOperationRaw);

    const amountMatches = [
      ...chunk.matchAll(
        /(?=(\d{1,3}(?:[ \u00A0.]\d{3})*,\d{2}))/g
      ),
    ].map((match) => ({ value: match[1], index: match.index ?? 0 }));
    if (amountMatches.length === 0) continue;
    const candidates = amountMatches.filter((match) => {
      if (match.index === 0) return true;
      return !/\d/.test(chunk[match.index - 1]);
    });
    const pool = candidates.length ? candidates : amountMatches;
    const amountMatch = pool.reduce((best, current) => {
      const currentEnd = current.index + current.value.length;
      const bestEnd = best.index + best.value.length;
      if (currentEnd > bestEnd) return current;
      if (currentEnd < bestEnd) return best;
      return current.index < best.index ? current : best;
    });
    const amountRaw = amountMatch.value;
    const amountIndex = amountMatch.index;
    if (amountIndex === -1) continue;

    const amount = parseAmountFR(amountRaw);
    const tail = chunk.slice(amountIndex + amountRaw.length, amountIndex + amountRaw.length + 3);
    const sign = tail.includes("*") ? -1 : inferSign(chunk);

    const labelStart = match[0].length;
    const label = normalizeSpaces(chunk.slice(labelStart, amountIndex));

    transactions.push({
      dateOperation,
      dateValeur,
      label,
      amount: amount * sign,
    });
  }

  return transactions;
}

function extractLastAmount(text: string): number | null {
  const matches = [...text.matchAll(/(?=(\d{1,3}(?:[ \u00A0.]\d{3})*,\d{2}))/g)]
    .map((match) => ({ value: match[1], index: match.index ?? 0 }));
  if (matches.length === 0) return null;
  const best = matches.reduce((bestMatch, current) => {
    const currentEnd = current.index + current.value.length;
    const bestEnd = bestMatch.index + bestMatch.value.length;
    if (currentEnd > bestEnd) return current;
    if (currentEnd < bestEnd) return bestMatch;
    return current.index < bestMatch.index ? current : bestMatch;
  });
  return parseAmountFR(best.value);
}

async function parseSgPdf(buffer: Buffer): Promise<Transaction[]> {
  const lines = await extractLinesFromPdf(buffer);
  const transactions: Transaction[] = [];

  const headerLine = lines.find(
    (line) => line.text.includes("Date") && line.text.includes("Valeur")
  );
  let debitX = 0;
  let creditX = 0;

  if (headerLine) {
    const debitItem = headerLine.items.find((item) => /D.?bit/i.test(item.text));
    const creditItem = headerLine.items.find((item) => /Cr.?dit/i.test(item.text));
    if (debitItem && creditItem) {
      debitX = debitItem.x;
      creditX = creditItem.x;
    }
  }

  if (!debitX || !creditX) {
    const amountRegex = /^\d{1,3}(?:[ \u00A0.]\d{3})*,\d{2}$/;
    const buckets = new Map<number, number>();
    for (const line of lines) {
      for (const item of line.items) {
        const raw = normalizeSpaces(item.text);
        if (!amountRegex.test(raw)) continue;
        const key = Math.round(item.x / 5) * 5;
        buckets.set(key, (buckets.get(key) ?? 0) + 1);
      }
    }
    const sorted = [...buckets.entries()].sort((a, b) => b[0] - a[0]);
    if (sorted.length >= 2) {
      creditX = sorted[0][0];
      debitX =
        sorted.find((entry) => entry[0] < creditX - 10)?.[0] ?? sorted[1][0];
    } else {
      throw new Error("Format PDF non reconnu Societe Generale");
    }
  }

  if (debitX > creditX) {
    [debitX, creditX] = [creditX, debitX];
  }

  const amountRegex = /^\d{1,3}(?:[ \u00A0.]\d{3})*,\d{2}$/;
  const columnSplit = (debitX + creditX) / 2;

  let current:
    | {
        dateOperation: Date;
        dateValeur: Date;
        label: string;
        amount?: number;
      }
    | null = null;
  let inTable = false;

  for (const line of lines) {
    const upper = line.text.toUpperCase();
    if (upper.includes("DATE VALEUR") && upper.includes("NATURE")) {
      inTable = true;
      continue;
    }
    if (upper.includes("TOTAUX DES MOUVEMENTS") || upper.includes("NOUVEAU SOLDE")) {
      inTable = false;
      continue;
    }
    if (!inTable) continue;
    if (upper.includes("SOLDE PRECEDENT") || upper.includes("RELEVE DE COMPTE")) {
      continue;
    }

    const dateTokens = line.text.match(/\d{2}\/\d{2}\/\d{4}/g) ?? [];
    const dateItems = line.items.filter((item) =>
      /\d{2}\/\d{2}\/\d{4}/.test(item.text)
    );
    const startsWithDate =
      dateTokens.length >= 2 && dateItems.length >= 2 && dateItems[0].x < 70;

    const amounts = line.items
      .map((item) => ({ raw: normalizeSpaces(item.text), x: item.x }))
      .filter((item) => amountRegex.test(item.raw))
      .map((item) => ({ x: item.x, value: parseAmountFR(item.raw) }));

    const debitAmount = amounts
      .filter((item) => item.x < columnSplit)
      .map((item) => item.value)
      .pop();
    const creditAmount = amounts
      .filter((item) => item.x >= columnSplit)
      .map((item) => item.value)
      .pop();
    const textAmount = extractLastAmount(line.text);
    const resolvedAmount =
      textAmount ?? creditAmount ?? debitAmount ?? null;

    if (startsWithDate && dateTokens[0] && dateTokens[1] && dateItems[1]) {
      if (current) {
        transactions.push({
          dateOperation: current.dateOperation,
          dateValeur: current.dateValeur,
          label: current.label,
          amount: current.amount ?? 0,
        });
      }

      const dateValeur = parseDateFRLong(dateTokens[0]);
      const dateOperation = parseDateFRLong(dateTokens[1]);
      const secondDateX = dateItems[1].x + 2;
      const label = normalizeSpaces(
        line.items
          .filter((item) => item.x > secondDateX && item.x < debitX - 5)
          .map((item) => item.text)
          .join(" ")
      );

      const signedAmount =
        creditAmount !== undefined
          ? resolvedAmount
          : debitAmount !== undefined
            ? resolvedAmount !== null
              ? -resolvedAmount
              : undefined
            : resolvedAmount !== null
              ? resolvedAmount * inferSign(label)
              : undefined;

      current = {
        dateOperation,
        dateValeur,
        label,
        amount: signedAmount ?? undefined,
      };
      continue;
    }

    if (!current) continue;
    const extra = normalizeSpaces(
      line.items
        .filter((item) => item.x < debitX - 5)
        .map((item) => item.text)
        .join(" ")
    );
    if (extra) {
      current.label = normalizeSpaces(`${current.label} ${extra}`);
    }
    if (resolvedAmount !== null) {
      if (creditAmount !== undefined) {
        current.amount = resolvedAmount;
      } else if (debitAmount !== undefined) {
        current.amount = -resolvedAmount;
      } else {
        current.amount = resolvedAmount * inferSign(current.label);
      }
    }
  }

  if (current) {
    transactions.push({
      dateOperation: current.dateOperation,
      dateValeur: current.dateValeur,
      label: current.label,
      amount: current.amount ?? 0,
    });
  }

  return transactions.filter((tx) => tx.amount !== 0 || tx.label.length > 0);
}

export const sgParser: BankParser = {
  bankId: "societe-generale",
  detect: (pdfText) => pdfText.toUpperCase().includes("SOCIETE GENERALE"),
  async parse(input) {
    if (typeof input === "string") {
      return parseSgText(input);
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
    return parseSgText(text);
  },
};






