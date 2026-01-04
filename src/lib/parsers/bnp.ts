import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import { getStandardFontDataUrl } from "../pdf";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { BankParser, Transaction } from "./types";
import {
  findAmountsInLine,
  hasDateToken,
  isUppercaseTitle,
  normalizeSpaces,
  parseAmountFR,
  parseDateFR,
} from "./utils";

const START_MARKER = "DATE COMPTABLE";
const END_MARKERS = [
  "TOTAL DES OPERATIONS",
  "SOLDE CREDITEUR",
  "SOLDE D\u00c9BITEUR",
  "SOLDE AU",
  "ANCIEN SOLDE",
];

const IGNORED_LINE_PATTERNS = [
  /SOUS\s+TOTAL/i,
  /TOTAL\s+DES\s+OPERATIONS/i,
  /SOLDE\s+(CREDITEUR|DEBITEUR)/i,
  /SOLDE\s+AU/i,
  /ANCIEN\s+SOLDE/i,
  /BNP\s+PARIBAS\s+SA/i,
  /RELEVE\s+DE\s+VOTRE\s+COMPTE/i,
  /P\.\s*\d+\/\d+/i,
  /SORPSIT/i,
];

const DATE_LINE_REGEX = /^(\d{2}\.\d{2}\.\d{2})\s+/;
const SECTION_KEYWORDS = [
  "VIREMENTS RECUS",
  "VIREMENTS EMIS",
  "PRELEVEMENTS, AMORTISSEMENTS DE PRETS",
  "AUTRES OPERATIONS DEBIT",
  "REMISES DE CARTES",
  "CHEQUES EMIS",
  "PAIEMENTS PAR CARTES",
];

type PendingOperation = {
  dateOperation: Date;
  dateValeur: Date | null;
  labelParts: string[];
  amount: number;
  raw: string[];
  section?: string;
};

function shouldIgnoreLine(line: string): boolean {
  return IGNORED_LINE_PATTERNS.some((pattern) => pattern.test(line));
}

function inferAmountSign(
  amount: number,
  rawLine: string,
  section?: string
): number {
  const upperLine = rawLine.toUpperCase();
  const upperSection = section?.toUpperCase() ?? "";

  const creditHints = [
    "RECUS",
    "CREDIT",
    "VERSEMENT",
    "REMISE",
    "INTERETS",
    "REMBOURSEMENT",
    "REMISES DE CARTES",
  ];
  const debitHints = [
    "EMIS",
    "PRELEVEMENTS",
    "PRELEVEMENT",
    "DEBIT",
    "AMORTISSEMENTS",
    "FRAIS",
    "CARTE",
    "RETRAIT",
    "CHEQUES EMIS",
    "PAIEMENTS PAR CARTES",
    "PAIEMENT PAR CARTES",
  ];

  if (creditHints.some((hint) => upperSection.includes(hint))) return amount;
  if (debitHints.some((hint) => upperSection.includes(hint))) return -amount;
  if (creditHints.some((hint) => upperLine.includes(hint))) return amount;
  if (debitHints.some((hint) => upperLine.includes(hint))) return -amount;

  return -amount;
}

function parseStartLine(
  rawLine: string,
  normalized: string,
  section?: string
): PendingOperation | null {
  if (!DATE_LINE_REGEX.test(normalized)) return null;

  const rawColumns = rawLine.trim().split(/\s{2,}/).filter(Boolean);
  const dateTokens = normalized.match(/\d{2}\.\d{2}\.\d{2}/g) ?? [];
  const dateOperationToken = normalized.match(DATE_LINE_REGEX)?.[1];
  if (!dateOperationToken) return null;
  const dateOperation = parseDateFR(dateOperationToken);
  const dateValeurToken = dateTokens.length >= 2 ? dateTokens[1] : null;

  let label = "";
  let dateValeur: Date | null = null;
  let amountValue: number | null = null;

  if (rawColumns.length >= 3 && hasDateToken(rawColumns[2])) {
    label = normalizeSpaces(rawColumns[1] ?? "");
    dateValeur = parseDateFR(rawColumns[2]);

    if (rawColumns.length >= 5) {
      const debitRaw = rawColumns[3];
      const creditRaw = rawColumns[4];
      if (debitRaw && debitRaw.trim() !== "") {
        amountValue = -parseAmountFR(debitRaw);
      } else if (creditRaw && creditRaw.trim() !== "") {
        amountValue = parseAmountFR(creditRaw);
      }
    } else if (rawColumns.length === 4) {
      const amountRaw = rawColumns[3];
      const amount = parseAmountFR(amountRaw);
      amountValue = inferAmountSign(amount, rawLine, section);
    }
  }

  if (amountValue === null) {
    const lineWithoutDates = rawLine.replace(/\d{2}\.\d{2}\.\d{2}/g, " ");
    const amounts = findAmountsInLine(lineWithoutDates);
    if (amounts.length >= 2) {
      const debitRaw = amounts[amounts.length - 2];
      const creditRaw = amounts[amounts.length - 1];
      amountValue = -parseAmountFR(debitRaw);
      if (creditRaw) {
        amountValue = parseAmountFR(creditRaw);
      }
    } else if (amounts.length === 1) {
      const amount = parseAmountFR(amounts[0]);
      amountValue = inferAmountSign(amount, rawLine, section);
    }
  }

  if (!dateValeur && dateValeurToken) {
    dateValeur = parseDateFR(dateValeurToken);
  }

  if (!label) {
    const opIndex = rawLine.indexOf(dateOperationToken);
    const valueIndex =
      dateValeurToken !== null ? rawLine.lastIndexOf(dateValeurToken) : -1;
    if (valueIndex > -1 && opIndex > -1) {
      label = rawLine.slice(opIndex + dateOperationToken.length, valueIndex);
    } else {
      label = normalized.replace(DATE_LINE_REGEX, "");
      label = label.replace(/\d{2}\.\d{2}\.\d{2}/g, "");
    }
    label = normalizeSpaces(label);
  }

  if (amountValue === null && dateValeurToken) {
    const valueIndex = rawLine.lastIndexOf(dateValeurToken);
    if (valueIndex > -1) {
      const afterValue = rawLine.slice(valueIndex + dateValeurToken.length);
      const amounts = findAmountsInLine(afterValue);
      if (amounts.length >= 2) {
        const debitRaw = amounts[amounts.length - 2];
        const creditRaw = amounts[amounts.length - 1];
        amountValue = -parseAmountFR(debitRaw);
        if (creditRaw) {
          amountValue = parseAmountFR(creditRaw);
        }
      } else if (amounts.length === 1) {
        const amount = parseAmountFR(amounts[0]);
        amountValue = inferAmountSign(amount, rawLine, section);
      }
    }
  }

  if (amountValue === null) return null;

  if (section) {
    const upperSection = section.toUpperCase();
    if (
      upperSection.includes("CHEQUES EMIS") ||
      upperSection.includes("PAIEMENTS PAR CARTES") ||
      upperSection.includes("PAIEMENT PAR CARTES") ||
      upperSection.includes("PRELEVEMENTS") ||
      upperSection.includes("VIREMENTS EMIS") ||
      upperSection.includes("AUTRES OPERATIONS DEBIT")
    ) {
      amountValue = -Math.abs(amountValue);
    } else if (
      upperSection.includes("REMISES DE CARTES") ||
      upperSection.includes("VIREMENTS RECUS")
    ) {
      amountValue = Math.abs(amountValue);
    }
  }

  return {
    dateOperation,
    dateValeur,
    labelParts: [label],
    amount: amountValue,
    raw: [rawLine],
    section,
  };
}

function extractTableText(pdfText: string): string {
  const upperText = pdfText.toUpperCase();
  const startIndex = upperText.indexOf(START_MARKER);
  const startIndexCompact = upperText.indexOf(START_MARKER.replace(" ", ""));
  const effectiveStart =
    startIndex === -1
      ? startIndexCompact
      : startIndexCompact === -1
      ? startIndex
      : Math.min(startIndex, startIndexCompact);

  if (effectiveStart === -1) {
    return "";
  }
  const sliceOffset =
    effectiveStart === startIndex
      ? START_MARKER.length
      : START_MARKER.replace(" ", "").length;
  const sliced = pdfText.slice(effectiveStart + sliceOffset);
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

function parseBnpText(pdfText: string): Transaction[] {
  const tableText = extractTableText(pdfText);
  if (!tableText) {
    throw new Error("Format PDF non reconnu BNP");
  }

  const normalizedTable = tableText
    .replace(/\r/g, "\n")
    .replace(
      /(\d{2}\.\d{2}\.\d{2})(?=\s+[\p{L}*])/gu,
      "\n$1"
    )
    .replace(
      /(Sous total|TOTAL DES OPERATIONS|Solde cr|SOLDE CRED|SOLDE DEB|SOLDE AU|ANCIEN SOLDE|RELEVE DE VOTRE COMPTE|BNP PARIBAS SA|P\.\s*\d+\/\d+)/gi,
      "\n$1"
    )
    .replace(
      /(VIREMENTS RECUS|VIREMENTS EMIS|PRELEVEMENTS, AMORTISSEMENTS DE PRETS|AUTRES OPERATIONS DEBIT|REMISES DE CARTES|CHEQUES EMIS|PAIEMENTS PAR CARTES)/gi,
      "\n$1"
    )
    .replace(/\n{2,}/g, "\n");

  const lines = normalizedTable
    .split(/\r?\n/)
    .map((line) => line.replace(/\u00A0/g, " "))
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let currentSection: string | undefined;
  let currentOperation: PendingOperation | null = null;
  const transactions: Transaction[] = [];

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
        section: currentOperation.section,
      },
    });
    currentOperation = null;
  };

  for (const rawLine of lines) {
    const normalized = normalizeSpaces(rawLine);
    if (!normalized) continue;
    const upperLine = normalized.toUpperCase();
    if (
      (upperLine.includes("DATE COMPTABLE") ||
        upperLine.includes("DATECOMPTABLE")) &&
      (upperLine.includes("DATE DE VALEUR") ||
        upperLine.includes("DATE DEVALEUR"))
    ) {
      continue;
    }
    if (shouldIgnoreLine(normalized)) continue;

    const sectionMatch = SECTION_KEYWORDS.find((keyword) =>
      upperLine.includes(keyword)
    );
    if (sectionMatch) {
      currentSection = sectionMatch;
      continue;
    }

    if (isUppercaseTitle(normalized) && !hasDateToken(normalized)) {
      currentSection = normalized;
      continue;
    }

    const startCandidate = parseStartLine(rawLine, normalized, currentSection);
    if (startCandidate) {
      flush();
      currentOperation = startCandidate;
      continue;
    }

    if (currentOperation) {
      currentOperation.labelParts.push(normalized);
      currentOperation.raw.push(rawLine);
    }
  }

  flush();

  return transactions;
}

export const bnpParser: BankParser = {
  bankId: "bnp",
  detect: (pdfText) => pdfText.toUpperCase().includes("BNP PARIBAS"),
  async parse(input) {
    try {
      if (typeof input === "string") {
        return parseBnpText(input);
      }
      const data = Buffer.isBuffer(input) ? new Uint8Array(input) : input;
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
        data,
        standardFontDataUrl: getStandardFontDataUrl(),
      });
      const pdf = await loadingTask.promise;
      let fullText = "";
      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
        const page = await pdf.getPage(pageNum);
        const content = await page.getTextContent();
        const pageText = content.items
          .map((item) => ("str" in item ? item.str : ""))
          .join("");
        fullText += `${pageText}\n`;
        page.cleanup();
      }
      return parseBnpText(fullText);
    } catch (error) {
      const parseError =
        error instanceof Error ? error : new Error("Erreur de parsing.");
      if (typeof input !== "string") {
        try {
          const data = Buffer.isBuffer(input) ? new Uint8Array(input) : input;
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
            data,
            standardFontDataUrl: getStandardFontDataUrl(),
          });
          const pdf = await loadingTask.promise;
          let fullText = "";
          for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
            const page = await pdf.getPage(pageNum);
            const content = await page.getTextContent();
            const pageText = content.items
              .map((item) => ("str" in item ? item.str : ""))
              .join("");
            fullText += `${pageText}\n`;
            page.cleanup();
          }
          (parseError as Error & { pdfText?: string }).pdfText = fullText;
        } catch {
          // Ignore secondary extraction errors.
        }
      }
      throw parseError;
    }
  },
};
