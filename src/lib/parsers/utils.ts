const AMOUNT_FR_REGEX = /\d{1,3}(?:[ \u00A0.]\d{3})*,\d{2}/g;
const DATE_FR_REGEX = /\d{2}\.\d{2}\.\d{2}/;

export function parseAmountFR(input: string): number {
  const normalized = input.replace(/\u00A0/g, " ").replace(/\s+/g, " ");
  const hasComma = normalized.includes(",");
  const cleaned = hasComma
    ? normalized.replace(/[\s.]/g, "").replace(",", ".")
    : normalized.replace(/\s+/g, "");
  const value = Number.parseFloat(cleaned);
  if (Number.isNaN(value)) {
    throw new Error(`Invalid amount: ${input}`);
  }
  return value;
}

export function parseDateFR(input: string): Date {
  const match = input.match(DATE_FR_REGEX);
  if (!match) {
    throw new Error(`Invalid date: ${input}`);
  }
  const [day, month, year] = match[0].split(".");
  const yearFull = Number(`20${year}`);
  return new Date(Date.UTC(yearFull, Number(month) - 1, Number(day)));
}

export function formatDateFR(date: Date | null): string {
  if (!date) return "";
  const day = `${date.getUTCDate()}`.padStart(2, "0");
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const year = date.getUTCFullYear();
  return `${day}-${month}-${year}`;
}

export function findAmountsInLine(line: string): string[] {
  return line.match(AMOUNT_FR_REGEX) ?? [];
}

export function normalizeSpaces(line: string): string {
  return line.replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
}

export function isUppercaseTitle(line: string): boolean {
  if (line.length < 3) return false;
  if (/\d/.test(line)) return false;
  return line === line.toUpperCase();
}

export function hasDateToken(line: string): boolean {
  return DATE_FR_REGEX.test(line);
}
