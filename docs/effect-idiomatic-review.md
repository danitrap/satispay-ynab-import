# Revisione dei pattern Effect

Confronto con i sorgenti locali Effect 4.0.5, commit
`7f524e25cfb49a71ac39b0f44278d08d40dda5de` (vedi `vendors.lock`).
I cinque interventi descritti sotto sono stati implementati. Il testo conserva
il ragionamento della revisione iniziale: il decoder espone ora Effect, le durate
usano `trackDuration`, l'envelope YNAB viene decodificato con Schema, i token
restano Redacted fino a `bearerToken` e i wrapper generator usano `fnUntraced`.
La validazione dell'envelope resta separata da quella dei payload per preservare
i motivi di errore pubblici e i confini dei retry.

## 1. Esporre Effect nel contratto WorkbookReader

In `src/workbook-reader.ts:8`, `read` restituisce una Promise; la conversione e
la classificazione degli errori avvengono nel consumatore (`src/spreadsheet.ts:133`).
Proporrei `read(file): Effect.Effect<SheetCell[][], WorkbookError>`, spostando
`Effect.tryPromise` nell'implementazione live. Il servizio dichiarerebbe così anche
i fallimenti attesi; i fake potrebbero restituire direttamente `Effect.succeed`,
`Effect.fail` ed `Effect.die`. Spostare il tipo di errore in un modulo condiviso
eviterebbe una dipendenza circolare tra decoder e analisi.

La Promise resta appropriata dentro l'adapter della libreria esterna. Questo
refactoring non rende cancellabile una libreria che non supporta AbortSignal.

Fonti: `vendor/effect/LLMS.md:122` e
`vendor/effect/ai-docs/src/50_http-client/10_basics.ts` mostrano servizi con
operazioni Effect ed errori dichiarati.

## 2. Usare il combinatore nativo per le durate

`src/telemetry.ts:15` sottrae due letture di `Clock.currentTimeNanos`.
`Effect.trackDuration` usa invece il clock monotono e aggiorna la metrica in
`onExit`, anche in caso di fallimento o interruzione.

Si può mantenere l'istogramma e l'unità attuali con:

```ts
Effect.trackDuration(
  Metric.withAttributes(operationDuration, { operation }),
  Duration.toMillis,
)
```

Mantenere il contatore basato su Exit: sostituirlo soltanto con
`trackSuccesses`/`trackErrors` cambierebbe la copertura di difetti e interruzioni.
Verificare i quattro esiti con TestClock e registry isolato.

Fonti: `vendor/effect/packages/effect/src/Effect.ts:14731`,
`vendor/effect/packages/effect/src/Clock.ts:311` e
`vendor/effect/packages/effect/src/Clock.ts:333`.

## 3. Validare anche l'envelope delle risposte YNAB con Schema

`src/ynab.ts:109` legge JSON e verifica manualmente la presenza di `data`;
i chiamanti decodificano poi il payload. Uno Schema per l'envelope
`Schema.Struct({ data: PayloadSchema })` renderebbe esplicito il contratto completo.
`HttpClientResponse.schemaBodyJson` è disponibile per comporre lettura e decoding.

Nel refactoring preservare le distinzioni esistenti tra JSON invalido, payload
invalido, account malformato ed esito POST incerto. Preservare anche il confine
dei retry: gli errori Schema non devono diventare errori di rete ritentabili.
Decodificare entro lo scope e la deadline della richiesta senza far uscire una
response il cui scope è già stato chiuso.

Fonti: `vendor/effect/packages/effect/src/http/HttpIncomingMessage.ts:80` e
`vendor/effect/ai-docs/src/50_http-client/10_basics.ts`.

## 4. Passare Redacted fino all'helper di autenticazione

In `src/ynab.ts:88` l'header Authorization è costruito manualmente e i chiamanti
estraggono il token in anticipo. `HttpClientRequest.bearerToken` accetta direttamente
`Redacted.Redacted`: i helper interni potrebbero accettare quel tipo, evitando
conversioni ripetute a stringa. L'header HTTP conterrà comunque il token in chiaro:
è una semplificazione del codice e della gestione del valore, non una nuova
garanzia di sicurezza del trasporto o dei log.

Fonte: `vendor/effect/packages/effect/src/http/HttpClientRequest.ts:432`.

## 5. Uniformare le funzioni generator riutilizzabili

`handleRequestEffect` in `src/index.ts:122` e `postApiEffect` in `src/ynab.ts:137`
sono funzioni che costruiscono un `Effect.gen`. Usare `Effect.fn` quando serve
uno span, `Effect.fnUntraced` per helper interni. Lasciare invece `makeYnabClient`
come valore Effect: è un programma di costruzione del servizio.

Fonte: `vendor/effect/LLMS.md:13` e `vendor/effect/LLMS.md:51`.

## Scelte da mantenere

- Dominio finanziario puro, unità branded e conversioni esatte.
- `requestLiveLayer` come composition root per richiesta e configurazione lazy.
- Contratti YNAB indipendenti dalle dipendenze dell'implementazione.
- Scope HTTP comprensivo della lettura del body, retry limitati ai GET e POST singolo.
- Errori tipizzati distinti dai difetti inattesi e risposte prive di dettagli sensibili.
- Test sintetici con servizi iniettati e TestClock.

Il cleanup upload in `src/index.ts:58` ha una ragione concreta: con
`releaseLockOnEnd: true`, il finalizer del reader rilascia il lock, mentre quello
esterno cancella il body. Non rimuoverlo soltanto per accorciare il codice.
Fonte: `vendor/effect/packages/effect/src/Channel.ts:1891`.

HttpRouter/HttpApi e @effect/vitest sono opzioni per una futura crescita di API
e test; da soli non giustificano una migrazione dell'attuale router e test runner.

## Validazione

Eseguiti `npm run check`, `npm test`, `npm run format:check` e il bundle dry-run:
TypeScript valido, 83 test passati, formattazione e bundle riusciti. Per il bundle,
`XDG_CONFIG_HOME` e `WRANGLER_LOG_PATH` puntano a `/tmp` per rispettare la sandbox.
Le nuove regressioni coprono il clock Unix che arretra, tutti gli esiti della
telemetria, errori/difetti del decoder iniettato e risposte YNAB malformate senza
retry. Non sono stati eseguiti import reali.
