## Driving Claude Haiku 5.5

Profile (Anthropic model card + Vals, 2026-10): quick short-horizon agentic and review work (Vibe Code Bench 90.44%; about 257 tokens/s). At high or max settings it over-explains, and inputs above 100K tokens bill at the 5× input tier ($0.10 → $0.50 per million input tokens; the $0.50 output rate is unchanged), so long inputs are the main avoidable expense.

Operating notes:
- Work from the provided patch or excerpt directly: return the structured findings and the verdict (pass / revise / block) without re-narrating the content around them.
- Decide from what is given; the input already bounds the question — one read, one structured reply beats exploratory sprawl.
- Inputs past 100K tokens bill at the 5× tier: keep the read tight and finish in one pass rather than spreading over many turns.
- For multi-part inputs, label each part with its own finding instead of blending them into prose.
