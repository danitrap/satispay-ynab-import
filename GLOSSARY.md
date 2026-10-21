# Satispay to YNAB

This context represents Satispay wallet movements in YNAB, including movements whose accounting interpretation requires review.

## Language

**Ambiguous transaction**:
A Satispay movement whose effect on the tracked wallet cannot be uniquely established from the available export evidence.

**Provisional transaction**:
A transaction accepted into YNAB with an explicitly uncertain accounting interpretation, pending review.

**Provisional wallet amount**:
The amount reported in the export's “Disponibilità” field when the wallet impact of an ambiguous transaction cannot be established with certainty.

**Transaction review**:
The user's examination and, where necessary, correction of a provisional transaction in YNAB.

**Unimportable transaction**:
A Satispay movement that cannot be imported because essential data, such as its date, identifier or amount, is unusable or its Satispay status is not approved.

**Import candidate**:
A Satispay wallet movement in the selected date range that is eligible for representation in YNAB, including provisional transactions.

**Import batch**:
A group of import candidates submitted together to YNAB as part of an import.
