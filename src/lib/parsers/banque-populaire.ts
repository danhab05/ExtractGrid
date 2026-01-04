import path from "node:path";
import { pathToFileURL } from "node:url";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import { getStandardFontDataUrl } from "../pdf";
import type { BankParser, Transaction } from "./types";
import { normalizeSpaces, parseAmountFR } from "./utils";

const START_MARKERS = ["DATECOMPTA", "DATECOMPTADATEOPERATION"];
const END_MARKERS = [
  "TOTAL DES MOUVEMENTS",
  "DETAIL DE VOS MOUVEMENTS",
  "DETAIL DES MOUVEMENTS",
];

function parseShortDate(token: string, year: number): Date {
  const [day, month] = token.split("/").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function extractTableText(pdfText: string): string {
  const upper = pdfText.toUpperCase();
  let startIndex = -1;
  for (const marker of START_MARKERS) {
    const idx = upper.indexOf(marker);
    if (idx !== -1) {
      startIndex = startIndex === -1 ? idx : Math.min(startIndex, idx);
    }
  }
  if (startIndex === -1) return "";
  const sliced = pdfText.slice(startIndex);
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

function inferYear(pdfText: string): number {
  const match =
    pdfText.match(/AU\s+(\d{2}\/\d{2}\/\d{4})/i) ??
    pdfText.match(/au\s+(\d{2}\/\d{2}\/\d{4})/i);
  if (match) {
    return Number(match[1].split("/")[2]);
  }
  return new Date().getUTCFullYear();
}

function parseBpText(pdfText: string): Transaction[] {
  const tableText = extractTableText(pdfText);
  if (!tableText) {
    throw new Error("Format PDF non reconnu Banque Populaire");
  }

  const year = inferYear(pdfText);
  const normalizedTable = normalizeSpaces(
    tableText.replace(/\r/g, "\n").replace(/\n+/g, " ")
  );

  const startMatches = [
    ...normalizedTable.matchAll(
      /(\d{2}\/\d{2})(?=\s+(?!\d{2}\/\d{2})[A-Z0-9])/g
    ),
  ];
  if (startMatches.length === 0) {
    throw new Error("Format PDF non reconnu Banque Populaire");
  }

  const transactions: Transaction[] = [];

  for (let i = 0; i < startMatches.length; i += 1) {
    const startIndex = startMatches[i].index ?? 0;
    const endIndex =
      i + 1 < startMatches.length
        ? startMatches[i + 1].index ?? normalizedTable.length
        : normalizedTable.length;
    const chunk = normalizeSpaces(normalizedTable.slice(startIndex, endIndex));
    const upper = chunk.toUpperCase();
    if (
      upper.includes("SOLDE CREDITEUR") ||
      upper.includes("SOLDE DEBITEUR") ||
      upper.includes("TOTAL DES MOUVEMENTS")
    ) {
      continue;
    }

    const dateMatches = [...chunk.matchAll(/\d{2}\/\d{2}/g)];
    if (dateMatches.length < 2) continue;

    const dateComptaMatch = dateMatches[0];
    const dateOperationMatch = dateMatches[1];
    const dateValeurMatch = dateMatches[2] ?? dateMatches[1];

    const dateOperationToken = dateOperationMatch[0];
    const dateValeurToken = dateValeurMatch[0];
    const dateOperationIndex = dateOperationMatch.index ?? 0;
    const dateValeurIndex = dateValeurMatch.index ?? dateOperationIndex;

    const labelMain = chunk.slice(
      (dateComptaMatch.index ?? 0) + dateComptaMatch[0].length,
      dateOperationIndex
    );

    const afterValeur = chunk.slice(dateValeurIndex + dateValeurToken.length);
    const amountMatch = afterValeur.match(
      /([-\u2212])?\s*(\d{1,3}(?:[ \u00A0.]\d{3})*,\d{2})/
    );
    if (!amountMatch || amountMatch.index === undefined) continue;

    const sign = amountMatch[1] ? -1 : 1;
    const amount = parseAmountFR(amountMatch[2]);
    const amountIndex =
      dateValeurIndex + dateValeurToken.length + amountMatch.index;

    const tailRaw = chunk.slice(amountIndex + amountMatch[0].length);
    const tail = normalizeSpaces(
      tailRaw.replace(/ƒ'ª/gi, " ").replace(/€|EUR/gi, " ")
    );

    const label = normalizeSpaces(
      [labelMain, tail].filter((value) => value.length > 0).join(" ")
    );

    transactions.push({
      dateOperation: parseShortDate(dateOperationToken, year),
      dateValeur: parseShortDate(dateValeurToken, year),
      label,
      amount: amount * sign,
    });
  }

  return transactions;
}

export const banquePopulaireParser: BankParser = {
  bankId: "banque-populaire",
  detect: (pdfText) => pdfText.toUpperCase().includes("BANQUE POPULAIRE"),
  async parse(input) {
    if (typeof input === "string") {
      return parseBpText(input);
    }
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
    return parseBpText(text);
  },
};
