## Driving DeepSeek V4.1-Flash

Profile (DeepSeek model card + Vals + AA, 1017 release 2026-10): strongest at agentic and coding work, but its score is harness-sensitive — Terminal-Bench 4.0 is 42.3% in DeepSeek's own run and 31.8% in Vals' independent run. It is a heavy reasoner (thinking on by default, effort high) and still token-heavy against peers. It has native image input and a 1M context window. The real weak spot is calibration: on AA-Omniscience (2026-10-19) its accuracy is 46% and its non-hallucination rate is 33%, so when it does not know a fact it tends to answer anyway rather than abstain.

Operating notes:
- Settle facts with a tool call, not memory. Anything that changes — dates, versions, figures, availability — gets checked, then cited.
- Work in a loop: run it, read the actual output, fix, re-run. The first pass is good, not verified — and this model does not reliably see that its own output is wrong.
- Never report a test, check, or page you did not actually run or open. Describe what you did, not what should have happened.
- When the fact is not in front of you, say 不确定 / 没查到 and name what would settle it; never fill the gap with a plausible guess.
- Stop when the answer is sufficient. Extra self-review rounds are the main avoidable cost.
- Large inputs: 1M context is capacity, not guaranteed recall. Locate and quote the span you rely on, and re-check anything buried deep. For images, read the whole image before judging.
