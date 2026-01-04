import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { bnpParser } from "@/lib/parsers/bnp";
import { formatDateFR } from "@/lib/parsers/utils";

describe("bnpParser", () => {
  it("parses operations from BNP text", async () => {
    const text = readFileSync("tests/fixtures/bnp.txt", "utf-8");
    const transactions = await bnpParser.parse(text);

    expect(transactions).toHaveLength(3);
    const credit = transactions.find((tx) => tx.amount === 4200);
    const debit = transactions.find((tx) => tx.amount === -1200);
    const prlv = transactions.find((tx) => tx.amount === -120.5);

    expect(credit).toBeTruthy();
    expect(debit).toBeTruthy();
    expect(prlv).toBeTruthy();

    if (credit) {
      expect(formatDateFR(credit.dateOperation)).toBe("05-06-2025");
    }
    if (debit) {
      expect(debit.label).toContain("VIREMENT SEPA LOYER");
    }
    if (prlv) {
      expect(prlv.label).toContain("PRLV SEPA EDF");
      expect(prlv.label).toContain("ID EMETTEUR/EDF 123456");
    }
  });
});
