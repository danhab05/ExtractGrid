import { NextResponse } from "next/server";
import { parserRegistry } from "@/lib/parsers";
import { buildWorkbook } from "@/lib/excel";

const MAX_FILE_SIZE = 15 * 1024 * 1024;

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    const bank = String(formData.get("bank") ?? "");

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { error: "Fichier manquant." },
        { status: 400 }
      );
    }

    if (!bank) {
      return NextResponse.json(
        { error: "Banque manquante." },
        { status: 400 }
      );
    }

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: "Fichier trop volumineux (max 15MB)." },
        { status: 400 }
      );
    }

    const parser = parserRegistry[bank];
    if (!parser) {
      return NextResponse.json(
        { error: "Banque non supportée pour le moment." },
        { status: 400 }
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const transactions = await parser.parse(buffer);
    const workbookBuffer = await buildWorkbook(transactions);

    return new NextResponse(workbookBuffer, {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": 'attachment; filename="operations.xlsx"',
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Erreur inconnue.";

    if (process.env.PDF_TEXT_DEBUG === "1") {
      const rawText =
        error instanceof Error && (error as Error & { pdfText?: string }).pdfText
          ? (error as Error & { pdfText?: string }).pdfText
          : "Texte indisponible.";
      return new NextResponse(rawText, {
        status: 400,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": 'attachment; filename="extraction.txt"',
        },
      });
    }

    return NextResponse.json(
      { error: message || "Erreur lors de la conversion." },
      { status: 400 }
    );
  }
}
