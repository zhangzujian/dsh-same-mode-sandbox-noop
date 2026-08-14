import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { before, describe, it } from 'node:test'
import * as plugin from '../index.mjs'

const installDir = process.env.DSH_INSTALL_DIR
const integration = installDir === undefined ? describe.skip : describe

async function packageImport(name) {
  return import(pathToFileURL(join(installDir, 'node_modules', '@deepseek-ai', name, 'lib', 'index.js')).href)
}

integration('DSH rc.6 integration', () => {
  let Context
  let SystemPrompt
  let ToolRuntime
  let TOOL_RUNTIME_SCHEDULER
  let CallId
  let SandboxPolicyService
  let SandboxedFileSystem
  let applyToolFs
  let LocalSubprocessRuntime
  let applyShellEnv
  let LocalSandboxProvider
  let SandboxBashExecutor
  let applyToolBash
  let directory

  before(async () => {
    ;({ Context } = await packageImport('cordis'))
    ;({ SystemPrompt } = await packageImport('dsh-system-prompt'))
    ;({ ToolRuntime, TOOL_RUNTIME_SCHEDULER } = await packageImport('dsh-tools'))
    ;({ CallId } = await packageImport('dsh-llm'))
    ;({ SandboxPolicyService } = await packageImport('dsh-sandbox-policy'))
    ;({ SandboxedFileSystem } = await packageImport('dsh-fs-sandbox'))
    ;({ apply: applyToolFs } = await packageImport('dsh-tool-fs'))
    ;({ default: LocalSubprocessRuntime } = await packageImport('dsh-subprocess-local'))
    ;({ apply: applyShellEnv } = await packageImport('dsh-shell-env'))
    ;({ default: LocalSandboxProvider } = await packageImport('dsh-sandbox-local'))
    ;({ default: SandboxBashExecutor } = await packageImport('dsh-bash-sandbox'))
    ;({ apply: applyToolBash } = await packageImport('dsh-tool-bash'))
    directory = await mkdtemp(join(tmpdir(), 'dsh-same-mode-plugin-'))
  })

  async function base(mode) {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: true, persona: '' })
    await ctx.plugin(ToolRuntime, { mode: 'native', maxParallelSubCalls: 10 })
    await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: directory })
    return ctx
  }

  function agent(mode) {
    const events = mode === undefined ? [] : [{ type: 'sandbox/mode', data: { mode } }]
    return {
      id: 'plugin-agent',
      session: {
        id: 'plugin-session',
        header: { version: 0, id: 'plugin-session', createdAt: 0, cwd: directory },
        events,
        append(type, data) { events.push({ type, data }) },
      },
    }
  }

  function text(result) {
    return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
  }

  async function executeScheduled(ctx, input) {
    const scheduler = ctx.tools[TOOL_RUNTIME_SCHEDULER]
    const prepared = await scheduler.prepare(input)
    if (prepared.kind === 'dispatch') {
      const dispatched = await scheduler.dispatch(prepared.exec)
      return dispatched.kind === 'post-result'
        ? scheduler.finalize(prepared.exec, dispatched.result)
        : scheduler.finish(prepared.exec, dispatched.result)
    }
    return prepared.kind === 'post-result'
      ? scheduler.finalize(prepared.exec, prepared.result)
      : scheduler.finish(prepared.exec, prepared.result)
  }

  it('edits with a redundant full-access request and restores rc.6 behavior after disposal', async () => {
    const target = join(directory, 'edit.txt')
    await writeFile(target, 'before\n')
    const ctx = await base('danger-full-access')
    await ctx.plugin(SandboxedFileSystem, { cwd: directory, diffBasisMaxBytes: 1024 * 1024 })
    applyToolFs(ctx, { readLimit: 2000, readMaxLineLength: 2000, readMaxBytes: 1024 * 1024, readStreamMinSize: 64 * 1024 })

    const original = ctx.tools.execute
    const rawRuntime = ctx.tools[Symbol.for('cordis.original')]
    const originalRaw = rawRuntime.execute
    const pluginFiber = await ctx.plugin(plugin)
    const input = suffix => ({
      callId: CallId(`edit-${suffix}`),
      name: 'edit',
      arguments: {
        file_path: target,
        old_string: suffix === 'plugin' ? 'before' : 'after',
        new_string: suffix === 'plugin' ? 'after' : 'unexpected',
        replace_all: false,
        sandbox_permissions: 'danger-full-access',
        justification: 'the standing mode already grants this access',
      },
      signal: new AbortController().signal,
    })

    const success = await ctx.tools.execute(input('plugin'))
    assert.equal(success.isError, false, text(success))
    assert.equal(await readFile(target, 'utf8'), 'after\n')

    await pluginFiber.dispose()
    assert.equal(rawRuntime.execute, originalRaw)
    assert.equal(ctx.tools.execute.name, original.name)
    const originalFailure = await ctx.tools.execute(input('original'))
    assert.equal(originalFailure.isError, true)
    assert.match(text(originalFailure), /not strictly wider/)
    assert.equal(await readFile(target, 'utf8'), 'after\n')
    await ctx.fiber.dispose()
  })

  it('runs bash for equal and narrower session requests while preserving a wider failure', async () => {
    const ctx = await base('workspace-write')
    await ctx.plugin(LocalSubprocessRuntime)
    applyShellEnv(ctx)
    await ctx.plugin(LocalSandboxProvider, { runnerCommand: [], runnerFailureSignatures: [], probeTimeoutMs: 5000 })
    await ctx.plugin(SandboxBashExecutor, {})
    applyToolBash(ctx, { enableRunInBackground: false })
    await ctx.plugin(plugin)

    const execute = (id, mode, currentAgent) => ctx.tools.execute({
      callId: CallId(id),
      name: 'bash',
      arguments: {
        command: "printf 'plugin-ok'",
        description: 'exercise the compatibility plugin',
        sandbox_permissions: mode,
        justification: 'exercise the compatibility plugin',
      },
      agent: currentAgent,
      signal: new AbortController().signal,
    })

    const fullAgent = agent('danger-full-access')
    const same = await execute('bash-same', 'danger-full-access', fullAgent)
    assert.equal(same.isError, false, text(same))
    assert.equal(text(same), 'plugin-ok')

    const narrower = await executeScheduled(ctx, {
      callId: CallId('bash-narrower'),
      name: 'bash',
      arguments: {
        command: "printenv | sed 's/=.*//' | LC_ALL=C sort",
        description: 'list environment variable names',
        timeoutMs: 10000,
        workdir: directory,
        run_in_background: false,
        sandbox_permissions: 'workspace-write',
        justification: 'x',
      },
      agent: fullAgent,
      signal: new AbortController().signal,
    })
    assert.equal(narrower.isError, false, text(narrower))
    assert.match(text(narrower), /^PATH$/m)

    const wider = await execute('bash-wider', 'danger-full-access', agent())
    assert.equal(wider.isError, true)
    assert.match(text(wider), /no approval service is composed/)
    await ctx.fiber.dispose()
  })

  it('leaves malformed argument pairs to the original tool validator', async () => {
    const ctx = await base('danger-full-access')
    await ctx.plugin(SandboxedFileSystem, { cwd: directory, diffBasisMaxBytes: 1024 * 1024 })
    applyToolFs(ctx, { readLimit: 2000, readMaxLineLength: 2000, readMaxBytes: 1024 * 1024, readStreamMinSize: 64 * 1024 })
    await ctx.plugin(plugin)
    const result = await ctx.tools.execute({
      callId: CallId('malformed'),
      name: 'write',
      arguments: { file_path: join(directory, 'malformed.txt'), content: 'no', sandbox_permissions: 'danger-full-access' },
      signal: new AbortController().signal,
    })
    assert.equal(result.isError, true)
    assert.match(text(result), /requires a justification/)
    await ctx.fiber.dispose()
  })
})
