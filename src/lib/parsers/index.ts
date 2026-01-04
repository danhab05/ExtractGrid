import { bnpParser } from "./bnp";
import { lclParser } from "./lcl";
import { banquePopulaireParser } from "./banque-populaire";
import { qontoParser } from "./qonto";
import { sgParser } from "./sg";
import type { BankParser } from "./types";

export const parserRegistry: Record<string, BankParser> = {
  bnp: bnpParser,
  lcl: lclParser,
  "banque-populaire": banquePopulaireParser,
  qonto: qontoParser,
  "societe-generale": sgParser,
};

export type { BankParser };
export type { Transaction } from "./types";
