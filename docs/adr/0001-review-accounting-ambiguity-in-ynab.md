# Review accounting ambiguity in YNAB

Accounting ambiguity in a Satispay movement must not by itself block the import: accept a provisional transaction and make its uncertainty explicit for user review in YNAB. This trades immediate accounting certainty for import continuity and a review workflow in the user's existing financial tool, rather than requiring resolution before import. An uncertain YNAB write outcome remains a separate concern: transaction POSTs retain the single-attempt policy.

Use the reported “Disponibilità” amount as the provisional wallet amount, accepting that the YNAB balance may temporarily be inaccurate. Preserve the original payee and distinguish provisional transactions with an orange flag and a memo explaining the uncertainty, the assumption and what to verify. Provisional transactions are uncleared and unapproved until user review. The user corrects the amount, status and review annotations directly in YNAB; subsequent imports preserve those edits through the existing stable import identity rather than overwriting the transaction.

A transaction with unusable essential data is excluded and explicitly reported in the import response without blocking other eligible transactions. This exception avoids inventing missing financial data to satisfy import continuity.

An export-wide balance discrepancy without an identifiable responsible transaction is reported in the import summary. Transaction flags and review memos are reserved for uncertainty attributable to that transaction.
