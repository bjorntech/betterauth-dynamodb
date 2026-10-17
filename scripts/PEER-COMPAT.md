# Exact-peer runtime check

The root lockfile intentionally stays on Better Auth 1.7.5. To exercise the actual
source against exactly 1.6.25 without changing that manifest or lockfile, use a
fresh worktree with no `node_modules` and run from its root:

```sh
mkdir -p .peer-compat
node --input-type=module <<'JS'
import fs from 'node:fs';
const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
p.private = true;
delete p.scripts;
delete p.peerDependencies;
for (const name of ['better-auth', '@better-auth/core', '@better-auth/test-utils', '@better-auth/oauth-provider']) {
  p.devDependencies[name] = '1.6.25';
}
fs.writeFileSync('.peer-compat/package.json', JSON.stringify(p, null, 2) + '\n');
JS
bun install --cwd .peer-compat
ln -s .peer-compat/node_modules node_modules
bun scripts/test-peer-compat.ts --transactions
bun run typecheck
bun run test
bun run test:integration:local
```

All four packages above are published at 1.6.25, including test-utils. Do not
commit `.peer-compat/`, the symlink, or temporary installation artifacts. Keep
the generated fixture lockfile locally to repeat the same dependency graph;
subsequent fixture installs may use `bun install --cwd .peer-compat --frozen-lockfile`.
The root lockfile is never rewritten. The script checks the versions actually
resolved by Node/Bun, rather than trusting the install command.

The smoke launches the repository's pinned local Dynoxide helper with fake
credentials and an isolated table. It checks the real factory's model/field/date
and selection transformations. `--transactions` additionally requires one
aggregate transaction commit, transformed callback results, callback-error
rollback and all-or-nothing unique-conflict rollback; this intentionally fails
on the original `transaction: false` adapter.
Without that flag it is also useful for the original baseline. It does not claim
AWS production compatibility. Run the integration suite too for pagination and
storage semantics; this smoke does not substitute for cursor-companion tests.

With version-compatible test fixtures, the original adapter plus the Dynoxide
infrastructure passes `bun run verify` against exact 1.6.25 (93 unit tests,
coverage, CRAP and build). Integration passes 272 tests, including all 238
official conformance cases; one provider-resource test is explicitly skipped.

Core 1.6.25's `getAuthTables` drops plugin table-level `indexes` metadata.
Compound-lock integration tests therefore use an explicit standalone store
schema fixture through the real adapter factory on that version. They still run
all atomicity, TTL, update/delete and stale-ownership assertions; they do not
claim that schema-index discovery exists on 1.6. On versions retaining the
metadata, those tests continue using the unmodified public adapter path.

Provider 1.6.25 has no `oauthClientResource` model, so only the test of that
published model is capability-skipped. The provider refresh-family cleanup test
continues to run on both versions. Native joins enable both version-specific
configuration spellings. No adapter failures are excluded or masked.

The same compatibility edits pass `bun run verify` and all 273 integration
tests against the root's exact 1.7.5 peer family, with no skipped tests.
