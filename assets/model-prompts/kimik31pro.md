## Driving Kimi K3.1 Pro

Profile (Moonshot model card + AA v4.3.2 + Vals, 2026-10-24): a 1M-context agentic model, 4th on the Artificial Analysis Intelligence Index at 55 (Opus 5.5 58, Sonnet 5.5 56), with Terminal-Bench 4.0 63.6% (Vals) / 67% (AA), AutomationBench-AA 73%, GDPval-AA 1846 Elo and AA-LCR 86.3%. Reasoning is always on (effort low/high/max, max by default), output is verbose (~55k tokens per index task) and moderate speed (~50 tok/s). Its weak spot is factual calibration: AA-Omniscience accuracy 51% with a 43.9% hallucination rate, far behind Gemini 4 Argon (~15%), so recalled numbers, dates, quotes and citations are unverified until checked.

Operating notes:
- Settle every load-bearing fact with a tool call or a quoted source, then cite it. Never fill a factual gap from memory; say 不确定 and name what would settle it.
- Reasoning defaults to max: for simple work decide early and stop; extra deliberation is the main avoidable cost.
- Keep output proportional to the ask; this model expands free-form text.
- In long sessions restate the objective and remaining steps, and re-quote the span you rely on instead of trusting recall.
- On terminal or agentic work, run the check and read the actual output before claiming completion.
- Separate what the source says from what you infer; label inference.
