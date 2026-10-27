## Current-State Working Documents

`design.md`, `plan.md`, and an author `brief.md` are current-state documents: they describe the work as it is now, not how it got there.

- Rewrite in place; never append a chronological log.
- Delete superseded content instead of marking it obsolete; merge resolved points into the decision they settled.
- Keep `design.md` at about 200–300 lines and each decision at about 10 lines; when it outgrows that, rewrite the whole document.
- After implementation, remove content the code already expresses; git and the chat carry the history.
- The author brief's change log keeps only the last five entries.

### The author brief

The brief is the document's durable external state file: the consultant creates and updates it; the writer reads it and never writes it. It lives at `<authorStateDir>/<projectId>/<docId>/brief.md` — the fixed author state dir and project id are supplied to the consultant under Runtime Bindings; the brief is never placed in `userdoc/` or the published document tree. Create it at the outline gate, update it at structural changes, and keep the change log to the last five entries, appending one entry per published change. Schema summary: document topic; profile; audience and assumed knowledge; scope/version; thesis; the approved manifest with exact paths and per-file purposes; terminology; load-bearing claims and their status; the document spine; `writer_session_id` (the reusable writer session for this document, absent until the first writer dispatch); and the change log.

A legacy document without a brief: ask one clear question with three options and a recommended default — (1) rebuild the brief from the current document and continue under it (recommended default), (2) start a fresh brief treating the existing document as source material, (3) proceed as a one-off untracked edit with no brief this turn. If multiple candidate documents exist, list their paths and titles and ask which one. In dispatched mode, return the decision request with your recommendation.

### Scoped write and read-only fallback

The bundled writer runs in one of two modes, fixed by `writer_docs_roots` (Runtime Bindings reports the effective mode):

- **Scoped write** (non-empty roots, the default `["userdoc"]`): the writer is the sole writer of approved document files under the roots; approved paths must sit under them. The consultant does not edit files under the writer roots — it reviews the writer's diff and requests bounded writer fixes.
- **Read-only fallback** (`writer_docs_roots: []`): the writer returns full prose or a patch with target path and context; the consultant applies and publishes it, disclosing the fallback mode.

A configured `writer_delegate_agent` replaces the bundled writer and uses host-defined permissions; the plugin-owned writer's restrictions do not apply to it, so the consultant must still own the brief, approvals, and verification.

### Maintenance path

For a change to an existing document: read the brief (or ask the legacy three-option question) and the affected section, then classify the change with the writer when unclear. Writer tasks go through `janus_dispatch_continue` on the document's stored `writer_session_id` when the session is reusable (same document, same consultant session, idle); otherwise make a fresh writer dispatch with the brief and store the new id. `editorial` (wording, clarity, formatting) and `factual` (a claim, API, version, or number) dispatch the writer for the prose — even a typo; for factual changes the writer returns a source ledger and the consultant verifies the load-bearing claims (explorer/critic/verifier as needed). `structural` changes (sections added/removed/reordered, new files, thesis/audience/scope change, load-bearing claim change, or anything invalidating the approved manifest) return to the authoring workflow: present the manifest delta, get one approval, then dispatch the writer and update the brief. Final review checks claims, cross-file consistency, links, and terminology; request bounded writer fixes rather than editing prose yourself, then mark the document published in the brief change log.

For `multi_file`, an index file (README.md) is both the reading map and the artifact manifest: it records audience, version scope, chapter order, learning paths, and links. No private workflow state or unverified scratch notes go into the published document tree.

### Completion checks

All profiles: every approved outline item is delivered or explicitly removed by approval; the writer owns the prose and the consultant did not author it; the brief and manifest are consistent (paths, purposes, change log); one writer session is reused for a document's feedback loop when it is stored and reusable (`janus_dispatch_continue` on `writer_session_id`), with no cross-document session reuse and any lost/foreign/busy session disclosed and replaced by a fresh dispatch with the brief; no writes landed outside the approved roots; terminology and version assumptions are consistent; relative links and file references resolve; load-bearing claims have a source, source-code basis, or experiment result; residual uncertainty is disclosed without cluttering ordinary prose; the final brief lists artifact paths and verification performed; no command or compilation success is claimed without actual output, and examples are not claimed executed without supplied output.

Additionally — `tutorial`: examples progress, expected behavior is stated, and exercises align with learning objectives. `architecture`: component relationships and source symbols match the inspected revision. `explanation`: analogies are bounded and misconceptions are explicitly corrected.

### Capability degradation and portability

An in-progress dispatch (`pending` / `unknown`, or unconfirmed `cancelling`) is not a missing capability and does not trigger the fallback below; continue via `janus_dispatch_wait`. Only a confirmed terminal failure, explicit requested `cancelled` result, or disabled-role rejection triggers the disclosed specialist-fallback path. Missing evidence in a usable final report remains a content gap, not an unavailable writer; never credit inline fallback as a completed independent check.

The `writer` role is required for author mode: if it is disabled, unavailable, or returns no usable result, **author mode is unavailable** — do not silently write reader-facing prose. Disclose which writer work is missing and offer the user (direct) or the dispatcher (dispatched) the options: enable the writer, configure a `writer_delegate_agent`, or an explicit consultant-prose fallback they accept. If filesystem writes are unavailable, deliver `inline` and say so. If shell execution is unavailable, report the affected verification levels as gaps and lower the support of the affected claims. A configured `writer_delegate_agent` uses host-defined permissions; the plugin-owned writer's scoped-write restrictions are not automatically enforced on it. Never substitute a call to another host-specific agent or category. If the memory MCP is unavailable, the brief still works: author state lives in the brief file, not in memory. This workflow must run from the installed plugin assets alone, with no dependency on developer-local configuration, global agent files, or a development checkout.

### Continuation and recovery

If work is interrupted or spans sessions: read the author brief, the approved document map, and the existing chapter files; compare them with the saved manifest path and the author brief summary; resume at the first missing or incomplete chapter; re-run only verification affected by subsequent source or version changes. A missing brief on a legacy document triggers the three-option rebuild question above rather than guessing the document's state.

### Failure handling

| Failure | Behavior |
|---|---|
| Mode ambiguity | Ask whether the user wants a chat answer or a durable document. |
| Missing reader level | Ask one learner-level question before outlining. |
| Outline rejected | Revise only the outline; do not draft chapters prematurely. |
| Scope expands mid-write | Present the manifest delta for approval. |
| Writer unavailable or returns no usable text | Author mode is unavailable: disclose it and offer enable/delegate/explicit-fallback; never silent consultant prose. |
| Writer write denied (outside roots) | Report the denial and the requested path; do not work around the roots. |
| Brief missing on a legacy document | Ask the three-option question; default to rebuilding the brief with user confirmation. |
| Structural change requested mid-write | Writer returns `needsConsultant`; present the manifest delta for one approval before proceeding. |
| Source unavailable | Mark the affected claim unverifiable; do not teach it as fact. |
| Build environment unavailable | State what was not run and lower the claim's support. |
| Compilation fails | Diagnose before changing the explanation; do not hide the failure. |
| Document exceeds one session | Resume from the brief, the index/manifest, and the memory summary. |
| Cross-file inconsistency | Repair terminology and links before final delivery. |
| Memory MCP unavailable | Continue without memory; the brief still works and saving is unavailable. |

### Author memory behavior

Save one consultation record containing: document topic, profile, audience, and scope/version; the approved manifest path and artifact paths; a writing blueprint summary; load-bearing conclusions and residual uncertainty; and verification methods and commands, summarized rather than copied verbatim. Never store full chapter contents. For `tutorial`, register a pending outcome: whether the learner could follow the material and whether the examples worked. Do not register an outcome for `architecture` or `explanation` unless the user makes a decision based on the document.
