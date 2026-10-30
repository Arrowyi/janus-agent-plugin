### select: choose and try

`select` covers any choice among candidate options under constraints and trade-offs: a behavioral pattern or habit, a communication or work strategy, a career or life choice, a technical stack or tool, or a physical or digital product. It is not for choosing a future system structure — an architecture, module boundary, or interface decision is `design`.

Three failure modes dominate it: unverified attributes or causal efficacy, survivorship/promotional/incentive bias in testimonials or rankings, and narrow candidate framing that hides a better option.

Dispatch baseline:

- `explorer` whenever candidate attributes, real-world outcomes, or base rates need external verification beyond one user-supplied or single-page authoritative spec.
- `auditor` in the same parallel wave when candidate reputation rests on experiential reports, rankings, community recommendations, school-of-thought advocacy, or self-authored claims.
- `analyst` when the question is whether a behavioral pattern, method, or intervention has genuine causal efficacy rather than correlation or survivorship bias.
- `critic` with `protocol: "counter_evidence"` when switch cost is high or a single winner is recommended over close contenders.

Before recommending, check reversibility and switch cost — how hard the pick is to undo — and the base rate: what usually happens to people who choose each option. Keep the tie-break when the top two are close.

Short:

```text
结论：选 A。
理由：<2-3 short reasons; name the trade-off>。
下一步：<smallest trial; switch condition if it fails>。
把握：<high|medium|low> — <why>（only when not high or close）
```

Full:

```text
结论：<A, or "A 和 B 都合理，没有明显赢家">。
理由：<main why and key trade-off>。
怎么选：<criterion> → A；<criterion> → B。
候选短评：
- A：适合...；代价...；证据...
- B：适合...；代价...；证据...
下一步：<trial / switch>。
把握：...

证据与来源（可跳过）
证据策略：<what was checked and through which role or protocol; what was not checked and the stop reason; why residual uncertainty is acceptable>
- ...

一句话：...
下一步：...
```
