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

/** Return the requested mode only for a well-formed candidate we may normalize. */
function requestedMode(input) {
  if (!ESCALATING_TOOLS.has(input?.name)) return false
  const args = input.arguments
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return false
  if (typeof args.sandbox_permissions !== 'string') return false
  if (typeof args.justification !== 'string' || args.justification.trim().length === 0) return false
  return args.sandbox_permissions
}

/**
 * Wrap ToolRuntime before it snapshots and freezes tool arguments. Known
 * requests at or below the effective mode become ordinary standing-policy
 * calls; genuinely wider and unknown requests remain the original runtime's
 * responsibility.
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

  const patchedExecute = function (input) {
    const requested = requestedMode(input)
    if (requested === false) return originalExecute.call(runtime, input)
    const policy = sandboxPolicy.resolve(
      input?.agent === undefined ? {} : { session: input.agent.session },
    )
    const requestedRank = MODE_RANK.get(requested)
    const effectiveRank = MODE_RANK.get(policy.mode)
    if (requestedRank === undefined || effectiveRank === undefined || requestedRank > effectiveRank) {
      return originalExecute.call(runtime, input)
    }

    const normalizedArguments = { ...input.arguments }
    delete normalizedArguments.sandbox_permissions
    delete normalizedArguments.justification
    return originalExecute.call(runtime, {
      ...input,
      arguments: normalizedArguments,
    })
  }

  runtime.execute = patchedExecute
  const dispose = () => {
    if (runtime.execute !== patchedExecute) return
    runtime.execute = originalExecute
  }
  ctx.effect(() => dispose, 'same-mode sandbox compatibility wrapper teardown')
}
