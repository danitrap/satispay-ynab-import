# Satispay → YNAB (fase 0: upload + CSV inspect)

Cloudflare Worker starter per il flusso iOS Share Sheet → Apple Shortcuts → Cloudflare Worker → (in futuro) YNAB.

**Questa versione non importa nulla in YNAB.** Verifica il CSV e restituisce intestazioni, separatore e numero di righe, senza conservare il file e senza token YNAB.

## Setup

Richiede Node.js >= 22 e Cloudflare:

```bash
npm install
npm test
npx wrangler login
npx wrangler secret put UPLOAD_TOKEN
npm run deploy
```

Generare un segreto casuale, ad esempio `openssl rand -hex 32`, e **non committarlo**. Per lo sviluppo locale, inserirlo in `.dev.vars` (`UPLOAD_TOKEN=...`; file escluso da Git).

## Endpoint

```http
POST https://satispay-ynab-import.<subdomain>.workers.dev/inspect
Authorization: Bearer <UPLOAD_TOKEN>
Content-Type: multipart/form-data

file = export.csv
```

L'endpoint `GET /health` è pubblico e risponde con la modalità corrente.

Test manuale:

```bash
npm run dev
curl -sS -X POST http://127.0.0.1:8787/inspect \
  -H 'Authorization: Bearer IL_TUO_TOKEN' \
  -F 'file=@samples/fake-export.csv'
```

## Comando Rapido iOS

1. Creare **Import Satispay → YNAB** nell'app Comandi Rapidi.
2. Abilitare **Mostra nel foglio di condivisione** e accettare file in input.
3. Aggiungere **Ottieni contenuti URL**, metodo POST, con l'URL del Worker e path `/inspect`.
4. Impostare l'header `Authorization` a `Bearer IL_TUO_TOKEN`.
5. Impostare corpo su **Modulo**, chiave `file`, tipo File, valore **Input comando rapido**.
6. Visualizzare il JSON restituito con **Mostra risultato**.
7. Esportare un CSV da Satispay, aprire il foglio di condivisione e scegliere lo Shortcut. Se necessario, salvare prima il CSV nell'app File.

Il percorso e il formato di esportazione da Satispay su iOS sono ancora da verificare.

## Sicurezza e limiti

- `UPLOAD_TOKEN` è obbligatorio per `POST /inspect`.
- Non inviare credenziali, token o export bancari reali su GitHub.
- CSV max 1 MB, request body max 1.2 MB.
- Il file è elaborato soltanto in memoria. La risposta include filename, intestazioni, separatore e conteggio righe, non i dati delle righe.
- Lo Shortcut contiene un segreto: non condividerlo senza rimuovere il token.

## Prossimi passi

**Prima di abilitare scritture su YNAB serve analizzare un export reale** (possibilmente anonimizzato):

1. Verificare colonne, data locale Europe/Rome, tipo transazione, controparte, segno e importo.
2. Individuare un identificativo Satispay stabile, se presente.
3. Aggiungere D1 per deduplicazione e storico.
4. Implementare `POST /preview` per dry-run e `POST /import` solo dopo conferma.
5. Aggiungere token YNAB come Cloudflare Secret e usare `import_id` deterministici.
6. Gestire le ricariche da Revolut come trasferimenti e non spese duplicate.
7. Allineare l'import allo Starting Balance e alla riconciliazione periodica di YNAB.

**Workflow desiderato:** ogni settimana esportare il mese in corso, selezionare Condividi → Shortcut e importare soltanto le transazioni nuove. A inizio mese includere anche il mese precedente.
