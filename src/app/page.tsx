"use client";

import { useMemo, useRef, useState } from "react";
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
  const [dragActive, setDragActive] = useState(false);
  const dragCounter = useRef(0);

  const fileLabel = useMemo(() => {
    if (!file) return "Selectionner un PDF (max 15MB)";
    return `${file.name} (${Math.round(file.size / 1024)} KB)`;
  }, [file]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setSuccess("");

    if (!file) {
      setError("Merci de sélectionner un PDF.");
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
      setSuccess("Conversion terminée. Le fichier est téléchargé.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur inattendue.");
    } finally {
      setLoading(false);
    }
  };

  const processFile = async (selectedFile: File | null) => {
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
        throw new Error(payload?.error || "Détection impossible.");
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

  const handleFileChange = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const selectedFile = event.target.files?.[0] ?? null;
    await processFile(selectedFile);
  };

  const handleDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragCounter.current = 0;
    setDragActive(false);
    const droppedFile = event.dataTransfer.files?.[0] ?? null;
    if (!droppedFile) return;
    if (droppedFile.type !== "application/pdf") {
      setError("Merci de déposer un PDF.");
      return;
    }
    await processFile(droppedFile);
  };

  const handleDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragCounter.current += 1;
    setDragActive(true);
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragCounter.current -= 1;
    if (dragCounter.current <= 0) {
      setDragActive(false);
    }
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const handleBankChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    setBank(event.target.value);
    setManualOverride(true);
  };

  const detectedLabel = BANK_OPTIONS.find(
    (option) => option.value === detectedBank
  )?.label;

  return (
    <div
      className={styles.page}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className={styles.glow} aria-hidden="true" />
      <div
        className={`${styles.dropOverlay} ${
          dragActive ? styles.dropOverlayActive : ""
        }`}
        aria-hidden="true"
      >
        Déposez le PDF pour lancer la conversion
      </div>
      <main className={styles.shell}>
        <header className={styles.header}>
          <div className={styles.brand}>
            <img
              src="/extractgrid.png"
              alt="ExtractGrid"
              className={styles.logo}
            />
            <div>
              <span className={styles.brandName}>ExtractGrid</span>
              <span className={styles.brandTag}>PDF vers Excel</span>
            </div>
          </div>
          <div className={styles.headerBadge}>Conversion instantanée</div>
        </header>

        <section className={styles.hero}>
          <div className={styles.heroText}>
            <p className={styles.kicker}>Relevés bancaires pros</p>
            <h1>Transformez vos relevés PDF en Excel pour vos logiciels de compta.</h1>
            <p className={styles.subtext}>
              Importez un PDF, vérifiez la banque, téléchargez l'Excel.
            </p>
          </div>
        </section>

        <section className={styles.content}>
          <section className={styles.formCard}>
            <form onSubmit={handleSubmit} className={styles.form}>
              <label className={styles.field}>
                <span>PDF de relevé</span>
                <div
                  className={`${styles.dropZone} ${
                    dragActive ? styles.dropActive : ""
                  }`}
                >
                  <input
                    type="file"
                    accept="application/pdf"
                    onChange={handleFileChange}
                    disabled={loading}
                  />
                  <span className={styles.dropHint}>
                    Glisser-déposer ou cliquer pour choisir un PDF
                  </span>
                  <span className={styles.dropMeta}>
                    Format accepté: PDF, 15MB max
                  </span>
                </div>
                <span className={styles.fileName}>{fileLabel}</span>
              </label>

              {file && !detecting && (
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
                    {detectedBank &&
                      `Banque détectée : ${detectedLabel} (modifiable)`}
                    {!detectedBank &&
                        "Banque non détectée, sélection manuelle."}
                    {detectError && detectError}
                  </span>
                </label>

                  <div className={styles.ctaWrap}>
                    <button
                      type="submit"
                      className={styles.cta}
                      disabled={loading}
                    >
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
                  </div>
                </>
              )}

              {detecting && (
                <p className={styles.loading}>Détection en cours...</p>
              )}
              {error && <p className={styles.error}>{error}</p>}
              {success && <p className={styles.success}>{success}</p>}
            </form>
          </section>

          <aside className={styles.sideCard}>
            <div className={styles.sideTitle}>Banques prises en charge</div>
            <div className={styles.bankGrid}>
              {BANK_OPTIONS.map((option) => (
                <div key={option.value} className={styles.bankTag}>
                  {option.label}
                </div>
              ))}
            </div>
            <div className={styles.sideBlock}>
              <h3>Colonnes exportées</h3>
              <p>DATE, PIECE, LIBELLE, DEBIT, CREDIT</p>
            </div>
            <div className={styles.sideBlock}>
              <h3>Confidentialité</h3>
              <p>Traitement local, aucun stockage de fichier.</p>
            </div>
          </aside>
        </section>

        <footer className={styles.copyright}>
          © 2026 Habib Dan
        </footer>
      </main>
    </div>
  );
}
