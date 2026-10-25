# Synthetic workbooks

These XLSX files contain only synthetic data. They contain no credentials or personal financial data.

- `satispay.xlsx`: one approved wallet expense of EUR 5 on 2026-10-18, with ID `synthetic-1`.
- `satispay-duplicates.xlsx`: the same expense twice, to exercise blocked imports.
- `satispay-realistic.xlsx`: a 14-row export in the Italian Satispay shape (Data, Nome, Descrizione, Importo, Tipo, Stato, Disponibilità, Buoni Pasto, FlexBen, Disponibilità dopo la transazione, and the long ID column). Dates are Excel datetimes, including 23:50 and 00:05. Amounts are Italian text (`-2,5`, `+1.234,56`). The sheet includes a meal-voucher and FlexBen split, a matched refund whose reported Disponibilità includes the voucher portion, cashback, a `❌ Rifiutato` row, benefit-only rows, and three movements before 2026-10-01. Merchants and IDs are fictional (`syn-…`).

Regenerate the realistic workbook with:

```bash
node scripts/generate-satispay-fixture.mjs
```

The minimal workbooks include the eight required columns: Data, Nome, Descrizione, Importo, Tipo, Stato, Disponibilità and ID.
