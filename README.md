# Satispay → YNAB (inspect-only)

Cloudflare Worker for uploading an Excel **.xlsx** or CSV export from Satispay using the iOS Share Sheet and Apple Shortcuts.

**Safety:** this phase inspects file format, headers, row count and aggregate schema diagnostics (types/statuses, ID uniqueness and financial-field shapes). No individual transaction data is returned. No YNAB API calls or file storage are implemented.

## Deploy

Node.js >= 22. Cloudflare Workers builds from GitHub with an empty build command and deploy command `npx wrangler deploy`.

```sh
npm install
npm test
npm run check
npx wrangler secret put UPLOAD_TOKEN
npm run deploy
```

Create a random token (e.g. `openssl rand -hex 32`) and store it as `UPLOAD_TOKEN` in Cloudflare Workers Settings → Variables and Secrets. Never commit it. For local testing use `.dev.vars` (already gitignored).

## iPhone Shortcut configuration

1. In **Shortcuts**, create "Import Satispay" and enable **Show in Share Sheet**; accept files.
2. Add **Get Contents of URL** with `https://satispay-ynab-import.daniele-trapani.workers.dev/inspect`.
3. Method: `POST`; header `Authorization`: `Bearer YOUR_UPLOAD_TOKEN`.
4. **Request Body → File → Shortcut Input**. Do not choose JSON or Form. Do not manually set `multipart/form-data`.
5. Add **Show Result** (or extract `rowCount`, `columns`, `format` and `message` from the JSON).
6. Export Excel from Satispay and share the .xlsx into your Shortcut. If necessary, save it to Files first and share it from there.

The Worker now accepts raw request bodies (ideal for Shortcuts) and still supports multipart/form-data where the file field is called `file`. It detects XLSX by the ZIP signature, so a filename is not needed for raw uploads. Old binary `.xls` files are not supported.

## API

`GET /health`: returns `ok`, `mode: "inspect-only"`, `formats: ["xlsx","csv"]`, `upload: ["raw","multipart"]`.

`POST /inspect`: bearer token required, binary file in request body or multipart field `file`. Response contains `columns`, `rowCount`, `format`, `analysis` and `imported: 0`. Analysis only contains counts and categorical values, never individual names, descriptions, amounts, IDs or ledger balances. File content is held in memory and discarded. Maximum file size 4 MB, maximum request size 4.5 MB.

Example with CSV (same upload mechanism as Excel):

```sh
curl -X POST 'https://satispay-ynab-import.daniele-trapani.workers.dev/inspect' \
  -H 'Authorization: Bearer YOUR_UPLOAD_TOKEN' \
  -H 'Content-Type: application/octet-stream' \
  --data-binary @samples/fake-export.csv
```

For XLSX set Content-Type to `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` (or leave it as octet-stream).

## Next

Inspect an actual Satispay export to identify columns, dates, amounts, account transfers and stable transaction IDs. Then add YNAB mapping, a D1 deduplication ledger, explicit preview and safe idempotent imports. A transfer from Revolut to Satispay must not become a duplicated expense.

Never upload raw financial exports, credentials, or access tokens to the GitHub repository.

## Weekly preview without financial writes

Use the same Shortcut with endpoint `/preview` instead of `/inspect`, and send the Satispay Excel as **Request Body → File**. Authentication remains the same. The JSON contains `eligible`, `skipped`, `requiresReview`, `inflowEur`, `outflowEur`, `netEur`, grouped `byType` and `byReason`. No names, transaction IDs, descriptions or line-item amounts are returned.

- Uses only `Disponibilità` (not `Importo`); skips rows with no wallet movement, e.g. meal vouchers or FlexBen-only purchases.
- Known payment type: `🏬 a un Negozio`.
- Known incoming types: `🎖️ Punti` and `Rimborso` **when the wallet amount is positive**.
- Unknown/new types, Fineco top-ups, missing/duplicate IDs, invalid dates and non-approved states are flagged `requiresReview` and are never imported.
- The current prototype **cannot** determine if movements already exist in YNAB: `eligible` means *potentially importable*, not *new*.
- No YNAB token, no D1 and no POST to YNAB yet; `imported: 0` always.

Satispay users who track only wallet money should *not* count Buoni Pasto or FlexBen as YNAB expenses. Future Fineco ↔ Satispay recharges must be transfers instead of income or expenses. Validate the live preview and match it to your weekly reconciliation before turning on writes.

## Precisione monetaria

In `/preview`, `outflowEur`, `inflowEur` e `netEur` sono **stringhe decimali a due cifre** (per esempio `"90.23"`). I campi `outflowMilliunits`, `inflowMilliunits` e `netMilliunits` sono numeri interi esatti per YNAB (per esempio `90230`). Questo evita rappresentazioni come `90.230000000000004` su Apple Shortcuts. La logica di importazione rimane disabilitata.

## Fase 1: importazione YNAB (abilitazione esplicita)

Il Worker implementa il percorso settimanale Excel → Apple Shortcuts → YNAB, **disabilitato per default**. I vecchi endpoint `/inspect` e `/preview` restano invariati.

### Configurazione Cloudflare e Wrangler

Le variabili non sensibili vanno versionate nel file `wrangler.toml`, nella sezione `[vars]`. Attualmente `YNAB_WRITE_ENABLED = "false"` è impostato e viene distribuito da GitHub. Aggiungere `YNAB_PLAN_ID`, `YNAB_ACCOUNT_ID` e `YNAB_IMPORT_FROM` **solo quando conosciamo i valori reali**. Non inserire placeholder effettivi.

Le credenziali `UPLOAD_TOKEN` e `YNAB_TOKEN` rimangono **Secrets** in Cloudflare, non in Git. Le variabili dichiarate in `[vars]` prevalgono su eventuali omonime impostate manualmente nel dashboard ai deploy successivi.

Riferimento delle impostazioni:

| Key | Type | Descrizione |
| --- | --- | --- |
| `YNAB_TOKEN` | Secret | Personal Access Token da YNAB → Account Settings → Developer Settings |
| `YNAB_PLAN_ID` | Wrangler `[vars]` | UUID del piano YNAB; non usare valori inventati |
| `YNAB_ACCOUNT_ID` | Wrangler `[vars]` | UUID dell'account Satispay **on-budget** esistente |
| `YNAB_IMPORT_FROM` | Wrangler `[vars]` | Data ISO YYYY-MM-DD **inclusiva**: prima data che vuoi importare; consigliato il giorno successivo all'ultima data già completamente riconciliata |
| `YNAB_WRITE_ENABLED` | Wrangler `[vars]` | Tenere `false` durante i primi test; usare `true` soltanto quando si è pronti |
| `UPLOAD_TOKEN` | Secret | Token già usato nello Shortcut |

I secret vanno inseriti solo in Cloudflare, **mai in chat o su GitHub**.

Per trovare gli UUID: dopo aver aggiunto `YNAB_TOKEN`, inviare `GET /ynab/accounts` con l'header `Authorization: Bearer <UPLOAD_TOKEN>`. La risposta mostra soltanto account che contengono "Satispay" nel nome, con i relativi `planId` e `accountId`. Configurare gli UUID del conto corretto.

### Sequenza sicura del primo import

1. Impostare `YNAB_IMPORT_FROM` sulla **prima data da importare**. Attenzione: il filtro è inclusivo (`>=`). Evitare date dello storico già importato prima della riconciliazione, perché YNAB non abbina automaticamente due transazioni entrambe importate con ID diversi.
2. Mantenere `YNAB_WRITE_ENABLED=false`. In Shortcuts cambiare URL in `https://satispay-ynab-import.daniele-trapani.workers.dev/prepare`, metodo POST, header Authorization uguale a prima, corpo **File → Input comando rapido**.
3. Esaminare `eligible`, `olderThanStart`, `withoutAvailability`, `rejected` e `netMilliunits`. Se `rejected > 0`, fermarsi: una tipologia sconosciuta potrebbe essere una ricarica Fineco (trasferimento).
4. Impostare `YNAB_WRITE_ENABLED=true` solo quando data e account sono corretti. Cambiare l'URL dello Shortcut in `/import`; aggiungere l'header `X-Confirm-Import: yes`.
5. Condividere l'Excel. Il Worker invia al massimo 100 movimenti in un batch, con `import_id` stabili, `approved: false`, `cleared: "cleared"`. Verificare l'import in YNAB, approvare e riconciliare.

Rieseguire lo stesso export è sicuro per gli elementi già importati da **questo Worker**: il loro `import_id` non cambia. YNAB tenterà anche il matching con le transazioni inserite manualmente con stesso importo e data entro ±10 giorni. Il match **non è garantito**: YNAB può creare un nuovo movimento quando non trova quello manuale o quando il movimento era stato importato con un altro `import_id`.

### Policy contabile

- Importare **soltanto** `Disponibilità`, mai `Importo` se parte del pagamento è coperta da buoni pasto o FlexBen.
- Importare `🏬 a un Negozio` soltanto se importo Disponibilità è negativo; `🎖️ Punti` e `Rimborso` soltanto se è positivo.
- Ignorare le righe senza Disponibilità o con movimento pari a zero.
- Rifiutare importazione se ci sono ID duplicati/mancanti/non testuali, date non valide, transazioni non approvate, importi non in centesimi, o tipi sconosciuti con saldo Disponibilità.
- Le ricariche **Fineco → Satispay** dovranno essere mappate come trasferimenti in un aggiornamento successivo: **non** importarle come entrate per ora.
- Nessun database: i movimenti sono inviati direttamente e la deduplicazione ripetuta si basa sugli import IDs YNAB.
- Il piano di import viene costruito in memoria e non viene salvato né scritto nei log. Le risposte espongono solo conteggi e somme aggregate, mai le transazioni individuali.

### API aggiuntive

- `GET /ynab/accounts` — elenca solo gli account Satispay accessibili tramite il token.
- `POST /prepare` — stesso Excel di `/preview`, ma con filtro `YNAB_IMPORT_FROM` e classificazione rigorosa; **non scrive**.
- `POST /import` — accetta solo Excel, richiede `Authorization` e `X-Confirm-Import: yes`, una data di inizio, token e account YNAB validi e `YNAB_WRITE_ENABLED=true`. Rifiuta il batch intero se trova movimenti ambigui.

Non usare `/import` per importare l'intero storico senza aver scelto accuratamente la data di partenza.
