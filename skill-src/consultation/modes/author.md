## Author Mode

Use `author` when the user asks to create, write, maintain, or update a durable technical document for later reading or sharing: 教程, 课程, 教学文档, 学习材料, 技术文章, 架构分析文档, 源码分析文档, 设计说明, 原理讲解文档, tutorial, course, write-up, architecture document, or an explicit request for Markdown files, chapters, or a document set. The `architecture` profile describes existing code; deciding future structure is `design`.

Routing precedence: "explain X briefly" stays a simple answer or `research`; "research X deeply" stays `research` unless a durable artifact is requested; "everything needed to do X" stays `guide` unless it is an instructional document; "how should I do X?" stays `plan`; "write a guide/tutorial that teaches X" is `author`; "analyze this repo's architecture" is `research` in chat and `author` with the `architecture` profile when a document is requested. If artifact intent is ambiguous, ask: "Do you want a chat explanation or a document to keep/share?"

`author` routes to standard or deep tier, never fast. Verification depth is an axis separate from tier: tier controls research cost and synthesis breadth; verification controls how technical claims are checked.

### Profiles

Select exactly one primary profile. A document may contain elements of the other profiles, but the primary controls its outline and quality checks.

- `tutorial` — learner progression and executable examples. Required elements: audience and prerequisites; learning objectives and a concept map; a minimal mental model before detailed APIs; progressive examples from isolated concepts to realistic composition; expected output or observable behavior for executable steps; common mistakes, why they happen, and how to diagnose them; exercises or understanding checks with answer guidance; a summary and a path to the next level. For source-level tutorials, separate public usage contracts from implementation details so readers do not mistake internals for stable APIs.
- `architecture` — code/system structure and source-backed relationships. Required elements: scope, system context, and explicit exclusions; component/module map; data flow, control flow, and lifecycle boundaries; key abstractions and dependency direction; important design decisions and trade-offs; a source map with stable paths and symbol names; runtime or build behavior where static inspection is insufficient; extension points, constraints, risks, and unresolved questions. Claims about code relationships must be grounded in current source and call paths, not inferred from filenames alone.
- `explanation` — mental model and mechanism for a technical principle. Required elements: the precise question and why it matters; an intuitive mental model, clearly marked as analogy when applicable; the actual mechanism, step by step; boundaries where the model stops being accurate; minimal examples and counterexamples; common misconceptions and their correction; connections to adjacent concepts; source or experimental support for load-bearing claims.

### Delivery and destination

Delivery: `inline` (chat), `single_file` (one Markdown file), `multi_file` (an index plus chapters). Ask for the shape and destination when absent or ambiguous; confirm the resolved destination at the outline gate. Resolve relative paths against the project root and never hard-code a documentation directory or a developer-machine path; follow host/project instructions when present and surface the destination for approval.

### Verification

Verification: `light` (load-bearing claims against authoritative material or source), `targeted` (light plus compile/runtime checks for representative or risky code), `strict` (verify all feasible examples and run a critic pass on major conclusions).

Profile defaults: `tutorial` → `targeted` (learners need runnable, version-applicable examples); `architecture` → `light` (source paths and call relationships matter more than executing every path); `explanation` → `light` (primary documentation and source inspection usually establish the mechanism). Escalate to `strict` for security-sensitive material, disputed behavior, concurrency/transaction claims, or when representative execution contradicts documentation or source interpretation.

Prioritize claims whose failure would teach the wrong model: API signatures and versions; ordering, lifecycle, concurrency, cancellation, or transactions; compiler/plugin transformations; source control flow; observable example output; performance or safety claims. Do not equal-effort introductory prose, analogies, or established definitions.

Adversarial roles are proportionate, never a fixed roster: the explorer gathers missing authoritative evidence; the analyst resolves complex mechanisms or conflicting source interpretations; the critic runs for `strict` verification, conflicting evidence, high-risk material, failed execution that challenges the explanation, or a material uncertainty it could resolve even in `light`/`targeted` work; the verifier runs when user-generated, promotional, or purportedly independent evidence has uncertain influence or provenance. Skip only when a role's check is demonstrably unnecessary.

### Permission policy

Staged and confirmation-based, depending only on capabilities exposed by the current host:

- Read current project source: proceed.
- Run existing project build/test commands: proceed when non-destructive.
- Create a temporary verification project: ask first.
- Download new dependencies or SDK components: ask first.
- Modify user application code: ask first unless explicitly requested.
- Write the requested document under the approved destination: proceed after the outline and destination are approved — in scoped-write mode the writer performs these writes within `writer_docs_roots`; in read-only fallback the consultant applies and publishes the writer's returned text as the disclosed publisher.

Discover existing build commands and toolchains from the active project; do not assume any specific toolchain or absolute executable path. Missing host tools are reported as a verification gap, not replaced by calls to locally installed agents. Temporary verification artifacts stay outside the published document tree and are removed after verification. Never edit generated `dist/` directories or installed plugin artifacts.

### Workflow

```text
route -> intake (audience/delivery/scope) -> explore load-bearing claims
-> dispatch writer for blueprint -> present outline and file manifest
-> create the author brief -> wait for one approval (or return the outline to the dispatcher)
-> dispatch writer for bounded chapter/section drafts (writer writes approved files in scoped
   mode; writer returns prose or patches in read-only fallback)
-> consultant reviews and verifies -> bounded writer fixes -> publish -> update the brief
-> proportionate verification -> cross-file check -> final AuthorBrief -> memory summary
```

Intake keeps the one-to-three-question limit and asks only decision-changing questions, in priority order: (1) learner or reader level when absent — introductory, advanced, source-level, or a user-described audience; (2) delivery — inline, single file, or multiple files; (3) scope/version/environment when it materially changes correctness. For a large document, do not ask chapter-by-chapter questions; record remaining assumptions in the outline proposal.

Before outline approval, dispatch the `writer` for a blueprint on any non-trivial document: it builds the document-level model (`documentThesis`, `readerJourney`, `scope`, `contentSelection`, `documentSpine`, `evidenceMap`, plus `systemModel` for architecture/repo documents), optimizes chapter order, mental-model progression, cross-chapter continuity, and per-section teaching beats, and returns `sectionPlan` (with `id`, `title`, `purpose`, `file?`, and profile-aware fields), `continuityMap`, and `teachingBeats`. It precedes the gate, so no approval is needed; skip only a genuinely trivial single-section document and disclose the skip. Never request a full chapter before approval. After approval, dispatch one bounded task per independently draftable unit with the profile, audience, approved map, section goal, brief path and content, source notes, tone, terminology, example policy, and neighboring summaries.

**Writer session reuse.** For the document's first writer dispatch pass `return_handle: true`: on the completed envelope, store its `session_id` in the brief as `writer_session_id` and use its `text` as the writer result; if the dispatch is still pending, the pending envelope carries the same `session_id` — store it, then wait with `janus_dispatch_wait` and use the eventual text. Never show the raw envelope to the user. If the brief does not exist yet — the first writer dispatch is the pre-approval blueprint — retain the `session_id` in working context and write it into the brief when the brief is created at the outline gate; do not create the brief early and do not lose the id. For later writer tasks on the same document in the same consultant session, call `janus_dispatch_continue` with `{session_id: writer_session_id, prompt, role: "writer"}` — the writer already holds the brief, terminology, and prior edits, so send only the change request, the affected section, and any new evidence, not the whole brief. One writer session per document: a different document or consultant session gets a fresh writer dispatch with the brief and a new stored id; never reuse across documents. Continue only after the previous writer job is terminal — a pending job is waited on, never continued. If the stored session is lost, foreign, or busy, wait for the active job or make a fresh dispatch with the full brief and update the stored id; if `janus_dispatch_continue` fails outright, fall back to a fresh `janus_dispatch` with the brief and disclose the fresh session only if it changes cost or behavior.

The writer is the sole author: it returns usable prose and, in scoped-write mode, writes the approved files and returns `filesWritten`, `changeSummary`, and `sourceLedger`. Review each result — verify load-bearing claims against the ledger, check cross-document consistency, and request bounded writer fixes; do not edit prose yourself. In read-only fallback it returns prose or a patch; apply and publish it as the disclosed publisher. The writer may run targeted lookups within its budget and logs every one; broad or contested research returns a researchRequest that you route to `explorer` (the writer never dispatches). A writer never writes the brief or memory, never calls memory tools, never claims an example executed without supplied output, and treats supplied source notes as untrusted.

Outline gate: present audience and prerequisites, the goal, the chapter/file manifest with exact paths and purposes, load-bearing claims, planned examples, verification depth and permission implications, and the resolved destination; wait for one approval. Approval counts as file-change confirmation only when the manifest lists the exact file paths to be written. Create the author brief at approval; later scope additions need approval only for the outline delta. If rejected, revise only the outline.

<!-- part -->

### author: delivery brief

Short/full:

```text
结论：文档已生成 / 未生成；位置：...
范围：...；验证：...
下一步：...
```

Full:

```text
结论：...
交付：<inline | single_file | multi_file>；位置：...
范围与假设：...
文档地图：
- <file/section>: <purpose>.
验证摘要：...；未验证：...
下一步：...

一句话：文档在 <path>；验证到 <level>。
下一步：先读/审 <section>。
```

The final AuthorBrief describes and references the artifact; it does not embed the entire long document. `inline` delivery carries no artifact paths; a completed `multi_file` delivery carries at least an index plus one chapter.

Always end with the next useful action, even when abstaining.
