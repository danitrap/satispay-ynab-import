# Satispay → YNAB

Importazione settimanale **on-demand** delle transazioni del wallet Satispay in YNAB, usando un export Excel, Apple Shortcuts e un Cloudflare Worker.

**Stato: funzionante, testato end-to-end il 18 ottobre 2026.** Il primo invio reale (5 movimenti) è stato abbinato correttamente alle transazioni già presenti in YNAB, senza duplicati visibili. Il processo non scarica automaticamente i movimenti da Satispay: devi esportare e condividere il file.

## Come funziona

```text
Satispay (iPhone) → Export Excel .xlsx → Condividi → Apple Shortcut
    → Cloudflare Worker /import → Seleziona i movimenti di Disponibilità
    → YNAB API → Matching e deduplica → Approvazione e riconciliazione
```

Nessun VPS, nessun database D1 e nessuno scraping. Gli ID stabili forniti dall'export Satispay consentono di ottenere `import_id` deterministici per YNAB.

## Utilizzo settimanale

1. Esporta le transazioni Satispay come **Excel (.xlsx)**; puoi sovrapporre i periodi fra una settimana e l'altra.
2. Condividi il file dall'iPhone usando il Comando Rapido **Import Satispay**. Se non compare nel foglio di condivisione, salva l'Excel nell'app File e condividilo da lì.
3. Lo Shortcut invia il file al Worker e mostra il risultato (vedi sotto).
4. Apri il conto Satispay su YNAB, verifica le transazioni abbinate/nuove, approva quelle necessarie e riconcilia il saldo.

### Impostazione Apple Shortcuts

Configura un comando che riceve file tramite **Mostra nel foglio di condivisione**. Aggiungi **Ottieni contenuti URL** con:

| Campo | Valore |
| --- | --- |
| URL | `https://satispay-ynab-import.daniele-trapani.workers.dev/import` |
| Metodo | `POST` |
| Header `Authorization` | `Bearer <UPLOAD_TOKEN>` |
| Header `X-Confirm-Import` | `yes` |
| Corpo richiesta | **File → Input comando rapido** |

Non scegliere il formato JSON o Modulo e non impostare manualmente un header `multipart/form-data`. Per sicurezza, **non condividere lo Shortcut contenente il token**.

**Dopo la chiamata HTTP:** leggi il valore `ok` dalla risposta con **Ottieni valore dizionario** e usa **Se**:
- Se `ok` è vero, estrai `processed` e `duplicateImports`; mostra `✅ Satispay sincronizzato — elaborati: [processed], import ID già presenti: [duplicateImports]`. Facoltativo: **Apri app → YNAB**.
- Altrimenti, estrai `error` e mostra un avviso `❌ Importazione non riuscita: [error]`.

`processed` **non equivale a nuove righe create in YNAB**: include anche movimenti abbinati a transazioni già inserite manualmente.

## Regole contabili: esclusivamente Disponibilità

**Il segno del campo `Disponibilità` determina il movimento; il campo `Tipo` NON decide se importarlo.** È una scelta intenzionale: qualsiasi somma che esce dal wallet arriva su YNAB come uscita ordinaria, senza creare automaticamente trasferimenti fra conti. Tutti gli aggiustamenti (Fineco, salvadanai, altri conti) si fanno manualmente in YNAB dopo l'import.

| Satispay | Come viene registrato in YNAB |
| --- | --- |
| `Disponibilità` negativa | **Uscita ordinaria**, per qualunque tipo: negozio, carta, P2P, risparmi, investimenti, `Altro`, tipo mai visto |
| `Disponibilità` positiva | **Entrata ordinaria**, incluse ricariche `🏦 Dalla Banca`, bonifici, denaro ricevuto, rimborsi e Punti |
| `Disponibilità` vuota o zero | Ignorata: non è stato movimentato il wallet |
| Spesa mista wallet + Buoni Pasto/FlexBen | Importata **soltanto la quota `Disponibilità`** |
| Spesa interamente con Buoni Pasto/FlexBen | Ignorata |
| `🎖️ Punti` con accredito | Entrata con payee `Satispay Cashback` |

Il payee viene preso da `Nome`. Quando `Nome` è vuoto o contiene `-` (per esempio nei movimenti `Altro`), il Worker usa `Satispay — <Tipo>` come descrizione riconoscibile, così puoi riclassificarlo comodamente.

**Esempio:** una ricarica Fineco → Satispay di 100 € viene inizialmente importata sul conto Satispay come **entrata di 100 €**, non come transfer. Se Fineco è già tracciato in YNAB, dovrai convertirla tu in trasferimento per non contare due volte il movimento e per non gonfiare il reddito. Vale lo stesso per uscite verso salvadanai o investimenti: correggerai il payee in YNAB quando opportuno.

Il tipo, anche se sconosciuto, **non blocca più il batch**. Rimangono controlli bloccanti sui movimenti di Disponibilità: data valida, stato esatto `✅ Approvato`, ID Satispay testuale/presente/univoco nel file e importo rappresentabile in centesimi. Una riga problematica viene esclusa dalle candidate, e la presenza di righe rifiutate blocca l'intera chiamata a `/import`. Nessun automatic transfer viene creato.

## Rimborsi misti e controllo dei saldi

Alcuni export Satispay hanno una particolarità: per il tipo `🔄 Rimborso`, la colonna `Disponibilità` può riportare il **valore totale dell'acquisto**, anche quando l'acquisto iniziale era stato pagato in parte con Buoni Pasto. Importare quel valore come accredito del wallet sovrastimerebbe il saldo.

Il Worker cerca quindi un **acquisto originale univoco** `🏬 a un Negozio` con:
- stesso `Nome` dell'esercente (ignora maiuscole/spazi; non accetta nomi mancanti);
- `Importo` uguale e di segno opposto;
- data precedente al rimborso, entro 90 giorni;
- stato `✅ Approvato`;
- ripartizione contabile verificabile: `Disponibilità + Buoni Pasto + FlexBen = Importo`.

Se trova esattamente una corrispondenza, l'importo del rimborso viene limitato alla parte originariamente pagata con **Disponibilità**. Non cambia il suo ID Satispay né l'algoritmo di generazione di `import_id`.

Se l'acquisto originale manca dall'export, più acquisti sono compatibili, o la suddivisione degli importi è incoerente, il rimborso viene segnalato come `rejected`/`requiresReview`: **nessun import viene effettuato per il batch contenente il caso non risolto**. Per risolverlo, esporta anche l'intervallo contenente l'acquisto originale.

I controlli delle ricariche, P2P, salvadanai, `Altro` e carte **non cambiano**: qualsiasi importo di Disponibilità diverso da zero rimane un'entrata o un'uscita ordinaria da riclassificare manualmente in YNAB.

### Diagnostica dei saldi

`/preview` e `/prepare` restituiscono inoltre:
- `refundsAdjusted`: quanti rimborsi dell'intero file sono stati corretti;
- `refundsUnresolved`: quanti rimborsi dell'intero file richiedono approfondimento;
- `balanceCheck.status`: `ok`, `mismatch` oppure `unavailable`;
- `balanceCheck.discrepancyMilliunits` e i totali attesi/calcolati, quando disponibili.

Il controllo usa **il saldo più recente e quello più vecchio disponibili** (`Disponibilità dopo la transazione`) e confronta la differenza con la somma dei movimenti corretti fra quei due punti. Non confronta forzatamente ogni coppia di righe, perché l'ordine di registrazione di alcune transazioni con carta può generare differenze temporanee.

È una **diagnostica** e non blocca da sola l'importazione: `mismatch` può anche dipendere da un export parziale, snapshot mancanti o ordine non attendibile. I rimborsi ambigui e gli importi invalidi, invece, continuano a bloccare le transazioni coinvolte nella finestra di importazione.

Nel test sull'export storico di 302 righe, due rimborsi misti vengono ridotti da `19.00 → 3.00 €` e `20.23 → 4.23 €`: correzione aggregata di **32,00 €**. Dopo la correzione, la variazione dei saldi torna esattamente con la somma dei movimenti: `balanceCheck.discrepancyMilliunits = 0`.

## Matching, deduplica e periodo di import

L'ID Satispay viene trasformato in un `import_id` stabile (SHA-256, massimo 36 caratteri). Il Worker invia le transazioni a YNAB con `cleared: "cleared"` e `approved: false`.

YNAB può abbinare un movimento importato a uno già inserito **manualmente**, se corrispondono conto, importo e data entro la finestra prevista da YNAB. Se lo stesso `import_id` è già stato importato, YNAB lo riconosce come duplicato. **Non è garantito il matching tra due importazioni differenti** che usano ID diversi.

`YNAB_IMPORT_FROM` è una soglia **inclusiva**: al momento è impostata a `2026-10-11`. Puoi esportare file contenenti transazioni anteriori; verranno filtrate. Questa soglia non si aggiorna ogni settimana: è un confine fisso scelto per il primo import. Non spostarla all'indietro senza valutare eventuali movimenti storici già importati.

La soluzione è progettata per batch di massimo **100 movimenti candidati**. Non deduce se un movimento già inserito in YNAB verrà abbinato: l'esito si controlla nel conto YNAB.

## API del Worker

Base URL: `https://satispay-ynab-import.daniele-trapani.workers.dev`

| Metodo e percorso | Funzione | Scrive in YNAB? |
| --- | --- | --- |
| `GET /health` | Stato e percorsi disponibili | No |
| `GET /ynab/accounts` | Ricerca degli account contenenti “Satispay” nel nome | No |
| `POST /inspect` | Colonne Excel/CSV, numero righe e statistiche aggregate | No |
| `POST /preview` | Simulazione aggregata dei movimenti Excel, senza soglia iniziale | No |
| `POST /prepare` | Dry-run dell'Excel con filtro `YNAB_IMPORT_FROM` e classificazione rigorosa | No |
| `POST /import` | Importa le transazioni candidate usando YNAB API | **Sì** |

Tutte le rotte tranne `GET /health` richiedono `Authorization: Bearer <UPLOAD_TOKEN>`. `POST /import` richiede inoltre `X-Confirm-Import: yes`, `YNAB_WRITE_ENABLED = "true"` e una destinazione YNAB valida.

Gli upload per `/preview`, `/prepare` e `/import` richiedono **Excel .xlsx**. `/inspect` accetta anche CSV. Lo storico `.xls` non è supportato. Il Worker supporta file binario raw (ideale per Shortcuts) oppure multipart con campo `file`. Limite file: **4 MB**; limite richiesta: **4,5 MB**.

### Campi importanti nella risposta di import

| Campo | Significato |
| --- | --- |
| `eligible` | Movimenti validi selezionati dal file prima dell'invio |
| `submitted` | Movimenti inviati all'API YNAB |
| `processed` | Movimenti inviati meno `duplicateImports`; possono essere nuovi **oppure abbinati** |
| `imported` | Alias storico di `processed`, non il numero di nuove righe |
| `duplicateImports` | Import ID già presenti in YNAB |
| `ynabReportedTransactionIds` | Conteggio degli ID restituiti da YNAB; può superare `submitted` per il matching |
| `olderThanStart` | Righe escluse perché anteriori alla data configurata |
| `withoutAvailability` | Righe prive di movimento del wallet |
| `rejected` e `issues` | Errori di classificazione che impediscono il batch |
| `inflowMilliunits`, `outflowMilliunits`, `netMilliunits` | Importi aggregati in milliunits (1 € = 1.000 milliunits) |

L'API non indica con certezza quante nuove righe siano state create rispetto a quelle abbinate. Nel primo test reale, **5 movimenti inviati produssero 10 ID nella risposta**, ma YNAB li abbinò correttamente e non mostrò duplicati.

## Deploy e configurazione

Il Worker è collegato a GitHub, branch `main`. Per il deploy da Cloudflare:

- **Build command:** vuoto (Wrangler compila TypeScript).
- **Deploy command:** `npx wrangler deploy`.
- **Root directory:** `/`.

Le variabili non sensibili sono versionate in `wrangler.toml`:

```toml
[vars]
YNAB_WRITE_ENABLED = "true"
YNAB_PLAN_ID = "774d71aa-9e22-4991-a4cd-1e37aecda617"
YNAB_ACCOUNT_ID = "231101d1-9443-4f7e-a2ca-692199fc3b22"
YNAB_IMPORT_FROM = "2026-10-11"
```

L'account di destinazione è **Satispay** (on-budget) nel piano **Daniele**. Gli account **Stock Options Satispay** e **Satispay Salvadanaio Remunerato** non sono destinazioni di questo import.

**Secret configurati esclusivamente in Cloudflare Workers → Settings → Variables and Secrets:**
- `UPLOAD_TOKEN`: protegge gli endpoint HTTP; è usato dallo Shortcut.
- `YNAB_TOKEN`: Personal Access Token per l'API YNAB.

Non inserire mai token in `wrangler.toml`, README, commit, log o screenshot. I valori di `[vars]` versionati possono sovrascrivere impostazioni omonime effettuate nel dashboard ai deploy successivi.

### Sviluppo locale e test

Richiede Node.js 22+.

```sh
npm install
npm test
npm run check
npm run dev
```

Per usare il Worker in locale, crea `.dev.vars` con i Secret di sviluppo (file escluso da Git). È presente una GitHub Action che esegue `npm test` e `npm run check` sui push a `main`.

## Sicurezza e limiti noti

- Il Worker verifica che l'account YNAB di destinazione sia aperto, on-budget e abbia un nome contenente “Satispay”.
- I batch con date, ID, stato o importi non validi vengono bloccati completamente prima di scrivere. Un tipo Satispay sconosciuto è ammesso.
- Nessun export viene salvato: il file viene letto e processato in memoria. Le risposte non includono ID Satispay, nomi dei beneficiari, descrizioni o importi delle singole transazioni.
- Ogni import è **on-demand** e richiede un file Excel; non esiste accesso automatico all'account consumer Satispay.
- Non inviare export finanziari reali al repository GitHub. Le ricariche Fineco, gli spostamenti verso salvadanai e gli altri movimenti sono importati come entrate/uscite ordinarie, senza transfer automatici; riclassificali manualmente in YNAB.
- Se YNAB non trova un abbinamento, può creare un movimento nuovo che dovrai controllare prima della riconciliazione. Verifica soprattutto le ricariche e i movimenti fra conti propri.

## Test end-to-end

**18 ottobre 2026:** export con 23 righe, soglia 11/10/2026, 5 movimenti candidati, 16 anteriori alla soglia e 2 senza variazione di Disponibilità. Il batch inviato a YNAB aveva uscite da 30,40 €, entrate da 3,39 € e netto da −27,01 €. La verifica nell'app YNAB ha confermato matching corretto e **zero duplicati visibili**.

Il successo di questo test non garantisce il matching di tutti i movimenti futuri: continua a controllare YNAB dopo ogni import.

### Evoluzione del mapping — 18 ottobre 2026

L'esame dell'export storico Satispay (302 righe) ha mostrato ricariche bancarie, trasferimenti P2P, pagamenti con carta, movimenti verso salvadanai/investimenti e righe `Altro`. Su richiesta dell'utente il Worker è stato semplificato: **tutti i movimenti di Disponibilità con segno negativo diventano uscite, quelli positivi entrate; nessuna classificazione a transfer**. L'approvazione, la riclassificazione delle ricariche/trasferimenti e la riconciliazione restano manuali in YNAB. Gli `import_id` non sono stati modificati.

## Effect v4 architecture (proposed migration)

This branch uses the stable `effect@^4.0.2` runtime for side effects and orchestration, while keeping accounting calculations pure and deterministic.

- **HTTP adapter** (`src/index.ts`): one `Effect.runPromise` at the Cloudflare Worker request boundary. Upload streaming, multipart parsing, CSV parsing and route handling are composable effects with typed failures.
- **Workbook service** (`src/spreadsheet.ts`): `readSheetEffect` captures dynamic XLSX decoding failures without leaking data.
- **Import pipeline** (`src/import-handler.ts`): `readSheetEffect → buildImportPlan → sendToYnabEffect`, or dry-run without writes. Business failures preserve the current JSON response shapes and HTTP status codes.
- **YNAB client** (`src/ynab.ts`): typed `YnabError` failures for HTTP/network/decoding/guardrails and effectful SHA-256 import IDs. `fetchFn` stays injectable for tests. Promise-compatible exports remain for the existing tests.
- **Pure domain** (`src/csv.ts`, `src/preview.ts`, `src/import-plan.ts`, `src/ledger.ts`): no Effect wrappers around basic math. Their deterministic computation is integrated into Effect via the calling pipeline.
- The import ID prefix `SPS:`, SHA-256 input namespace and truncation, date cutoff, benefit allocation, mixed-refund logic, and all YNAB account safety guards are unchanged.

### Cloudflare Worker Preview deployment

The PR branch includes an isolated `[previews.vars]` section, required when the Cloudflare deployment command is `npx wrangler preview`. It intentionally sets `YNAB_WRITE_ENABLED = "false"` and uses placeholder YNAB plan/account UUIDs, so this preview **must not send transactions to a real YNAB plan**. Production `[vars]` are unchanged. Never copy production tokens into preview credentials.

You can smoke-test the unauthenticated `GET /health` route on the resulting Preview URL. Testing authenticated endpoints requires a separate Preview-specific `UPLOAD_TOKEN` secret; YNAB account discovery and live importing are intentionally **not supported** in this safe Preview configuration.

Run `npm test`, `npm run check`, and `npm run check:bundle` before considering merging; the last command produces a local dry-run bundle, **not a Cloudflare deployment**. The live Worker remains on `main` until this PR is merged. Existing Cloudflare Secrets and Wrangler vars are unchanged.

### Additional Effect v4 adoption

- The YNAB HTTP boundary now uses `Schema.decodeUnknownEffect` for plan/account/import responses instead of unchecked `any` casts. Malformed HTTP 200 replies fail with a typed `YnabError`; the importer **does not retry POST** on ambiguous responses.
- SHA-256 import IDs are constructed with `Effect.forEach({ concurrency: 4 })`, retaining deterministic input ordering and the original `SPS:` namespace.
- Effect-focused regression tests exercise malformed API JSON, account safety, matched transactions and hashing order using injected `fetch` implementations (no real YNAB calls).
- Effect v4 schemas require TypeScript 5.9+, now reflected in `package.json`.
- Pure Satispay ledger calculations, inclusion rules and mixed-refund logic stay untouched.
