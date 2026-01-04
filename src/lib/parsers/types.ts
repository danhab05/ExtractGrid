export type Transaction = {
  dateOperation: Date;
  dateValeur: Date | null;
  label: string;
  amount: number;
  meta?: {
    raw?: string;
    page?: number;
    section?: string;
  };
};

export interface BankParser {
  bankId: string;
  detect?: (pdfText: string) => boolean;
  parse: (input: string | Buffer) => Promise<Transaction[]>;
}
