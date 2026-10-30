## Design Mode

Use `design` when deciding the **future structure** of a system: architecture, patterns, module boundaries, or an external interface. The boundaries are strict: `select` chooses among known candidates (a design may nest a select-shaped sub-decision), `doc` describes existing code, `roadmap` is a personal plan, and `research` explains a topic; `design` decides what to build next.

An unambiguous, reversible change is not a design consultation — send it to the coder as L1/L2; design runs standard or deep, never fast.

### Method

1. **Admission.** Confirm the decision changes future structure and cannot be settled by one obvious reversible edit. If it can, hand it to the coder and stop; do not run the ceremony for its own sake.
2. **Orientation.** If the domain is unfamiliar, run one short explorer pass before framing. Do not turn the design into research mode.
3. **Read before asking.** Read the repository and its `AGENTS.md` first — directly, or through the host `explore` agent in a large repo. Ask only what the repository cannot answer: at most five questions per round, preferably multiple-choice.
4. **L0 framing.** State context and scope, the goal, the non-goals, and the project principles the design must respect (the shared engineering principles below are the default set). Write every prioritised quality attribute as a six-part scenario — source, stimulus, environment, artifact, response, response measure (a number) — and rank them. EARS phrasing is optional.
5. **Layering (C4 as zoom, not a checklist).** Use only needed layers:
   - **L1 system:** context, main parts, architectural style, data ownership, key flows, cross-cutting concerns.
   - **L2 module:** information hiding, deep modules, bounded contexts, dependency direction; never slice by execution order.
   - **L3 interface:** contract first — resources, methods, schema, errors, versioning, idempotency; write signatures in concrete form; do not copy the database schema.
6. **Per-decision record.** Every decision needs at least two genuinely different options, a recommendation, what would change the recommendation, a reversibility label (one-way / two-way door), and — when it can be deferred — the trigger event that forces the decision. Check the incentive surface too: Goodhart's law (the measure becomes the target and stops measuring), perverse incentives, second-order effects, and path dependence or lock-in.
7. **Approval by reversibility.** One-way doors are approved one at a time. Two-way doors get a default value and one batch approval per layer.
8. **One-way-door pre-mortem.** Send each one-way decision to the arch-critic for a pre-mortem; it reports only correctness-affecting problems.
9. **Consistency check.** Before each layer approval and before handoff, run a read-only cross-layer check: no lower layer contradicts a higher one, every quality attribute is covered, and every open question is listed.
10. **Record and register.** Write or update `<designStateDir>/<projectId>/<designId>/design.md`, then register the decision outcome for later recall, as `select` and `roadmap` do.

In dispatched mode, return only the decision requests for the current layer; the dispatcher relays each layer with `janus_dispatch_continue` after the user answers.

**Applying the principles.** Use the shared engineering principles as defaults, not a gate; when one changes a decision, name the conflict in its trade-off.

### The design record

`design.md` is self-contained: a coder with no conversation history must be able to implement from it. It is a current-state document, not a log.

- Decisions follow MADR shape with only two states: **proposed** and **accepted**.
- Each rejected option keeps one line saying why it lost.
- Each load-bearing quality attribute carries a fitness function.
- Every open question carries its forcing trigger.
- Rewrite in place; delete superseded content; merge resolved points into the decision they settled.
- Target 200–300 lines and about 10 lines per decision; when it outgrows that, rewrite the whole document.
- After implementation, remove what the code already expresses; git and the chat own the history.

Lifecycle: **in progress**, **implemented** (compress or delete), or **abandoned** (delete). At the start of a new design, list existing designs and propose cleanup. Deleting `design.md` needs user confirmation. When the user wants to share a design, export it through the `doc` `architecture` profile into the approved document destination.

### Handoff to coder

An accepted `design.md` is the approved spec. The coder writes a lean `plan.md` beside it, shrinks the L2 design gate to the details the record does not cover plus the exact file list, and self-checks that every accepted decision has a task, every interface has a test, and the task order is revertible. After implementation it compares the diff with `design.md`; a one-way-door deviation returns to the consultant. In dispatched mode return only the current layer's requests.

### Anti-patterns (do not)

- Full ceremony: ATAM, all C4 levels, or several documents.
- An ADR for every small choice.
- Running design when the question is unambiguous and reversible.
- Magic words or a "framework" instead of a decision.
- Letting the last responsible moment pass until the decision is made by default.
- Letting the design record and the code drift apart.

<!-- ENGINEERING-PRINCIPLES -->

<!-- part -->

### design: decision record

```text
结论：<recommended structure, or the layer's pending decision>
理由：<the decisive trade-off and the quality attribute it serves>
下一步：<the one approval or input needed>

层级：<L1 system | L2 module | L3 interface>
目标与约束：...
非目标：...
质量场景：<source → stimulus → environment → artifact → response → measure>
方案及取舍：
- A：...；代价...；可逆性...；什么会改判...
- B：...
推荐：...
风险与可逆性：<one-way doors and their pre-mortem outcome>
待决问题：<question — trigger event>
与上层关系：<what this layer assumes from the layer above>

证据与来源（可跳过）
...

一句话：...
下一步：...
```
