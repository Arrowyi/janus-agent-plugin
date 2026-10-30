## Research Mode

Use `research` when the user wants to understand a topic deeply rather than make an immediate decision — open-ended questions, "深度研究" / "深入研究" / "调查一下" / "research this", technology or topic surveys, and open-ended exploration. The goal here is understanding, not a recommendation: do not force a single verdict or a buy/do-this conclusion.

Research mode runs deep by default: a narrow, settled, single-source question may run standard, while broad or contested research stays deep. Tier changes the breadth, never the isolation rule: even at `standard`, a question spanning two or more sub-directions or needing more than two lookups dispatches parallel `explorer` instances, so raw search noise stays out of the synthesis context. Pair the explorers with `auditor` when community, vendor, or advocacy sources carry weight, with `analyst` for mechanism modeling or conflicting evidence, and with `critic` using `protocol: "hypothesis_matrix"` or `"counter_evidence"` to stress-test any material hypothesis.

Workflow:

1. Decompose the question into 2-4 sub-directions.
2. Dispatch independent explorers for sub-directions whose evidence is missing or whose coverage is uncertain. Parallelize independent searches, not dependent analysis (source grading and the channel ladder still apply).
3. Compare the evidence: consensus, disagreements, and gaps. Record disagreements; do not hide gaps.
4. Form 2-3 hypotheses, each with a confidence, its supporting evidence, and its counter-evidence. Actively look for counterexamples and hidden variables.
5. Challenge material hypotheses with a critic pass when you can name a counterexample or alternative that would change the report. Hand it the hypotheses and evidence; address every substantive objection (adopt it, lower confidence, or research further), up to the round cap. When no consequential hypothesis exists, do not create one merely to justify a critic call.
6. Synthesize into a readable report.

The report is for a busy human reader, not an academic. Lead with the bottom line (BLUF), write in plain language, and put the detail under `证据与来源（可跳过）` — conclusion and key points first, evidence and disagreements on demand. Never output invented numerical confidence.

Research explains a topic; deciding the system's future structure is `design`.

<!-- part -->

### research: bottom line then meaning

Short:

```text
结论：<one plain sentence>。
要点：
- ...
- ...
- ...
这对你意味着：...
下一步：<next useful angle>。
把握：...
```

Full:

```text
结论：...
关键点：
- ...
- ...
- ...
这意味着什么：...
还不确定：...
把握：...
（可选）多个解释：
- 解释 A：...；支持...；反例...
- 解释 B：...；支持...；反例...

证据与来源（可跳过）
...

一句话：...
下一步：...
```
