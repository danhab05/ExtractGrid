import ExcelJS from "exceljs";
import type { Transaction } from "./parsers";
const formatDateSlash = (date: Date | null): string => {
  if (!date) return "";
  const day = `${date.getUTCDate()}`.padStart(2, "0");
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const year = date.getUTCFullYear();
  return `${day}/${month}/${year}`;
};

const getMonthNumber = (date: Date | null): string | "" => {
  if (!date) return "";
  return `${date.getUTCMonth() + 1}`.padStart(2, "0");
};

export async function buildWorkbook(transactions: Transaction[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Feuille 1");

  worksheet.columns = [
    { header: "DATE", key: "dateOperation", width: 14 },
    { header: "TYPE DE JOURNAL", key: "journalType", width: 18 },
    { header: "NUMERO DE COMPTE", key: "accountNumber", width: 18 },
    { header: "MOIS", key: "month", width: 10 },
    { header: "LIBELLE", key: "label", width: 80 },
    { header: "DEBIT", key: "debit", width: 14 },
    { header: "CREDIT", key: "credit", width: 14 },
  ];

  worksheet.getColumn("debit").numFmt = "0.00";
  worksheet.getColumn("credit").numFmt = "0.00";

  let totalDebit = 0;
  let totalCredit = 0;
  let lastDate: Date | null = null;

  for (const tx of transactions) {
    const debitCents =
      tx.amount < 0 ? Math.round(Math.abs(tx.amount) * 100) : 0;
    const creditCents = tx.amount > 0 ? Math.round(tx.amount * 100) : 0;
    const debit = debitCents ? debitCents / 100 : null;
    const credit = creditCents ? creditCents / 100 : null;

    totalDebit += debitCents;
    totalCredit += creditCents;

    worksheet.addRow({
      dateOperation: formatDateSlash(tx.dateOperation),
      journalType: "BQ",
      accountNumber: "471000",
      month: getMonthNumber(tx.dateOperation),
      label: tx.label,
      debit,
      credit,
    });

    if (!lastDate || tx.dateOperation > lastDate) {
      lastDate = tx.dateOperation;
    }
  }

  const lastDateFormatted = formatDateSlash(lastDate);
  const lastMonth = getMonthNumber(lastDate);

  worksheet.addRow({
    dateOperation: lastDateFormatted,
    journalType: "BQ",
    accountNumber: "512100",
    month: lastMonth,
    label: "",
    debit: null,
    credit: totalCredit / 100,
  });

  worksheet.addRow({
    dateOperation: lastDateFormatted,
    journalType: "BQ",
    accountNumber: "512100",
    month: lastMonth,
    label: "",
    debit: totalDebit / 100,
    credit: null,
  });

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
