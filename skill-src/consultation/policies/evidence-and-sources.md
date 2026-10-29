## Claim Decomposition

Decompose every consultation at the claim level. The domain determines relevant sources.

<!-- CLAIM-TYPES -->

## Source Evaluation

Grade each source relative to the claim using seven criteria:

1. primary versus secondary status;
2. expertise or legal accountability for the claim;
3. transparent and reproducible method;
4. independence and original provenance;
5. commercial or ideological conflicts;
6. recency, region, and applicability;
7. independent support or contradiction.

Grades:

- `high`: primary, accountable, independent, method-transparent, current and applicable.
- `medium`: secondary but reliable, or primary with a minor limitation.
- `low`: weak provenance, conflict of interest, or poor method.
- `lead_only`: useful as a lead, counterexample, or experience report, not as evidence.

Niche sources and forums are leads, not evidence; obscurity is never credibility. Correlated reposts count as one source chain. Grading assumes honest but flawed sources; deliberate deception is the intent audit's job.

### Claim Confidence Adjustments

Grade the evidence body, not just each source. Downgrade to at most `medium` (name the flaw or gap) for inconsistency (reliable sources conflict), indirectness (different population, period, region, or method), imprecision (too-wide estimate or too-small sample; `low` if severe), or bias in a load-bearing source from selection, measurement, or conflict (one level lower, `low` if severe). Upgrade to `high` when independent chains agree, even from medium sources, or a large, consistent dose-response effect has a plausible mechanism (name it). Output stays `high`/`medium`/`low`; no percentages or second scale.

## Intent Audit: Deliberate Deception

Water armies (水军), competitor smears (黑子), undisclosed sponsorship, and astroturfing contaminate a source regardless of plausibility. Dispatch the `verifier` for a bounded intent/independence audit when a material conclusion rests on load-bearing reviews, posts, rankings, purportedly independent evaluations, or promotional claims with unclear relationships, and you can name the question it would settle. An official product page is not independent proof of its own claims; a non-promotional authoritative specification usually needs no audit. The verifier checks observable influence; the explorer/consultant still check facts.

The verifier reports per source an intent of `clean`, `suspect_shill`, `suspect_smear`, or `unknown`, the names of the signals that fired, an independence assessment, and missing observations. Signals: temporal bursts, cross-account phrase repetition, single-product accounts, rating-text mismatch, new high-volume accounts, missing commercial disclosure, reviewer target concentration, cross-account reuse, incentivized posting, one-sided sentiment skew, publisher/owner overlap, and undisclosed affiliate links. Shilling and smearing are symmetric; target concentration is the key smear-side signal. It grades **suspicion with a stated basis, never ground truth**; missing account, disclosure, comparison, or review-selection data returns `unknown` — no detected signal is not proof of `clean`.

Leaked documents and pirated content are a high-fabrication zone. The verifier additionally checks document authenticity (contradiction with verifiable public information, anomalous format/attribution/timestamps, the same tampered version circulating widely, known forgery channels).

When manipulation is indicated and comparable evidence exists, disclose the pattern without inventing counts:

```
Contamination note: the evidence for <claim> may be contaminated on the
<positive|negative> side by <observed signals>. <N> of <M> reviewed sources
show <signal> (only if N/M were actually checked). Without those sources,
the supported conclusion is <Y or unknown>.
```


## Channel Strategy

Use a channel ladder, cheapest first:

| Tier | Content | Access | Cost query |
|---|---|---|---|
| T0 public | standard web search | direct | none |
| T1 low-index | Xiaohongshu, Tieba, Zhihu, Reddit, public Telegram, forums | browser or targeted search | direct if no login; else ask first |
| T2 paid / walled | paid newsletters, courses, book summaries | use a host-provided tool if it can access the material; otherwise user supplies if owned, else mark a gap | ask first; list purchase/login steps |
| T3 gated deep web | authenticated databases, licensed archives, public-records portals, other gated material | use a host-provided tool if it can access the material; otherwise ask first and give exact manual steps | ask first; the user performs the access |

**Collect first.** Attempt every relevant channel class — public, low-index, paid, gated, and user-supplied — and do not refuse a channel merely because it is informal or legally or ethically contested. Use any host-provided tool that can access the material; if the tool can reach it, use it. If no tool can reach it, try the available alternative channels and sources, and record what you tried.

Never ask for passwords, session cookies, or API keys; the user performs the login or purchase. Before declaring a gap, try every available route: host tools, the user's own sessions and subscriptions, library access, public abstracts, preprints, author copies, cached copies, and a direct request. Do not fabricate access or claim a source you did not open. When a route is blocked and needs the user's action, give the exact access step; the user decides whether to take it.

If a channel you actually used carries a legal or compliance risk you can identify, tell the user which channel it was and what the risk is. Do not add a routine inventory of safe channels; routine sources need no warning. The user owns the decision whether to accept the risk. Leaked or pirated material may be collected and used when it is the best available route; flag that channel and its risk, grade it `lead_only`/`suspect`, and corroborate it before treating it as proof, but never present it as the sole source.

## Epistemic Status

Label every atom (claim, candidate, or step) so the user always knows what is proven and what is inferred:

- `verified`: supported by definite evidence.
- `refuted`: contradicted by definite evidence (verify mode).
- `inferred`: no definite evidence, but a reasoning chain exists — the `basis` field must record "inferred Y from X".
- `unverifiable`: no evidence and no sound inference — also carries a `basis` explaining what was tried.

`inferred` and `unverifiable` must always carry a `basis`; a bare conclusion is forbidden. This is the concrete form of "when you cannot decide, say there is no definite evidence but show what you inferred from what."
