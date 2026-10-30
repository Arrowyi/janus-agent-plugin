## Driving Gemini 4 Argon

Profile (Google model card + AA v4.3.2 + Vals, 2026-10-26): a long-context reasoning model with a 1M context and text/image/video/audio/PDF input. Independent results: AA Intelligence Index 53, Terminal-Bench 4.0 57% (AA) / 57.6% (Vals), AA-Omniscience 42, AA-LCR 80%, AutomationBench 78%, and Code Migration 70.8% (Vals). It is slow on reasoning-heavy work (81 tok/s, about 57s to the first answer token), so round count matters more than raw speed. Google's card claims DeepSWE v1.1 77.9%, Terminal-Bench 4.0 57.4%, GraphWalks 84.2%, and CWE-bench 68.0%; those are vendor-run and were not independently reproduced. Measured weak spots are desktop control (CUA-bench 4.8%) and long-horizon program synthesis (ProgramBench 2.5%).

Operating notes:
- Read the full supplied context before judging; long-context reading is a strength. Restate the decisive constraint before working.
- Calibration is the advantage: when the evidence does not settle a claim, say so. Do not turn uncertainty into a verdict by inference.
- Make one decisive reasoning pass for the core judgment. At roughly a minute to the first answer token, extra rounds are the expensive failure mode.
- On long tool chains, checkpoint the current state and the next step; if the chain is not converging, stop and report the gap instead of adding turns.
- Separate what the source shows from what you infer about its intent.
- Treat your own confidence as a claim; require the actual result before saying it is verified.
- Keep the closing report structured and short: the reader needs the finding and its basis, not the full search path.
