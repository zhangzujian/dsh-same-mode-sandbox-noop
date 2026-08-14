/**
 * Compatibility plugin for DSH versions that reject a non-escalating
 * `sandbox_permissions` request at or below the call's effective mode.
 */

export const name = 'same-mode-sandbox-noop'
export const inject = ['tools', 'sandboxPolicy']

const ESCALATING_TOOLS = new Set(['bash', 'pwsh', 'write', 'edit'])
const MODE_RANK = new Map([
  ['read-only', 0],
  ['workspace-write', 1],
  ['danger-full-access', 2],
])
const CORDIS_ORIGINAL = Symbol.for('cordis.original')
const SCHEDULER_DESCRIPTION = '@deepseek-ai/dsh-tools.scheduler'

/** Return the requested mode only for a well-formed candidate we may normalize. */
function requestedMode(input) {
  if (!ESCALATING_TOOLS.has(input?.name)) return false
  const args = input.arguments
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return false
  if (typeof args.sandbox_permissions !== 'string') return false
  if (typeof args.justification !== 'string') return false
  return args.sandbox_permissions
}

/** Find rc.6's private Agent Loop scheduler without importing DSH internals. */
function findScheduler(runtime) {
  for (const symbol of Object.getOwnPropertySymbols(runtime)) {
    if (symbol.description !== SCHEDULER_DESCRIPTION) continue
    const scheduler = runtime[symbol]
    if (scheduler !== null && typeof scheduler === 'object' && typeof scheduler.prepare === 'function') {
      return scheduler
    }
  }
}

/**
 * Wrap both ToolRuntime entry points before either snapshots and freezes tool
 * arguments. Direct callers use execute(); the rc.6 Agent Loop bypasses it and
 * calls its private scheduler's prepare().
 */
export const apply = (ctx) => {
  // Use the underlying service implementations, not the injected context
  // accessors. Cordis detaches injected accessors before running teardown,
  // while these stable references remain valid for exact restoration.
  const toolsView = ctx.get('tools')
  const policyView = ctx.get('sandboxPolicy')
  const runtime = toolsView[CORDIS_ORIGINAL] ?? toolsView
  const sandboxPolicy = policyView[CORDIS_ORIGINAL] ?? policyView
  const originalExecute = runtime.execute
  const scheduler = findScheduler(runtime)
  const originalPrepare = scheduler?.prepare

  const normalize = (input) => {
    const requested = requestedMode(input)
    if (requested === false) return input
    const policy = sandboxPolicy.resolve(
      input?.agent === undefined ? {} : { session: input.agent.session },
    )
    const requestedRank = MODE_RANK.get(requested)
    const effectiveRank = MODE_RANK.get(policy.mode)
    if (requestedRank === undefined || effectiveRank === undefined || requestedRank > effectiveRank) {
      return input
    }

    const normalizedArguments = { ...input.arguments }
    delete normalizedArguments.sandbox_permissions
    delete normalizedArguments.justification
    return {
      ...input,
      arguments: normalizedArguments,
    }
  }

  const patchedExecute = function (input) {
    return originalExecute.call(runtime, normalize(input))
  }
  let patchedPrepare
  if (originalPrepare !== undefined) {
    patchedPrepare = function patchedPrepare(input) {
      return originalPrepare.call(scheduler, normalize(input))
    }
  }

  runtime.execute = patchedExecute
  if (patchedPrepare !== undefined) scheduler.prepare = patchedPrepare
  const dispose = () => {
    if (runtime.execute === patchedExecute) runtime.execute = originalExecute
    if (patchedPrepare !== undefined && scheduler.prepare === patchedPrepare) scheduler.prepare = originalPrepare
  }
  ctx.effect(() => dispose, 'same-mode sandbox compatibility wrapper teardown')
}
