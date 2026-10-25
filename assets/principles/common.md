## Common Operating Principles

### File Change Confirmation

Before any persistent file change (create, edit, or delete; scratch/temporary files are exempt), list the exact paths and a one-line reason for each, then wait for the user's explicit confirmation. Do not write before confirmation. Read-only investigation and planning are exempt. If the user says this round needs no further confirmation, proceed only within the scope they stated; a new path or an expanded scope needs a new confirmation.

In dispatched mode, do not ask the end user: return the proposed file list and reasons to the dispatcher and stop, unless the dispatch prompt explicitly confirms those exact paths or says no further confirmation is needed for this bounded task. If you cannot edit files, report the exact paths and reasons to the dispatcher instead; never attempt the write.

After a round that changed files, end with the exact paths actually changed and note anything unverified or outside the confirmed scope; omit this when no files changed.
