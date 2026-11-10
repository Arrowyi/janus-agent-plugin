import { type Plugin, type Config } from "@opencode-ai/plugin"
import { loadPluginConfig } from "./plugin-config.ts"
import {
  registerAuthor,
  registerAuthorReviewer,
  registerAuthorWriter,
  registerArchitect,
  registerCoder,
  registerCoderLite,
  registerCoderReviewer,
  registerCommonExplorer,
  registerConsultantAgent,
  registerConsultantAnalyst,
  registerConsultantAuditor,
  registerConsultantCritic,
  registerJanus,
  registerSimple,
  resolveModelPrompt,
} from "./agent-registration.ts"
import { createJanusDispatchTools } from "./dispatch-tool.ts"
import { CONFIG_TOOL_NAME, createJanusConfigTool } from "./config-tool.ts"
import { PROVIDER_KEYS_TOOL_NAME, createProviderKeysTool } from "./provider-keys-tool.ts"
import { registerMemoryMcp } from "./mcp-registration.ts"
import { installConsultationSkills } from "./skill-installer.ts"
import {
  installConfigCommand,
  installHandoffCommand,
  installMemoryCommands,
  installModelsCommand,
} from "./command-installer.ts"
import { computeNamespace } from "./namespace.ts"

/**
 * Create the config hook that registers the agent family, the
 * janus-memory MCP server, and the four skills.
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

    // The directory supplies the author-brief, design-record, and handoff
    // project ids.
    await registerConsultantAgent(config, pluginConfig, namespace, directory, env)

    if (pluginConfig.architect_enabled) {
      await registerArchitect(config, pluginConfig, namespace, directory, env)
    }

    if (pluginConfig.author_enabled) {
      await registerAuthor(config, pluginConfig, namespace, directory, env)
    }

    if (pluginConfig.coder_enabled) {
      await registerCoder(config, pluginConfig, directory, env)
    }

    if (pluginConfig.simple_enabled) {
      await registerSimple(config, pluginConfig, namespace)
    }

    if (pluginConfig.coder_lite_enabled) {
      await registerCoderLite(config, pluginConfig)
    }

    if (pluginConfig.janus_enabled) {
      await registerJanus(config, pluginConfig, directory, env)
    }

    if (pluginConfig.common_explorer_enabled) {
      await registerCommonExplorer(config, pluginConfig)
    }

    if (pluginConfig.consultant_analyst_enabled) {
      await registerConsultantAnalyst(config, pluginConfig)
    }

    if (pluginConfig.consultant_critic_enabled) {
      await registerConsultantCritic(config, pluginConfig)
    }

    if (pluginConfig.coder_reviewer_enabled) {
      await registerCoderReviewer(config, pluginConfig, env)
    }

    if (pluginConfig.consultant_auditor_enabled) {
      await registerConsultantAuditor(config, pluginConfig)
    }

    if (pluginConfig.author_writer_enabled) {
      await registerAuthorWriter(config, pluginConfig, env, directory)
    }

    if (pluginConfig.author_reviewer_enabled) {
      await registerAuthorReviewer(config, pluginConfig, env)
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
      await installHandoffCommand(env)
      await installConfigCommand(env)
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
 * server, the four skills, and the model-adaptation system hook.
 * Contains no evidence, recommendation, or persistence logic.
 */
export const JanusAgentPlugin: Plugin = async (input) => ({
  config: createJanusConfigHook(input.project, input.directory),
  tool: {
    ...createJanusDispatchTools(input.client),
    [CONFIG_TOOL_NAME]: createJanusConfigTool(),
    [PROVIDER_KEYS_TOOL_NAME]: createProviderKeysTool(),
  },
  "experimental.chat.system.transform": createSystemTransformHook(),
})
