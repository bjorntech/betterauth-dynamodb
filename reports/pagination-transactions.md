# Cursor pagination and callback transactions

## Scope and baseline

- Target: `@bjorntech/betterauth-dynamodb` 1.1.0, branch
  `feat/cursor-pagination-transactions`, Better Auth peer `^1.6.25`.
- Starting commit: `f9f3555` (the existing 1.1.0 release merge).
- Read contributor instructions, README, adapter implementation and existing tests
  before implementation. Preserve entity/sidecar/lock key formats, injected clients,
  revision guards, logical TTL and the no-hidden-scan default.
- Installed the existing lockfile with `bun install --frozen-lockfile`.
- Baseline `bun run verify`: passed (93 unit tests; CRAP maximum 6.00).
- The repository lockfile installs Better Auth, core and test-utils 1.7.5;
  compatibility with the requested 1.6.25 transaction hook is checked separately.

## Implementation and final verification

### Dynoxide infrastructure

- `7679a4026b59dfdb0b1c0d4709171fd113ea4183` installs pinned Dynoxide
  1.3.0 and replaces Testcontainers/Docker integration lifecycle and CI setup.
- `bun install --frozen-lockfile` installs the native optional platform binary.
  No Docker/JVM or separately managed test server is required.
- Shared test helpers launch isolated in-memory processes on loopback with fake
  credentials; each suite owns its tables and stops its process.
- Root-worktree `bun run test:integration:local` passed after merging the setup:
  **272 tests**, including **238 Better Auth kit test cases**. Pagination and
  transaction feature verification follows below.
- Optional manual server: `bun run dynamo:local --port 8000`.

### Cursor pagination

- `6899b19` adds `createDynamoDBPaginator(options).findPage(request)` and public
  request/result types without changing Better Auth's array-returning `findMany`.
- A page performs one strongly consistent keyed Query plus bounded owner gets.
  It never scans or fans out an IN list; an independent equality anchor can
  support IN and other residual filters. `4c84954` tests the id-IN residual case
  and adds built-export/exact-peer cursor smoke assertions.
- `limit` bounds evaluated keys, not matching records. Empty filtered or expired
  pages can carry a continuation token. Only `nextCursor: null` proves exhaustion.
- Native `{ field: "key", direction: "asc" | "desc" }` order is the binary
  order of existing length-prefixed keys, not arbitrary entity-field/id order.
- Tokens contain versioned base64url JSON with `LastEvaluatedKey` and a query
  fingerprint. Canonical encoding, fingerprint, partition, shape, key length and
  length-prefix bytes are validated. They are **not signed or encrypted**, confer
  no authorization, and provide no cross-page snapshot. Table/model/predicates,
  direction, projection and TTL configuration are bound; page size may change.
- Root verification after cursor integration: **114 unit tests passed**,
  cursor module **100% coverage**, repository CRAP maximum **6.00**; three focused
  Dynoxide cursor integration tests and dist import smoke passed.
- Integration cases cover inserts before/after the boundary, ascending/descending
  order, exact/full/empty page boundaries, Unicode and length-prefix ordering,
  residual filters, TTL, projection, exact-id access and rejected query changes.

### Multi-item callback transactions

- `6b2bba9` implements Better Auth's real factory `config.transaction` hook.
  Both installed core 1.7.5 and the exact downloaded core 1.6.25 expose that hook.
  Each initialized adapter retains its own schema/options, including model/field
  mappings; the transaction callback receives a factory-transformed scoped adapter.
- Writes across models are buffered, read-your-writes is supported, and repeated
  changes coalesce into one final mutation per entity. One `TransactWriteItems`
  request commits final entities, sidecars, locks and read guards atomically.
- Original hidden revisions guard mutations and observed existing entities.
  Absent id reads receive non-existence guards. Callback throw discards the buffer;
  condition/uniqueness failures reject the whole commit. Transport errors can
  leave an unknown all-or-none outcome, not a promise that nothing committed.
- Native ADD remains unchanged outside callbacks; scoped increments become
  revision-guarded final replacements. Late consume/increment conflicts reject the
  callback, rather than changing an already returned tentative result to `null`.
- Aggregate 100-action and approximate 4 MB validation runs before sending.
  Cross-record lock swaps/transfers needing duplicate item actions fail explicitly.
  Nested callbacks, id-changing updates and escaped closed scopes reject. Expired
  physical observations conflict; legacy rows without revisions reject.
- Queries retain normal no-hidden-scan/page-budget rules. This is not interactive
  DynamoDB snapshot, predicate or phantom isolation; absent indexed matches cannot
  be guarded. Every hydrated entity can consume a guard, even if later windowed
  out. Do not infer serializability from atomic commit.
- Nine dedicated Dynoxide tests cover multi-model commit, callback rollback,
  uniqueness-failure rollback, read/absence guards, repeated changes, consume and
  increment, ABA, concurrent consume winners, retained TTL/compound locks and caps.
  The official Better Auth transaction conformance suite is also enabled.
- Independent cursor and transaction reviews found no additional correctness
  defects; both reviewers reran quality gates and focused Dynoxide integrations.

## Verification results

Main lockfile (Better Auth/core/test-utils/provider 1.7.5):

| Command | Result |
| --- | --- |
| `bun install --frozen-lockfile` | Passed; Dynoxide 1.3.0 installed locally |
| `bun run test` | 130 unit tests passed |
| `bun run verify` | Passed: typecheck, lint, coverage, CRAP and build |
| Coverage | 98.26% lines/statements, 93.45% branches; cursor and transaction modules 100% |
| `bun run quality:crap` (via verify) | Maximum 6.00 across 362 production functions |
| `bun run test:integration:local` | 287 tests passed across five files; 240 official kit cases, including transaction conformance |
| `bun run smoke:dist-import` | Passed, including new public paginator export |
| Exact-version runtime smoke with version 1.7.5 and `--transactions` | Passed: mappings/dates, cursor boundaries, aggregate commit and both rollback paths |

Exact 1.6.25 is tested in an isolated local dependency fixture without changing
the production manifest or main lockfile:

| Command / suite | Result on exact 1.6.25 |
| --- | --- |
| `bun run verify` | Passed; 130 unit tests, CRAP maximum 6.00 |
| `bun run test:integration:local` | 286 passed, one capability skip |
| Official adapter conformance | 240/240 passed, including callback rollback |
| Dedicated callback transaction integration | 9/9 passed |
| `bun scripts/test-peer-compat.ts --transactions` | Passed, including cursor, mappings, aggregate commit and both rollback paths |

Test-utils 1.6.25's wrapper mutates the shared adapter's `transaction` to
`undefined`, accidentally selecting Better Auth's nontransactional fallback.
`177a914` adds a **test-only** proxy preserving the captured real hook against that
assignment, without replacing any other operation or the returned scoped adapter.
The official rollback test executes all assertions against the real hook. No
production code or installed dependency is patched; no adapter failure is skipped.
The sole skip is the unavailable 1.6 provider `oauthClientResource` model.

## Local commits and status

- `7679a40`: pinned Dynoxide lifecycle and CI (merged locally as `33b191e`).
- `6899b19`: cursor API, validation, unit and integration tests.
- `1ac5a7a`: isolated exact-peer runtime harness.
- `4c84954`: residual id-IN pagination regression and public export/smoke checks.
- `6b2bba9`: buffered atomic callback transactions and official rollback suite.
- `c9c8e31`: version-aware peer test fixtures, retaining all main-version coverage.
- `177a914`: test-only workaround for the 1.6.25 conformance wrapper mutation.
- The documentation commit containing this report records final public limits,
  contributor workflow, migration notes and completion status.

Status: implementation and required checks completed. No environment or model
blockers remain. Only the documented unavailable 1.6 provider capability is
skipped. All work is local; no push, publication, PR or paid resource was used,
and all workers used `openai/gpt-6.1-sol`.

## Compatibility and limits

- No entity, scalar-sidecar, unique-lock, revision or TTL storage-format change;
  no migration is needed for these additions. Existing pre-revision migration and
  opt-in compound-lock backfill requirements are unchanged.
- Better Auth's offset API is unchanged. Explicit callbacks previously executed
  sequentially under the unsupported-transaction fallback; they now have an
  aggregate atomic commit and can hit aggregate action/size limits. Bulk methods
  outside callbacks retain their prior potentially partial-success behavior.
- Core 1.6.25 drops plugin `indexes` metadata, so exact-peer compound-lock storage
  tests use explicit fixtures, not a claim that schema discovery exists there.
  Provider 1.6.25 has no `oauthClientResource`; only that capability test is skipped,
  while refresh-family cleanup still runs. Root 1.7.5 exercises the public schema
  discovery path and skips no integration cases.
- Cursors are validated, not signed/encrypted; applications must authorize every
  request independently. Native key sorting and anchored residual filtering do
  not provide arbitrary scalable sorting or a cross-page snapshot.
- No automatic callback retry, application idempotency key or rollback of external
  effects is provided. Each single SDK send retains its own request token for
  SDK retries, not cross-invocation idempotency.
- Dynoxide is local emulator coverage, not proof of live AWS service behavior,
  IAM, throttling, streams, global tables, physical TTL timing or production
  conflict behavior. No production/public DynamoDB endpoint was contacted.

## Design constraints

- Better Auth's installed `@better-auth/core/dist/db/adapter/index.d.mts`
  declares `config.transaction` as `false | (callback => Promise)`;
  `factory.mjs` delegates the public adapter's `transaction` to that callback
  implementation. Merely adding a raw-adapter method is insufficient.
- Better Auth's `findMany` returns an array and provides offset/limit rather than
  a cursor-result hook. Cursor pagination therefore needs an intentional public
  companion API rather than changing Better Auth's return shape.
- DynamoDB continuation keys do not imply snapshot isolation. Inserts before a
  continuation boundary must not shift the next page as offsets do, but records
  inserted after that boundary can still appear later. Updates, deletes and TTL
  expiration can change later pages.
- Arbitrary field sorting cannot be made into bounded, stable native DynamoDB
  pagination with the existing scalar-equality sidecar layout. Sorting just one
  fetched page would be incorrect; unsupported cursor sort shapes must fail.
- The 100-item transaction cap counts physical item actions, including sidecars,
  locks and read guards. Transactions must never be silently split. DynamoDB's
  4 MB aggregate limit and 400 KB per-item limit still apply; JSON preflight is
  approximate, and the service is the final authority.
- Callback rollback covers database writes only, not application side effects.
  Optimistic commit guards do not make paginated queries phantom-free or provide
  an arbitrary SQL-style serializable transaction.
