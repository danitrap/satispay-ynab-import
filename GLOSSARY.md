# Satispay to YNAB

This context represents movements in a Satispay cash wallet within a YNAB plan. Its language covers funding, import eligibility and identity, transaction review, and balance reconciliation.

## Language

### Movements and funding

**Satispay movement**:
A financial event recorded by Satispay, such as a purchase, refund, wallet top-up or payment to another person. A movement can affect the cash wallet, benefit balances, or both.
_Avoid_: Transaction, when the distinction from a YNAB transaction matters.

**Cash wallet**:
The money held in Satispay that is represented in the YNAB wallet account. Meal vouchers and other benefit balances are outside this wallet.
_Avoid_: Satispay balance, when it includes benefits.

**Benefit balance**:
A separately held Satispay balance for meal vouchers or other benefits, such as Buoni Pasto or FlexBen.

**Funding split**:
The allocation of a purchase's nominal amount between the cash wallet and benefit balances. A purchase with mixed funding uses both.

**Nominal amount**:
The total signed value of a Satispay movement, including its cash and benefit portions, reported as “Importo” in the export.
_Avoid_: Wallet amount, total wallet amount.

**Reported wallet amount**:
The signed amount in the export's “Disponibilità” field. For some merchant refunds, it can include returned benefits and therefore overstate the actual cash wallet inflow.
_Avoid_: Wallet balance, verified wallet amount.

**Wallet amount**:
The signed change attributable to the cash wallet for a Satispay movement: positive for an inflow and negative for an outflow. Benefit portions are outside this amount.
_Avoid_: Nominal amount, wallet balance.

**Wallet balance**:
The amount held in the cash wallet at a particular point in its transaction history.
_Avoid_: Wallet amount, nominal amount.

**Merchant refund**:
A Satispay movement returning value from an earlier merchant purchase. Its nominal amount can include both cash and benefit portions.

**Original purchase**:
The merchant purchase to which a merchant refund relates. Its funding split provides evidence of the refund's wallet amount.
_Avoid_: Matched transaction, which refers to a YNAB transaction.

### Import selection and identity

**YNAB plan**:
The user's financial plan in YNAB containing the destination wallet account and spending categories.

**YNAB wallet account**:
The account within a YNAB plan that represents the Satispay cash wallet.
_Avoid_: Satispay account, when referring to the YNAB representation.

**YNAB transaction**:
A financial entry in the YNAB wallet account representing an inflow or outflow. It can originate from this importer or already exist in YNAB.

**Import cutoff**:
The inclusive first date of the period selected for import. An export can also contain earlier movements as evidence for interpreting refunds.
_Avoid_: Export start date.

**Import candidate**:
A Satispay movement in the selected import period with usable essential data, approved Satispay status and a nonzero wallet amount or provisional wallet amount.
_Avoid_: Imported transaction, before its import outcome is known.

**Skipped movement**:
A Satispay movement outside the selected import period or without an indicated cash-wallet movement, including benefit-only movements and zero wallet amounts.
_Avoid_: Rejected movement.

**Rejected movement**:
A Satispay movement excluded from a particular import because its essential data is unusable or its Satispay status is not approved. Missing or repeated source identifiers, invalid dates and unreadable amounts are examples.
_Avoid_: Unimportable transaction, skipped movement, ambiguous transaction.

**Import batch**:
A group of import candidates submitted together to YNAB as part of an import.

**Import identity**:
The stable identity linking a Satispay movement to its YNAB representation across repeated or overlapping exports.
_Avoid_: Export row number, YNAB transaction identity.

**Duplicate import candidate**:
An import candidate whose import identity YNAB recognizes as already imported into the destination account.
_Avoid_: Duplicate export row, matched transaction.

**Matched transaction**:
An existing YNAB transaction associated by YNAB with a submitted import candidate.
_Avoid_: Original purchase, duplicate import candidate.

### Review and reconciliation

**Ambiguous transaction**:
A Satispay movement whose wallet amount cannot be established with certainty from the available export evidence. Missing purchase history, multiple possible original purchases and inconsistent funding splits can cause ambiguity.
_Avoid_: Rejected movement, uncertain import outcome.

**Provisional wallet amount**:
An amount used to represent an ambiguous transaction's cash wallet impact pending verification during transaction review.
_Avoid_: Verified wallet amount.

**Provisional transaction**:
A representation of an ambiguous transaction using a provisional wallet amount and requiring transaction review. It can be an import candidate before submission or a YNAB transaction after import.

**Satispay approval**:
The status in Satispay indicating that a movement is approved.
_Avoid_: Approval, without identifying Satispay or YNAB.

**YNAB approval**:
The review status indicating that a YNAB transaction has been accepted by the user.
_Avoid_: Satispay approval, cleared status, reconciliation.

**Cleared status**:
The status indicating whether a YNAB transaction is confirmed against the cash wallet's recorded activity.
_Avoid_: Approval, reconciliation.

**Transaction review**:
The user's examination and, where necessary, correction of a YNAB transaction's amount, payee, category and status. Review of a provisional transaction includes verifying its wallet amount.

**Wallet balance check**:
A comparison between the change in exported wallet balances and the wallet amounts of movements in the same interval.
_Avoid_: YNAB reconciliation.

**Balance discrepancy**:
A difference between the balance change indicated by exported wallet balances and the total wallet amount established for the corresponding interval.

**YNAB reconciliation**:
The user's confirmation that the YNAB wallet account agrees with a verified cash wallet balance at a particular point in time.
_Avoid_: Transaction review, wallet balance check.

**Uncertain import outcome**:
An import batch outcome in which YNAB may have accepted candidates but their acceptance cannot be confirmed.
_Avoid_: Ambiguous transaction.

**Partial import**:
An import with confirmed results for some candidates while other candidates have failed, have an uncertain import outcome or remain unattempted.
