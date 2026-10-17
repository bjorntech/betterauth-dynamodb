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

Baseline at the original adapter plus the Dynoxide infrastructure commit:
typecheck passed; units 92/93 (native joins use the 1.7 configuration spelling);
integration 267/272 (all 238 official conformance cases passed). The five integration failures assume 1.7 OAuth-provider
models/schema indexes absent from 1.6.25. These suite-version assumptions must
not be mistaken for failures of package loading or basic adapter CRUD.
