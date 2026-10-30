import { type Plugin, type Config } from "@opencode-ai/plugin"
import { loadPluginConfig } from "./plugin-config.ts"
import {
  registerConsultantAgent,
  registerCritic,
  registerArchCritic,
  registerExplorer,
  registerAnalyst,
  registerCoder,
  registerAskLite,
  registerCoderLite,
  registerAuditor,
  registerWriter,
  registerJanus,
  resolveModelPrompt,
} from "./agent-registration.ts"
import { createJanusDispatchTools } from "./dispatch-tool.ts"
import { registerMemoryMcp } from "./mcp-registration.ts"
import { installConsultationSkills } from "./skill-installer.ts"
import { installMemoryCommands, installModelsCommand } from "./command-installer.ts"
import { computeNamespace } from "./namespace.ts"

/**
 * Create the config hook that registers the agent family, the
 * janus-memory MCP server, and the consultation skill.
 *
 * Exported separately from the plugin so tests can invoke the hook
 * without constructing a full `PluginInput`.
 */
export function createJanusConfigHook(
  project: { id: string },
  directory: string,
): (config: Config) => Promise<void> {
  return async (config: Config): Promise<void> => {
    const env = process.env
    const pluginConfig = await loadPluginConfig(env)
    const namespace = computeNamespace(project.id, directory)

    // The directory supplies the author-brief and design-record project ids.
    await registerConsultantAgent(config, pluginConfig, namespace, directory, env)

    if (pluginConfig.coder_enabled) {
      await registerCoder(config, pluginConfig, directory, env)
    }

    if (pluginConfig.ask_lite_enabled) {
      await registerAskLite(config, pluginConfig, namespace)
    }

    if (pluginConfig.coder_lite_enabled) {
      await registerCoderLite(config, pluginConfig)
    }

    if (pluginConfig.janus_enabled) {
      await registerJanus(config, pluginConfig)
    }

    if (pluginConfig.explorer_enabled) {
      await registerExplorer(config, pluginConfig)
    }

    if (pluginConfig.analyst_enabled) {
      await registerAnalyst(config, pluginConfig)
    }

    if (pluginConfig.critic_enabled) {
      await registerCritic(config, pluginConfig)
    }

    if (pluginConfig.arch_critic_enabled) {
      await registerArchCritic(config, pluginConfig)
    }

    if (pluginConfig.auditor_enabled) {
      await registerAuditor(config, pluginConfig)
    }

    if (pluginConfig.writer_enabled) {
      await registerWriter(config, pluginConfig, env, directory)
    }

    if (pluginConfig.memory_enabled) {
      registerMemoryMcp(config, pluginConfig, namespace)
    }

    if (pluginConfig.install_skill) {
      await installConsultationSkills(env)
    }

    if (pluginConfig.install_commands) {
      await installMemoryCommands(env)
      await installModelsCommand(env)
    }
  }
}

export interface SystemTransformInput {
  readonly model: {
    readonly providerID: string
    readonly id: string
  }
}

export interface SystemTransformOutput {
  readonly system: string[]
}

/**
 * Inject the model-adaptation block for the model actually serving the turn.
 *
 * The block is keyed by the provider-agnostic normalized model id and is
 * appended as a separate system entry, so mode/tier overrides and continuation
 * sessions keep the matching block without replacing the agent prompt. The
 * shipped block is static per model, so the prefix stays byte-stable across the
 * tool steps of one job.
 */
export function createSystemTransformHook(env: NodeJS.ProcessEnv = process.env) {
  return async (input: SystemTransformInput, output: SystemTransformOutput): Promise<void> => {
    const config = await loadPluginConfig(env)
    const block = await resolveModelPrompt(config, `${input.model.providerID}/${input.model.id}`)
    if (block.length > 0) output.system.push(block)
  }
}

/**
 * The janus-agent OpenCode plugin.
 *
 * Registers the agent family, the dispatch tools, the `janus-memory` MCP
 * server, the three consultation skills, and the model-adaptation system hook.
 * Contains no evidence, recommendation, or persistence logic.
 */
export const JanusAgentPlugin: Plugin = async (input) => ({
  config: createJanusConfigHook(input.project, input.directory),
  tool: createJanusDispatchTools(input.client),
  "experimental.chat.system.transform": createSystemTransformHook(),
})
