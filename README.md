# PDF Relevé -> Excel (Next.js)

MVP pour convertir un relevé bancaire PDF en fichier Excel standardisé.

## Démarrage

```bash
npm install
npm run dev
```

Ouvrez http://localhost:3000

## Utilisation

- Sélectionner un PDF de relevé (max 15MB)
- Détection automatique de la banque (modifiable)
- Cliquer sur "Convertir" pour télécharger un `.xlsx`

Banques prises en charge :

- BNP Paribas
- CIC
- LCL
- Banque Populaire
- Société Générale
- Qonto

Le fichier contient une feuille "Feuille 1" avec les colonnes :

- DATE (dd/mm/yyyy)
- PIECE (mois)
- LIBELLE
- DEBIT
- CREDIT

## API

Endpoint : `POST /api/convert`

FormData :

- `file` : PDF
- `bank` : `bnp`, `cic`, `lcl`, `banque-populaire`, `societe-generale`, `qonto`

Endpoint : `POST /api/detect`

FormData :

- `file` : PDF

Réponse : `{ bankId: "bnp" | "cic" | "lcl" | "banque-populaire" | "societe-generale" | "qonto" | null }`

## Mode debug (extraction texte)

Pour diagnostiquer un PDF non reconnu :

```bash
PDF_TEXT_DEBUG=1 npm run dev
```

En cas d’échec, l’API renverra un fichier `extraction.txt` contenant le texte extrait.

## Ajouter une banque

1. Créer un nouveau parser dans `src/lib/parsers/` (ex: `mybank.ts`) et implémenter `BankParser`.
2. Enregistrer le parser dans `src/lib/parsers/index.ts`.
3. Ajouter l’option dans `src/app/page.tsx`.

Le parser reçoit du texte PDF ou un buffer et doit retourner `Transaction[]`.

## Tests

```bash
npm run test
```

## Limites connues

- Parsing basé sur extraction texte (PDF non scanné requis).
- Certaines opérations peuvent nécessiter des heuristiques si le PDF ne conserve pas les colonnes.
