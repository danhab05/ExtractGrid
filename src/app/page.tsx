"use client";

import { useMemo, useState } from "react";
import styles from "./page.module.css";

const BANK_OPTIONS = [
  { value: "bnp", label: "BNP Paribas" },
  { value: "banque-populaire", label: "Banque Populaire" },
  { value: "qonto", label: "Qonto" },
  { value: "lcl", label: "LCL" },
  { value: "cic", label: "CIC" },
  { value: "societe-generale", label: "Societe Generale" },
];

export default function Home() {
  const [bank, setBank] = useState("bnp");
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [detectedBank, setDetectedBank] = useState<string | null>(null);
  const [detectError, setDetectError] = useState("");
  const [manualOverride, setManualOverride] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const fileLabel = useMemo(() => {
    if (!file) return "Selectionner un PDF (max 15MB)";
    return `${file.name} (${Math.round(file.size / 1024)} KB)`;
  }, [file]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setSuccess("");

    if (!file) {
      setError("Merci de selectionner un PDF.");
      return;
    }

    setLoading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("bank", bank);

      const response = await fetch("/api/convert", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(payload?.error || "Conversion impossible.");
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "operations.xlsx";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);
      setSuccess("Conversion terminee. Le fichier est telecharge.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur inattendue.");
    } finally {
      setLoading(false);
    }
  };

  const handleFileChange = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const selectedFile = event.target.files?.[0] ?? null;
    setFile(selectedFile);
    setDetectedBank(null);
    setDetectError("");
    setManualOverride(false);

    if (!selectedFile) return;

    setDetecting(true);
    try {
      const formData = new FormData();
      formData.append("file", selectedFile);
      const response = await fetch("/api/detect", {
        method: "POST",
        body: formData,
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(payload?.error || "Detection impossible.");
      }
      const payload = (await response.json()) as { bankId?: string | null };
      const detected = payload.bankId ?? null;
      setDetectedBank(detected);
      if (detected) {
        setBank(detected);
      }
    } catch (err) {
      setDetectError(err instanceof Error ? err.message : "Erreur inattendue.");
    } finally {
      setDetecting(false);
    }
  };

  const handleBankChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    setBank(event.target.value);
    setManualOverride(true);
  };

  const detectedLabel = BANK_OPTIONS.find(
    (option) => option.value === detectedBank
  )?.label;

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <section className={styles.hero}>
          <div className={styles.brand}>
            <img
              src="/extractgrid.png"
              alt="ExtractGrid"
              className={styles.logo}
            />
            <span>ExtractGrid</span>
          </div>
        </section>

        <section className={styles.card}>
          <form onSubmit={handleSubmit} className={styles.form}>
            <label className={styles.field}>
              <span>PDF de releve</span>
              <input
                type="file"
                accept="application/pdf"
                onChange={handleFileChange}
                disabled={loading}
              />
              <span className={styles.fileName}>{fileLabel}</span>
            </label>

            {detectedBank && (
              <>
                <label className={styles.field}>
                  <span>Banque</span>
                  <select
                    value={bank}
                    onChange={handleBankChange}
                    disabled={loading}
                  >
                    {BANK_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <span className={styles.hint}>
                    {detecting && "Detection de la banque en cours..."}
                    {!detecting &&
                      detectedBank &&
                      `Banque detectee : ${detectedLabel} (modifiable)`}
                    {!detecting && detectError && detectError}
                  </span>
                </label>

                <button type="submit" className={styles.cta} disabled={loading}>
                  {loading ? (
                    "Conversion en cours..."
                  ) : (
                    <>
                      <img
                        src="/extractgrid.png"
                        alt=""
                        className={styles.buttonIcon}
                      />
                      Convertir
                    </>
                  )}
                </button>
              </>
            )}

            {error && <p className={styles.error}>{error}</p>}
            {success && <p className={styles.success}>{success}</p>}
          </form>
        </section>

        <footer className={styles.copyright}>
          © 2026 Habib Dan
        </footer>
      </main>
    </div>
  );
}
