# Domain docs

This repository is a single context: a Cloudflare Worker that imports Satispay `.xlsx` exports into YNAB. There is no `GLOSSARY-MAP.md`.

- `GLOSSARY.md` at the repository root.
- Architecture decision records under `docs/adr/`.

```text
/
├── GLOSSARY.md
├── docs/adr/
│   ├── 0001-review-accounting-ambiguity-in-ynab.md
│   └── 0002-keep-import-processing-in-memory.md
└── src/
```

## Before exploring

Read `GLOSSARY.md` and any ADRs relevant to the area being explored. If they do not exist, proceed silently. The domain-modeling skill creates them lazily when terminology and decisions are resolved.

## Vocabulary

Use glossary terms in issues, proposals, hypotheses, tests, and documentation. Reconsider unfamiliar terminology before introducing it; record genuine gaps for domain-modeling.

## Decisions

Explicitly identify any proposal that contradicts an existing ADR, link the decision, and explain why it should be reconsidered.
