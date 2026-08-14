import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { apply, inject, name } from '../index.mjs'

function fixture({ mode = 'danger-full-access', sessionMode } = {}) {
  const calls = []
  const schedulerSymbol = Symbol('@deepseek-ai/dsh-tools.scheduler')
  const scheduler = {
    prepare(input) {
      calls.push(input)
      return input
    },
  }
  const runtime = {
    execute(input) {
      calls.push(input)
      return input
    },
    [schedulerSymbol]: scheduler,
  }
  const ctx = {
    tools: runtime,
    sandboxPolicy: {
      resolve({ session } = {}) {
        return { mode: session?.mode ?? mode, workspaceRoot: '/workspace' }
      },
    },
    effect(factory) { disposer = factory() },
  }
  let disposer
  ctx.get = service => ctx[service]
  const agent = sessionMode === undefined ? undefined : { session: { mode: sessionMode } }
  const original = runtime.execute
  const originalPrepare = scheduler.prepare
  apply(ctx)
  return { calls, runtime, scheduler, original, originalPrepare, agent, dispose: () => disposer() }
}

function execution(arguments_, agent, name_ = 'edit') {
  return {
    callId: 'call-1',
    name: name_,
    arguments: arguments_,
    ...(agent === undefined ? {} : { agent }),
    signal: new AbortController().signal,
  }
}

describe('same-mode-sandbox-noop', () => {
  it('exports a Cordis plugin with explicit dependencies', () => {
    assert.equal(name, 'same-mode-sandbox-noop')
    assert.deepEqual(inject, ['tools', 'sandboxPolicy'])
  })

  it('removes a paired, non-empty same-mode request without mutating caller input', () => {
    const f = fixture()
    const args = {
      file_path: '/workspace/a',
      sandbox_permissions: 'danger-full-access',
      justification: 'already granted',
    }
    const input = execution(args)
    f.runtime.execute(input)

    assert.equal(f.calls.length, 1)
    assert.deepEqual(f.calls[0].arguments, { file_path: '/workspace/a' })
    assert.deepEqual(args, {
      file_path: '/workspace/a',
      sandbox_permissions: 'danger-full-access',
      justification: 'already granted',
    })
    assert.notEqual(f.calls[0], input)
  })

  it('uses the calling session effective mode', () => {
    const f = fixture({ mode: 'workspace-write', sessionMode: 'danger-full-access' })
    f.runtime.execute(execution({
      command: 'true',
      sandbox_permissions: 'danger-full-access',
      justification: 'session override is already full access',
    }, f.agent, 'bash'))
    assert.deepEqual(f.calls[0].arguments, { command: 'true' })
  })

  it('normalizes the Agent Loop scheduler preparation path', () => {
    const f = fixture({ mode: 'workspace-write', sessionMode: 'danger-full-access' })
    f.scheduler.prepare(execution({
      command: 'true',
      sandbox_permissions: 'workspace-write',
      justification: 'already covered by the session',
    }, f.agent, 'bash'))
    assert.deepEqual(f.calls[0].arguments, { command: 'true' })
  })

  it('removes an empty-justification request when it is not an escalation', () => {
    const f = fixture({ mode: 'danger-full-access', sessionMode: 'danger-full-access' })
    const input = execution({
      command: "printenv | sed 's/=.*//' | LC_ALL=C sort",
      sandbox_permissions: 'workspace-write',
      justification: '',
    }, f.agent, 'bash')
    f.scheduler.prepare(input)
    assert.deepEqual(f.calls[0].arguments, {
      command: "printenv | sed 's/=.*//' | LC_ALL=C sort",
    })
    assert.equal(input.arguments.justification, '')
  })

  it('removes narrower requests and preserves genuinely wider requests', () => {
    const full = fixture({ mode: 'danger-full-access' })
    const narrower = execution({ sandbox_permissions: 'workspace-write', justification: 'try narrower' })
    full.runtime.execute(narrower)
    assert.deepEqual(full.calls[0].arguments, {})
    assert.deepEqual(narrower.arguments, {
      sandbox_permissions: 'workspace-write',
      justification: 'try narrower',
    })

    const confined = fixture({ mode: 'workspace-write' })
    const wider = execution({ sandbox_permissions: 'danger-full-access', justification: 'needs wider access' })
    confined.runtime.execute(wider)
    assert.equal(confined.calls[0], wider)

    const widerWithEmptyReason = execution({ sandbox_permissions: 'danger-full-access', justification: '' })
    confined.runtime.execute(widerWithEmptyReason)
    assert.equal(confined.calls[1], widerWithEmptyReason)

    const unknownRequest = execution({ sandbox_permissions: 'unknown', justification: 'unknown request' })
    full.runtime.execute(unknownRequest)
    assert.equal(full.calls[1], unknownRequest)

    const unknownPolicy = fixture({ mode: 'unknown' })
    const knownRequest = execution({ sandbox_permissions: 'workspace-write', justification: 'unknown policy' })
    unknownPolicy.runtime.execute(knownRequest)
    assert.equal(unknownPolicy.calls[0], knownRequest)
  })

  it('preserves missing, unrelated, and non-object arguments', () => {
    const cases = [
      execution({ sandbox_permissions: 'danger-full-access' }),
      execution({ justification: 'orphan reason' }),
      execution({ sandbox_permissions: 'danger-full-access', justification: 'valid' }, undefined, 'other'),
      execution(null),
    ]
    for (const input of cases) {
      const f = fixture()
      f.runtime.execute(input)
      assert.equal(f.calls[0], input)
    }
  })

  it('restores the exact prior execute method on disposal', () => {
    class Runtime {
      execute(input) { return input }
    }
    const runtime = new Runtime()
    const original = runtime.execute
    let disposer
    const ctx = {
      tools: runtime,
      sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
      effect(factory) { disposer = factory() },
    }
    ctx.get = service => ctx[service]
    apply(ctx)
    assert.notEqual(runtime.execute, original)
    assert.equal(Object.hasOwn(runtime, 'execute'), true)
    disposer()
    assert.equal(runtime.execute, original)
    assert.equal(Object.hasOwn(runtime, 'execute'), true)
  })

  it('restores the exact prior scheduler preparation method on disposal', () => {
    const f = fixture()
    assert.notEqual(f.scheduler.prepare, f.originalPrepare)
    f.dispose()
    assert.equal(f.scheduler.prepare, f.originalPrepare)
  })

  it('does not overwrite a later wrapper during disposal', () => {
    const f = fixture()
    const later = () => 'later'
    const laterPrepare = () => 'later prepare'
    f.runtime.execute = later
    f.scheduler.prepare = laterPrepare
    f.dispose()
    assert.equal(f.runtime.execute, later)
    assert.equal(f.scheduler.prepare, laterPrepare)
  })
})
