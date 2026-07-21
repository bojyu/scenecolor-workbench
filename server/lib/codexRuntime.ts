import { spawn } from 'child_process'
import { access, readFile, readdir, stat } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'

export interface CodexRuntimeSelection {
  providerId: string
  model: string
  reasoningEffort: ReasoningEffort
  skillId: string
}

export interface RuntimeProviderOption {
  id: string
  name: string
  kind: 'codex-login' | 'custom'
}

export interface RuntimeModelOption {
  id: string
  name: string
  description: string
}

export interface RuntimeSkillOption {
  id: string
  name: string
  description: string
}

export interface CodexRuntimeStatus {
  available: boolean
  authenticated: boolean
  authMethod: string
  version: string
  executable: string
  currentProviderId: string
  currentModel: string
  currentReasoningEffort: ReasoningEffort
  providers: RuntimeProviderOption[]
  models: RuntimeModelOption[]
  reasoningEfforts: Array<{ id: ReasoningEffort; name: string; description: string }>
  skills: RuntimeSkillOption[]
  checkedAt: string
  error?: string
}

export interface ProcessResult {
  stdout: string
  stderr: string
}

const MAX_PROCESS_OUTPUT = 240_000

function appendBounded(current: string, chunk: string): string {
  const next = current + chunk
  return next.length > MAX_PROCESS_OUTPUT ? next.slice(next.length - MAX_PROCESS_OUTPUT) : next
}

export async function runProcess(
  command: string,
  args: string[],
  stdin: string | null,
  signal?: AbortSignal,
  timeoutMs = 30_000,
): Promise<ProcessResult> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = () => {
      child.kill()
      finish(() => reject(Object.assign(new Error('Codex 后台任务已取消'), { name: 'AbortError' })))
    }
    const timeout = setTimeout(() => {
      child.kill()
      finish(() => reject(new Error('Codex 后台任务超时')))
    }, timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', chunk => { stdout = appendBounded(stdout, chunk.toString()) })
    child.stderr.on('data', chunk => { stderr = appendBounded(stderr, chunk.toString()) })
    child.once('error', error => finish(() => reject(new Error(`无法启动 Codex 后台：${error.message}`))))
    child.once('close', code => finish(() => {
      if (code === 0) resolvePromise({ stdout, stderr })
      else reject(new Error((stderr || stdout).trim().slice(-1200) || `Codex 后台退出 (${code ?? 'unknown'})`))
    }))
    if (stdin !== null) child.stdin.end(stdin, 'utf8')
    else child.stdin.end()
  })
}

async function newestDesktopCodex(): Promise<string | null> {
  const localAppData = process.env.LOCALAPPDATA
  if (!localAppData) return null
  const binRoot = join(localAppData, 'OpenAI', 'Codex', 'bin')
  const candidates: Array<{ path: string; modified: number }> = []
  try {
    const direct = join(binRoot, 'codex.exe')
    await access(direct)
    candidates.push({ path: direct, modified: (await stat(direct)).mtimeMs })
  } catch {}
  try {
    const entries = await readdir(binRoot, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const path = join(binRoot, entry.name, 'codex.exe')
      try {
        await access(path)
        candidates.push({ path, modified: (await stat(path)).mtimeMs })
      } catch {}
    }
  } catch {}
  candidates.sort((left, right) => right.modified - left.modified)
  return candidates[0]?.path || null
}

export async function resolveCodexInvocation(): Promise<{ command: string; prefixArgs: string[] }> {
  const configured = process.env.SCENECOLOR_CODEX_BIN?.trim()
  if (configured) return { command: configured, prefixArgs: [] }
  if (process.platform !== 'win32') return { command: 'codex', prefixArgs: [] }

  const desktopCodex = await newestDesktopCodex()
  if (desktopCodex) return { command: desktopCodex, prefixArgs: [] }

  const appData = process.env.APPDATA
  if (appData) {
    const entry = join(appData, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    try {
      await access(entry)
      return { command: process.execPath, prefixArgs: [entry] }
    } catch {}
  }
  throw new Error('未找到 Codex 后台运行时；请先安装或登录 Codex')
}

interface ParsedConfig {
  model: string
  providerId: string
  reasoningEffort: ReasoningEffort
  customProviders: RuntimeProviderOption[]
}

function quotedValue(text: string, key: string): string | null {
  const match = text.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'm'))
  return match?.[1] || null
}

function parseConfig(text: string): ParsedConfig {
  const configuredReasoning = quotedValue(text, 'model_reasoning_effort')
  const reasoningEffort = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(configuredReasoning || '')
    ? configuredReasoning as ReasoningEffort
    : 'medium'
  const customProviders: RuntimeProviderOption[] = []
  const sectionPattern = /^\s*\[model_providers\.([A-Za-z0-9_-]+)\]\s*$/gm
  let match: RegExpExecArray | null
  while ((match = sectionPattern.exec(text))) {
    const id = match[1]
    const tail = text.slice(sectionPattern.lastIndex)
    const nextSection = tail.search(/^\s*\[/m)
    const section = nextSection >= 0 ? tail.slice(0, nextSection) : tail
    const name = quotedValue(section, 'name') || id
    customProviders.push({ id, name, kind: 'custom' })
  }
  return {
    model: quotedValue(text, 'model') || 'gpt-5.6-sol',
    providerId: quotedValue(text, 'model_provider') || 'codex',
    reasoningEffort,
    customProviders,
  }
}

async function readCodexConfig(): Promise<ParsedConfig> {
  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
  try {
    return parseConfig(await readFile(join(codexHome, 'config.toml'), 'utf8'))
  } catch {
    return { model: 'gpt-5.6-sol', providerId: 'codex', reasoningEffort: 'medium', customProviders: [] }
  }
}

async function readSkillCatalog(appRoot: string): Promise<RuntimeSkillOption[]> {
  const skillsRoot = join(appRoot, 'skills')
  const skills: RuntimeSkillOption[] = []
  try {
    const entries = await readdir(skillsRoot, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[A-Za-z0-9_-]+$/.test(entry.name)) continue
      const skillPath = join(skillsRoot, entry.name, 'SKILL.md')
      try {
        const text = await readFile(skillPath, 'utf8')
        const frontmatterName = text.match(/^name:\s*([^\r\n]+)$/m)?.[1]?.trim()
        const description = text.match(/^description:\s*([^\r\n]+)$/m)?.[1]?.trim()
        const displayName = text.match(/^#\s+(.+)$/m)?.[1]?.trim()
        skills.push({
          id: entry.name,
          name: displayName || frontmatterName || entry.name,
          description: description || '本地训练 Skill',
        })
      } catch {}
    }
  } catch {}
  return skills
}

export async function getCodexRuntimeStatus(appRoot: string): Promise<CodexRuntimeStatus> {
  const checkedAt = new Date().toISOString()
  const config = await readCodexConfig()
  const skills = await readSkillCatalog(appRoot)
  const providers: RuntimeProviderOption[] = [
    { id: 'codex', name: 'Codex（当前登录）', kind: 'codex-login' },
    ...config.customProviders.filter(provider => provider.id !== 'codex'),
  ]
  const models: RuntimeModelOption[] = [
    { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', description: '高质量视觉判断与复杂 Skill 推理' },
    { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', description: '更快的批量检查与轻量任务' },
    { id: 'gpt-5.6', name: 'GPT-5.6', description: '通用高强度 Agent 模型' },
  ]
  if (config.model && !models.some(model => model.id === config.model)) {
    models.unshift({ id: config.model, name: config.model, description: '当前 Codex 配置模型' })
  }
  const base: CodexRuntimeStatus = {
    available: false,
    authenticated: false,
    authMethod: '未登录',
    version: '',
    executable: '',
    currentProviderId: providers.some(provider => provider.id === config.providerId) ? config.providerId : 'codex',
    currentModel: config.model,
    currentReasoningEffort: config.reasoningEffort,
    providers,
    models,
    reasoningEfforts: [
      { id: 'low', name: '低', description: '速度优先' },
      { id: 'medium', name: '中', description: '质量与速度平衡' },
      { id: 'high', name: '高', description: '复杂几何判断' },
      { id: 'xhigh', name: '超高', description: '困难遮挡与多椅场景' },
      { id: 'max', name: '最大', description: '模型支持时使用最大推理' },
      { id: 'ultra', name: 'Ultra', description: '仅限支持的模型与账户' },
    ],
    skills,
    checkedAt,
  }

  try {
    const invocation = await resolveCodexInvocation()
    base.executable = invocation.command
    const versionResult = await runProcess(invocation.command, [...invocation.prefixArgs, '--version'], null, undefined, 5_000)
    base.version = versionResult.stdout.trim() || versionResult.stderr.trim()
    base.available = true
    const loginResult = await runProcess(invocation.command, [...invocation.prefixArgs, 'login', 'status'], null, undefined, 8_000)
    const loginText = `${loginResult.stdout}\n${loginResult.stderr}`.trim()
    base.authenticated = /logged in|authenticated/i.test(loginText)
    base.authMethod = loginText || (base.authenticated ? '已登录' : '未登录')
  } catch (error: any) {
    base.error = error?.message || 'Codex 后台状态检查失败'
  }
  return base
}

export function validateRuntimeSelection(input: unknown): CodexRuntimeSelection {
  const value = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const providerId = typeof value.providerId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value.providerId) ? value.providerId : 'codex'
  const model = typeof value.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value.model) ? value.model : 'gpt-5.6-sol'
  const reasoningEffort = typeof value.reasoningEffort === 'string' && ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(value.reasoningEffort)
    ? value.reasoningEffort as ReasoningEffort
    : 'medium'
  const skillId = typeof value.skillId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value.skillId) ? value.skillId : 'chair-angle-matcher'
  return { providerId, model, reasoningEffort, skillId }
}
