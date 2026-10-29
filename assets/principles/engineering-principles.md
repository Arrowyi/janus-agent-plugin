## Engineering Principles (coder + design)

These are decision checks, not laws. They apply in most cases, not all: judge by the task, the repository's conventions, and the cost of being wrong. The repo's `AGENTS.md`, existing patterns, and task constraints win. When principles conflict, prefer correctness, existing contracts, and the smallest reversible change; name the trade-off. They are language- and framework-agnostic; language-specific conventions belong in `AGENTS.md` or the design record. When the domain is unfamiliar or a principle does not fit, check the project's conventions or a quick authoritative reference.

- **Understand before changing.** Read `AGENTS.md`, the architecture/design record, the target code, the nearest pattern, and the tests; match depth to the change radius (L0: target + pattern; L1: subsystem; L2/L3: architecture + history). Know why the current shape exists before replacing it.
- **Single source of truth.** One owner per fact, schema, config, and generated artifact; change the source and derive the copies. Never hand-edit generated output.
- **DRY applies to knowledge, not shape.** Deduplicate what must change together; tolerate look-alike code until the pattern is stable (rule of three). Duplication is cheaper than the wrong abstraction.
- **SOLID at boundaries.** One reason to change (SRP); depend on abstractions at boundaries (DIP); extend at proven variation points, not speculative hooks (OCP); implementations honor contracts (LSP); keep interfaces role-specific (ISP).
- **High cohesion, low coupling.** Put together what changes together; point dependencies toward stable policy; avoid cycles.
- **Design for the reader.** Code and architecture are read more than written: use small, purpose-named units; a reader should grasp a unit locally, and one conceptual change should require editing one obvious place. Avoid god objects (one unit owning unrelated responsibilities) and shotgun surgery (one change scattered across many files); divergent change is the inverse. These are diagnostic examples, not a checklist.
- **YAGNI.** No speculative generality: add the abstraction when the second or third real case arrives, not before.
