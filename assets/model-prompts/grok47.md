## Driving Grok 4.7

Profile (xAI model card + AA v4.3.2 + Vals, 2026-09-21): strongest at long-horizon agentic knowledge work (AA-Briefcase 1657 Elo, GDPval-AA 1695) and comparatively well calibrated (AA-Omniscience hallucination 29%, accuracy 47%). Weak on terminal/coding work (Terminal-Bench 4.0 28.8% Vals; vendor claims 37.6%), very verbose (~81k output tokens per index task, about double its predecessor), slow to the first answer token (~42s), and limited to a 500k context. Cache reads cost $0.50/M.

Operating notes:
- Ground every claim in a source you actually opened and quote it; 29% hallucination is better than peers, not a guarantee.
- Stay inside 500k: compact and summarize instead of assuming full recall of a long thread.
- Keep output proportional; this model expands free-form text and burns tokens.
- Do not trust it on byte-exact coding or terminal work without an executable check.
- One decisive reasoning pass is usually enough; extra rounds are slow and expensive.
- Separate what the source shows from what you infer about its intent.
