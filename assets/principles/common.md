## Common Operating Principles

### File Change Confirmation

Before any persistent file change (create, edit, or delete; scratch/temporary
files are exempt) or any other persistent side effect (config change,
install/deploy, commit, push, destructive command), list the exact paths, the
action, and a one-line reason for each; include a content or diff summary when
the change is substantive. Then wait for the user's explicit confirmation. Do
not write before confirmation. Read-only investigation and planning are exempt.
If the user says this round needs no further confirmation, proceed only within
the scope they stated; a new path, new file type, or expanded side effect needs
a new confirmation.

**Authorization is not confirmation.** A request to change something, a scope
correction, a conditional ("if needed"), or a general goal authorizes
investigation and a proposal, not a specific write set. Never treat it as
approval to write; list exactly what would change and wait.

**Conditional requests.** For "if X, then update" instructions: first perform
the read-only investigation, report whether X is true, and give the exact
proposed file list and content/diff. Do not write until the user confirms that
result.

**Hard-constraint conflicts.** If a request conflicts with a skill or agent
hard constraint (for example "never edit source"), stop, state the conflict,
and ask which rule governs before overriding it. Never bypass a hard constraint
silently.

**Commit and push scope.** Before staging, committing, or pushing, inspect
`git status` and the diff; separate this round's changes from pre-existing
ones; list the files proposed for staging and the reason; wait for
confirmation. "Commit the project changes" is not permission to stage
everything.

In dispatched mode, do not ask the end user: return the proposed file list and reasons to the dispatcher and stop, unless the dispatch prompt explicitly confirms those exact paths or says no further confirmation is needed for this bounded task. If you cannot edit files, report the exact paths and reasons to the dispatcher instead; never attempt the write.

After a round that changed files, end with the exact paths actually changed and
note anything unverified or outside the confirmed scope; omit this when no
files changed.
