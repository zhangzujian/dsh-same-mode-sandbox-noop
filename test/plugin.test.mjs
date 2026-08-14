import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { apply, inject, name } from '../index.mjs'

const SCHEDULER_SYMBOL = Symbol('@deepseek-ai/dsh-tools.scheduler')

function cordisHarness({
  mode = 'danger-full-access',
  runtime,
  execute = input => input,
  prepare = input => input,
  includeExecute = true,
  includeScheduler = true,
  registerEffect = factory => factory(),
} = {}) {
  const testRuntime = runtime ?? {}
  const testScheduler = { prepare }
  if (runtime === undefined && includeExecute) testRuntime.execute = execute
  if (includeScheduler) testRuntime[SCHEDULER_SYMBOL] = testScheduler

  let disposer
  const ctx = {
    tools: testRuntime,
    sandboxPolicy: {
      resolve({ session } = {}) {
        return { mode: session?.mode ?? mode, workspaceRoot: '/workspace' }
      },
    },
    effect(factory) { disposer = registerEffect(factory) },
  }
  ctx.get = service => ctx[service]
  return {
    ctx,
    runtime: testRuntime,
    scheduler: testScheduler,
    dispose: () => disposer(),
  }
}

function fixture({ mode = 'danger-full-access', sessionMode } = {}) {
  const calls = []
  const testHarness = cordisHarness({
    mode,
    execute(input) {
      calls.push(input)
      return input
    },
    prepare(input) {
      calls.push(input)
      return input
    },
  })
  const agent = sessionMode === undefined ? undefined : { session: { mode: sessionMode } }
  const original = testHarness.runtime.execute
  const originalPrepare = testHarness.scheduler.prepare
  apply(testHarness.ctx)
  return { ...testHarness, calls, original, originalPrepare, agent }
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
    const testFixture = fixture()
    const args = {
      file_path: '/workspace/a',
      sandbox_permissions: 'danger-full-access',
      justification: 'already granted',
    }
    const input = execution(args)
    testFixture.runtime.execute(input)

    assert.equal(testFixture.calls.length, 1)
    assert.deepEqual(testFixture.calls[0].arguments, { file_path: '/workspace/a' })
    assert.deepEqual(args, {
      file_path: '/workspace/a',
      sandbox_permissions: 'danger-full-access',
      justification: 'already granted',
    })
    assert.notEqual(testFixture.calls[0], input)
  })

  it('uses the calling session effective mode', () => {
    const testFixture = fixture({ mode: 'workspace-write', sessionMode: 'danger-full-access' })
    testFixture.runtime.execute(execution({
      command: 'true',
      sandbox_permissions: 'danger-full-access',
      justification: 'session override is already full access',
    }, testFixture.agent, 'bash'))
    assert.deepEqual(testFixture.calls[0].arguments, { command: 'true' })
  })

  it('normalizes the Agent Loop scheduler preparation path', () => {
    const testFixture = fixture({ mode: 'workspace-write', sessionMode: 'danger-full-access' })
    testFixture.scheduler.prepare(execution({
      command: 'true',
      sandbox_permissions: 'workspace-write',
      justification: 'already covered by the session',
    }, testFixture.agent, 'bash'))
    assert.deepEqual(testFixture.calls[0].arguments, { command: 'true' })
  })

  it('removes an empty-justification request when it is not an escalation', () => {
    const testFixture = fixture({ mode: 'danger-full-access', sessionMode: 'danger-full-access' })
    const input = execution({
      command: "printenv | sed 's/=.*//' | LC_ALL=C sort",
      sandbox_permissions: 'workspace-write',
      justification: '',
    }, testFixture.agent, 'bash')
    testFixture.scheduler.prepare(input)
    assert.deepEqual(testFixture.calls[0].arguments, {
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
      const testFixture = fixture()
      testFixture.runtime.execute(input)
      assert.equal(testFixture.calls[0], input)
    }
  })

  it('restores the exact prior execute method on disposal', () => {
    class Runtime {
      execute(input) { return input }
    }
    const runtime = new Runtime()
    const testHarness = cordisHarness({ runtime })
    const original = runtime.execute
    apply(testHarness.ctx)
    assert.notEqual(runtime.execute, original)
    assert.equal(Object.hasOwn(runtime, 'execute'), true)
    testHarness.dispose()
    assert.equal(runtime.execute, original)
    assert.equal(Object.hasOwn(runtime, 'execute'), true)
  })

  it('restores the exact prior scheduler preparation method on disposal', () => {
    const testFixture = fixture()
    assert.notEqual(testFixture.scheduler.prepare, testFixture.originalPrepare)
    testFixture.dispose()
    assert.equal(testFixture.scheduler.prepare, testFixture.originalPrepare)
  })

  it('fails loudly without execute and leaves the runtime installable', () => {
    const testHarness = cordisHarness({ includeExecute: false })

    assert.throws(
      () => apply(testHarness.ctx),
      /same-mode-sandbox-noop requires tools\.execute to be a function/,
    )

    testHarness.runtime.execute = input => input
    assert.doesNotThrow(() => apply(testHarness.ctx))
    testHarness.dispose()
  })

  it('fails loudly without rc.6 scheduler preparation and leaves the runtime installable', () => {
    const testHarness = cordisHarness({ includeScheduler: false })

    assert.throws(
      () => apply(testHarness.ctx),
      /same-mode-sandbox-noop requires the rc\.6 scheduler\.prepare entry point/,
    )

    testHarness.runtime[SCHEDULER_SYMBOL] = testHarness.scheduler
    assert.doesNotThrow(() => apply(testHarness.ctx))
    testHarness.dispose()
  })

  it('rolls back methods and the installation marker when apply fails', () => {
    let failRegistration = true
    const testHarness = cordisHarness({
      registerEffect(factory) {
        if (failRegistration) throw new Error('effect registration failed')
        return factory()
      },
    })
    const originalExecute = testHarness.runtime.execute
    const originalPrepare = testHarness.scheduler.prepare

    assert.throws(() => apply(testHarness.ctx), /effect registration failed/)
    assert.equal(testHarness.runtime.execute, originalExecute)
    assert.equal(testHarness.scheduler.prepare, originalPrepare)

    failRegistration = false
    assert.doesNotThrow(() => apply(testHarness.ctx))
    testHarness.dispose()
  })

  it('fails loudly when installed twice on the same runtime', () => {
    const testFixture = fixture()

    assert.throws(
      () => apply(testFixture.ctx),
      /same-mode-sandbox-noop is already installed on this tool runtime/,
    )

    testFixture.dispose()
    assert.doesNotThrow(() => apply(testFixture.ctx))
  })

  it('makes a captured scheduler wrapper preserve original rc.6 behavior after disposal', () => {
    const testFixture = fixture()
    const patchedPrepare = testFixture.scheduler.prepare
    const laterPrepare = input => patchedPrepare(input)
    testFixture.scheduler.prepare = laterPrepare
    testFixture.dispose()

    const input = execution({
      command: 'true',
      sandbox_permissions: 'danger-full-access',
      justification: 'already granted',
    }, undefined, 'bash')
    testFixture.scheduler.prepare(input)

    assert.equal(testFixture.scheduler.prepare, laterPrepare)
    assert.equal(testFixture.calls[0], input)
  })

  it('makes a captured execute wrapper pass through unchanged after disposal', () => {
    const testFixture = fixture()
    const patchedExecute = testFixture.runtime.execute
    const laterExecute = input => patchedExecute(input)
    testFixture.runtime.execute = laterExecute
    testFixture.dispose()

    const input = execution({
      file_path: '/workspace/a',
      sandbox_permissions: 'danger-full-access',
      justification: 'already granted',
    })
    testFixture.runtime.execute(input)

    assert.equal(testFixture.runtime.execute, laterExecute)
    assert.equal(testFixture.calls[0], input)
  })

  it('does not overwrite a later wrapper during disposal', () => {
    const testFixture = fixture()
    const laterExecute = () => 'later'
    const laterPrepare = () => 'later prepare'
    testFixture.runtime.execute = laterExecute
    testFixture.scheduler.prepare = laterPrepare
    testFixture.dispose()
    assert.equal(testFixture.runtime.execute, laterExecute)
    assert.equal(testFixture.scheduler.prepare, laterPrepare)
  })
})
