# dsh-same-mode-sandbox-noop

A removable compatibility plugin for DeepSeek Harness / DSH `0.1.0-rc.6`.

That release rejects a tool call when `sandbox_permissions` redundantly names
the call's already-effective sandbox mode:

```text
Error: sandbox escalation to "danger-full-access" is not strictly wider than
this call's current "danger-full-access" mode
```

The plugin wraps `ctx.tools.execute()` before DSH snapshots and freezes tool
arguments. For `bash`, `pwsh`, `write`, and `edit`, it removes the paired
`sandbox_permissions` and `justification` fields only when the requested mode
equals the calling session's effective mode. The original runtime then executes
the call under its standing policy.

Narrower requests, genuinely wider requests, malformed argument pairs, empty
justifications, unrelated tools, and calls without escalation fields pass to
DSH unchanged. Disposal restores the original runtime method.

This is an out-of-tree compatibility workaround. Prefer a DSH release that
handles equal-mode requests in the shared sandbox escalation layer when one is
available.

## Install into a DSH profile

Until this package is published to npm, clone it and add the local directory:

```bash
git clone https://github.com/zhangzujian/dsh-same-mode-sandbox-noop.git
cd dsh-same-mode-sandbox-noop
npx @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile web add "$PWD"
```

The package declares a DSH bundle, so `dsh plugin` adds its patch layer to the
profile automatically. Restart `dsh web` after installation.

To remove it:

```bash
npx @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile web remove @zhangzujian/dsh-same-mode-sandbox-noop
```

For a one-off local overlay without profile installation, insert the plugin by
file URL in a patch loaded after the base bundle:

```yaml
- insert:
    - id: same-mode-sandbox-noop
      name: file:///absolute/path/to/dsh-same-mode-sandbox-noop/index.mjs
```

## Test

Unit tests require only Node.js:

```bash
npm test
```

Integration tests run against an installed DSH tree:

```bash
DSH_INSTALL_DIR=/path/to/npx/cache/package npm run test:integration
```

`DSH_INSTALL_DIR` is the directory containing `node_modules/@deepseek-ai`.

## License

MIT
