# Keep import processing in memory

The iPhone Share Sheet workflow must process exports and import progress entirely in memory, without persisting transaction data or job state outside YNAB. Retain request-bound processing rather than introducing a durable background import job, accepting reduced recoverability in exchange for avoiding additional storage of financial data.

If the connection is lost, the caller may not receive a final summary even though some transactions reached YNAB. There is no durable job status to recover. Stable import identities remain available for deduplication, and uncertain YNAB writes still require user verification before resubmission.

Allow up to 10,000 import candidates within the existing 4 MB file limit, submitted in sequential batches of 500. Stop at the first failed batch and report confirmed progress, duplicates, uncertain or rejected batch candidates, and candidates not yet attempted. The candidate limit does not count older or otherwise excluded export rows; those rows can still provide purchase history for refund interpretation.
