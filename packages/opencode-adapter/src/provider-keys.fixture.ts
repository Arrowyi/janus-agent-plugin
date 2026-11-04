import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

export const WORK_KEY = "sk-work-1234567890abcdef"
export const HOME_KEY = "sk-home-abcdef1234567890"
export const OAUTH_SECRET = "oauth-refresh-secret-value"

/** A temp HOME with an OpenCode auth.json, a models.dev cache, and a custom provider. */
export async function seedKeysHome(root: string): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = {
    HOME: root,
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_CONFIG_HOME: join(root, "config"),
  }
  await mkdir(join(root, "data", "opencode"), { recursive: true })
  await mkdir(join(root, "cache", "opencode"), { recursive: true })
  await mkdir(join(root, "config", "opencode"), { recursive: true })
  await writeFile(
    join(root, "data", "opencode", "auth.json"),
    JSON.stringify({
      deepseek: { type: "api", key: WORK_KEY },
      anthropic: { type: "oauth", refresh: OAUTH_SECRET },
    }),
  )
  await writeFile(
    join(root, "cache", "opencode", "models.json"),
    JSON.stringify({
      deepseek: { id: "deepseek", name: "DeepSeek", env: ["DEEPSEEK_API_KEY"] },
      openai: { id: "openai", name: "OpenAI", env: ["OPENAI_API_KEY"] },
      anthropic: { id: "anthropic", name: "Anthropic", env: ["ANTHROPIC_API_KEY"] },
    }),
  )
  await writeFile(
    join(root, "config", "opencode", "opencode.jsonc"),
    '{ // custom\n "provider": { "acme": { "name": "Acme Gateway" } } }',
  )
  return env
}
