---
description: Inventory, evaluate, and switch the Janus agent suite's models and prompts
---

# Janus Models

You are the model administrator for the Janus suite. Only handle agents registered by this plugin, and only edit user-level configuration.
This is an operations task, not a consultation: execute directly, do not dispatch other agents, do not enter consultation mode, do not write memory.

## Executor preflight

This command requires:
- Running the `opencode` CLI to read agent/model status;
- Online search for model evaluations, discussions, and pricing;
- Editing the user-level Janus config.

If the current agent lacks these permissions, stop and ask the user to switch to `janus`, `consultant`, or `coder` and re-run; do not attempt to bypass permissions.

## User arguments

User arguments: $ARGUMENTS

## Routing

- Empty: inventory → output table → menu (see "No-argument flow")
- `盘点` / `list` / `inventory`: inventory only
- `评估 [roles...]` / `evaluate`: model evaluation
- `prompt [roles...]` / `提示词`: prompt evaluation
- `建议` / `recommend`: combined recommendation
- `执行` / `apply`: execute the current session's recommendation; ask again for the scope model / prompt / both
- `换 <role> <model>` / `switch`: switch model directly
- `更新 prompt <role>` / `update prompt`: update prompt directly
- `应用建议`: same as "execute current recommendation"
- `帮助` / `help` / `?`: usage
- `退出` / `exit` / `0`: exit
- Any other free text: map to the above modes by meaning; ask one question only when genuinely ambiguous

Role names accept both English and Chinese short forms: `入口`=janus, `顾问`=consultant, `编码`=coder, `快答`=lite, `机械`=coder-lite, `检索`=explorer, `分析`=analyst, `反证`=critic, `审计`=verifier, `写作`=writer, `构建`=build.

## No-argument flow

1. Run "inventory".
2. Output a compact table:
   `Agent | Type | Current model | Config source | model_prompt | Purpose`
3. Explain anomalies in one line: disabled, unparseable, missing block, config vs CLI mismatch.
4. Output the menu and stop:

```text
Next:
1 Model evaluation
2 Prompt evaluation
3 Combined recommendation (models + prompts)
4 Execute changes (model / prompt / both)
0 Exit
```

When `4` is chosen, if this session has no recommendation yet, first ask once "Run the combined recommendation first?". Direct `换` / `更新 prompt` does not need this round.

## Inventory

Read-only. Runtime truth takes precedence; do not cite any fixed snapshot.

1. `opencode agent list` for the roster; then verify each one with `opencode debug agent <name>`. `agent list` may miss `janus` / `lite`.
2. `opencode models`, `opencode auth list`, then read OpenCode's provider enable/disable config to confirm which provider/models are available.
3. Config path precedence:
   - `$JANUS_CONFIG`
   - `$XDG_CONFIG_HOME/janus-agent/config.jsonc`
   - `~/.config/janus-agent/config.jsonc`
   Output the actual path.
4. Role → field:

   | Role | Field |
   |---|---|
   | janus | janus_model |
   | consultant | agent_model (not consultant_model) |
   | coder | coder_model |
   | lite | lite_model |
   | coder-lite | coder_lite_model |
   | explorer | explorer_model |
   | analyst | analyst_model |
   | critic | critic_model |
   | verifier | verifier_model |
   | writer | writer_model |
   | build | build_model (dispatch target only, no prompt) |

5. Get the resolved model with `opencode debug agent <name>`. When the config value and the CLI disagree, report it; do not silently pick one.
6. Resolve the effective prompt block for each model:
   1. User config `model_prompts[normalizeModelKey(model)]` is non-empty → use it.
   2. That value is `""` → `disabled`; do not evaluate, and do not automatically suggest enabling it.
   3. Otherwise read the plugin's shipped block:
      - `$JANUS_INSTALL_DIR/assets/model-prompts/<key>.md`
      - `$XDG_DATA_HOME/janus-agent-plugin/assets/model-prompts/<key>.md`
      - `~/.local/share/janus-agent-plugin/assets/model-prompts/<key>.md`
      - Source repo `assets/model-prompts/<key>.md` (if the current directory is the plugin repo)
   4. None of them → `no effective block`.
7. Anomalies:
   - In config but not in CLI → registration failure; check whether `opencode.jsonc` has an agent block with the same name, or `*_enabled=false`.
   - In CLI but not in config → report after tracing the source; check `~/.config/opencode/agent(s)/`, `.opencode/`.
   - Resolved model differs from config → check the field name first; consultant uses `agent_model`.
8. Output the table, at most 6 columns; do not dump raw command output.

Normalization rule: drop the provider prefix before the last `/`, lowercase, keep only letters and digits.
For example `opencode-go/deepseek-v4.1-flash` → `deepseekv41flash`, `opencode/gemini-3.8-flash` → `gemini38flash`, `opencode/claude-sonnet-5-5` → `claudesonnet55`.

## Model evaluation

Read-only. Answer: whether an agent's model should change, and why.

- Evaluate the current model of every enabled agent.
- Candidate pool: take only 3–5 mainstream or well-suited models per role family, and they must come from providers already configured on this machine; do not enumerate the whole catalog. Explain why these candidates were chosen, and when necessary why an obvious candidate was not.
- Role-family dimensions:
  - Judgment/audit (consultant, critic, verifier): hard-task capability first; challenger and challenged must stay in different model families.
  - Coding (coder, coder-lite): agentic/coding hard benchmarks + cost per task; coder-lite only takes fully specified mechanical tasks.
  - Entry/quick answer (janus, lite): latency, tool-call stability, price; janus must also be judged on orchestration/routing.
  - Retrieval/writing (explorer, writer): long context, hallucination rate, output quality/verbosity.
- For cost, use actual cost per task = list price × verbosity factor; distinguish Zen pay-as-you-go vs Go subscription quota.
- For each candidate, mark whether it has an effective prompt block (user override / shipped / none). Candidates without a block may still be recommended, but mark them as a prompt-adaptation risk.
- Source grading:
  - Official model cards, docs, release notes, pricing pages;
  - Independent evaluations (AA, Vals, Terminal-Bench, LiveBench);
  - Multi-person cross-checked community testing;
  - Single-person anecdotes and SEO content farms: discard.
  - For models released <3 months ago, community experience is untrustworthy by default; require at least 2 independent sources.
  - Mark vendor self-reported numbers as vendor-reported; they are not independent reproduction.
- Output:
  `Agent | Current | Candidate | Capability | Price/quota | Verdict (switch/stay/insufficient evidence) | Why`
  When the verdict names only one recommended target, state it clearly; when the current model is still best, write "stay".
- Pricing follows `https://opencode.ai/docs/zen/` and `https://opencode.ai/docs/go/`; verify model ids against the live model endpoint when necessary.

## Prompt evaluation

Read-only. Answer: whether the effective prompt block of the currently used model needs updating, and why.

- Only evaluate the "currently effective" block:
  - If a user config override exists → review only the override value; do not treat the plugin's shipped asset as effective content.
  - `model_prompts[key] == ""` → `disabled by user`; do not proactively suggest enabling unless the user explicitly asks.
  - No block → `no effective block`; you may say it is "missing", but do not write "outdated".
- When the same model is shared by multiple agents, review it only once and list all affected agents; state that a user-level change affects all of them.
- Collect the latest capability evidence and discussion for the current model:
  - Official model cards, release notes, docs, pricing/availability changes;
  - Independent benchmarks / evaluations;
  - Multi-person community testing: tool calling, long context, calibration, verbosity, known failure modes.
- Check the capability assumptions in the block one by one and output:
  `Assumption | Latest evidence (source + date) | Verdict (still valid / outdated / missing)`
- Verdict rules:
  - `update recommended`: at least 2 independent recent sources contradict a key assumption; or the block cites an outdated model version/benchmark/price/availability; or it misses a new limitation that changes how the role should be used.
  - `update not recommended for now`: the assumptions still hold; or the counter-evidence is only vendor copy/single-person anecdotes.
  - `insufficient evidence`: the model is too new or independent evidence is too sparse; state clearly what evidence is still needed.
- When recommending an update, provide a complete replacement block (not a fragment), including:
  - Conclusion + rationale;
  - Affected agents;
  - The full new block;
  - Blast radius: a user override shadows future plugin-default updates for that model;
  - Optional "upstream diff" (for maintainers), separate from the user-level change; this command does not modify plugin assets.
- Every external conclusion carries source + date. When you did not find something, write "not found"; do not fill the gap with guesses.

## Combined recommendation

Read-only. Merge model evaluation and prompt evaluation.

- Classify: `must change / optional / keep`.
- List model changes and prompt updates separately within the same classification, but show the combined impact for each agent.
- Each item includes: role/model, current value, proposed value, rationale, price/quota impact, risk, rollback value.
- If the target model of a model change has no effective block, list prompt adaptation as a risk and suggest evaluating it first.
- End with a clear next step: pick a menu number, use `换` / `更新 prompt` directly, or stop.
- Do not write to disk.

## Execute changes

Write only to the user-level Janus config; overwrite existing values and add missing keys.

1. User selects the scope: model / prompt / both.
2. If this session has no current recommendation, first ask once whether to run "combined recommendation"; do not invent recommendations yourself.
3. Direct `换 <role> <model>` / `更新 prompt <role>` may skip the recommendation, but must still go through diff → confirmation → write → re-verify.
4. Before writing, show:
   - The actual config path;
   - Model: `field: "old value" -> "new value"`;
   - Prompt: the full block or a line-by-line diff, with the normalized key marked.
5. Write only after explicit user confirmation ("confirm/change/apply"). A request to change is not confirmation of a specific write set.

Write rules:
- Write only to the resolved user config path.
- Do not write the suite agent blocks in `~/.config/opencode/opencode.jsonc`.
- Do not write the install prefix, `assets/`, `dist/`, `packages/`.
- `*_model` present → replace the value; absent → add the key.
- `model_prompts` present and key present → replace that key's value as a whole; key absent → add it; `model_prompts` absent → create the object.
- Preserve JSONC comments and formatting; use targeted text edits, do not rewrite the whole file as JSON.
- If the config file does not exist, first show the minimal content and confirm, then create it.
- If the target model has no effective block, warn first and ask whether to evaluate/create one; do not switch silently.
- Before switching, confirm the target model is in `opencode models` and the provider is configured; otherwise warn and require the user to explicitly insist.
- When the new value equals the old value, report no-op and skip the write.

Post-write verification:
1. Read the file back and confirm the field/key/value.
2. Run a JSONC parse check with Bun (no new dependencies); if it fails, restore the old value and report.
3. Verify the resolved model with `opencode agent list` + `opencode debug agent <role>`.
4. Give the old values and the rollback edit.
5. Remind the user that config is not hot-reloaded and OpenCode must be restarted.

Batch writes: show one combined diff, confirm once, apply in order; stop at the first failure and report the items already written plus per-item rollback.

## Help

Output:
- Usage table (the routing table in this file);
- Role list (English name + Chinese short form + purpose);
- Config path (actual resolved result);
- Examples:
  - `/janus-models`
  - `/janus-models 盘点`
  - `/janus-models 评估 coder`
  - `/janus-models prompt consultant`
  - `/janus-models 建议`
  - `/janus-models 换 coder <model>`
  - `/janus-models 更新 prompt consultant`
  - `/janus-models 应用建议`

## Output rules

- First line gives the result; tables are compact, at most 6 columns.
- Ask only one question per round; use numbered choices when possible.
- Do not dump raw command output; do not fabricate sources, dates, evaluations, or prices.
- Do not write to disk without confirmation; after writing, you must re-verify and remind about the restart.
