import { describe, expect, it } from "vitest";
import { parseAmountFR } from "@/lib/parsers/utils";

describe("parseAmountFR", () => {
  it("parses french formatted amounts", () => {
    expect(parseAmountFR("1 400,00")).toBe(1400);
  });
});
