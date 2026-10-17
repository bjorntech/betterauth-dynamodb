# Contributor instructions

## Project purpose

`betterauth-dynamodb` is a Better Auth adapter backed by Amazon DynamoDB. It aims to be safe for production-style serverless use while staying honest about DynamoDB limitations: single-record correctness is prioritized, unsupported query shapes fail loudly, and callers can inject their own AWS SDK clients.

Treat this repository as a future public open-source package. Do not rely on sibling repositories or local-only state unless the user explicitly asks for it.

## Architecture map

- `src/index.ts` exposes `dynamoDBAdapter()` through Better Auth's `createAdapterFactory` API and collects Better Auth schema unique fields.
- `src/dynamodb-adapter.ts` contains `DynamoDBStore`, the adapter operation implementation, and the DynamoDB command construction.
- `src/client.ts` normalizes adapter options and creates or reuses a `DynamoDBDocumentClient`.
- `src/serialize.ts` maps Better Auth records to DynamoDB entity rows, TTL attributes, scalar equality sidecar rows, and unique lock rows.
- `src/where.ts` plans safe access patterns and evaluates Better Auth where clauses in memory after the keyed DynamoDB read.
- `src/expressions.ts` builds conditional and update expressions.
- `src/keys.ts` owns stable key-prefix formatting.
- `src/errors.ts` centralizes adapter errors and AWS error detection.
- `src/types.ts` contains public and internal TypeScript types; keep it pure-type where possible.
- `test/` contains unit tests for command construction, semantics, factory wiring, query planning, and expression behavior.
- `scripts/crap-check.ts` enforces per-production-function CRAP <= 6 from coverage output.

## Invariants

- **Atomic correctness matters.** Preserve conditional writes/deletes/updates for create uniqueness, `consumeOne`, and `incrementOne`. Do not weaken race handling for verification tokens, rate limits, or unique records.
- **Callback commits are aggregate-atomic.** Scoped callback operations must buffer writes until one validated DynamoDB transaction commits. Never split an oversized callback into partial commits or claim snapshot/predicate isolation. Preserve original revision/absent-id guards, sidecar/lock maintenance, read-your-writes and closed-scope rejection.
- **Cursor pages use continuation keys, not offsets.** Preserve one keyed Query page per companion call, query-bound cursor validation and native encoded-key ordering. Empty filtered pages may still have a continuation; never silently sort individual pages by an unindexed entity field or add a hidden scan.
- **No hidden scans.** Queries that cannot use id equality or scalar field equality must throw unless `unsafeAllowScan: true` is explicitly configured. Do not add fallback scans, paginated table walks, or count/update/delete-many scans behind a friendly API.
- **Injected client compatibility.** Keep `client?: DynamoDBDocumentClient` as the preferred production path so deploying applications own AWS region, credentials, middleware, tracing, and marshalling options.
- **Stable key/index contract.** Changes to entity `pk`/`sk`, scalar sidecar keys, unique lock keys, hidden revision metadata, TTL defaults, or native index requirements are storage-format changes and require migration notes plus compatibility consideration.
- **Better Auth compatibility.** Use the official adapter factory API. Avoid assumptions about private Better Auth internals unless covered by tests and documented as version-specific.
- **No sibling-repo coupling.** Examples must stay standalone and generic, and package code must not import or depend on local sibling repositories.
- **No secrets.** Never commit credentials, real table names from private infrastructure, `.env` files, AWS account IDs, tokens, or copied production data.

## Coding conventions

- TypeScript ESM only; keep public exports intentional through `src/index.ts`.
- Prefer small, named helpers over large functions. The CRAP gate is intentionally strict.
- Keep DynamoDB command construction explicit and testable.
- Preserve `removeUndefinedValues: true` when this package creates a document client.
- Keep error messages actionable and honest about when a scan or transaction shape is unsupported.
- Avoid adding runtime dependencies unless they materially improve adapter correctness or user ergonomics.
- Do not modify sibling repositories. Do not modify `packages/opencode` unless the task explicitly says V1/opencode work.

## Test, coverage, and quality workflow

Run commands from this repository root only:

```sh
bun install
bun run typecheck
bun run lint
bun run test
bun run test:coverage
bun run test:integration:local
bun run quality:crap
bun run build
bun run verify
```

`bun run verify` is the required final check for code changes. It runs typecheck, lint, coverage tests, CRAP, and build.

`bun run test:integration:local` is required when changes affect DynamoDB storage layout, sidecar/unique-lock maintenance, transaction semantics, logical TTL handling, pagination, query planning, or client creation/injection. It launches the pinned local Dynoxide development dependency in memory on loopback with isolated processes/tables and fake credentials; install optional platform dependencies with `bun install --frozen-lockfile`. Docker and Java are not required. Keep it separate from `bun run verify` so unit coverage and CRAP remain fast and deterministic. Emulator coverage is not proof of live AWS IAM, throttling, physical TTL deletion timing or production conflict behavior.

Coverage is enforced for production `src` code by `vitest.config.ts`. `src/types.ts` is excluded because it is type-only. Do not lower thresholds or exclude production implementation files to make a change pass.

Every production function must have CRAP <= 6. Add focused tests or simplify code when the gate fails.

## Documentation expectations

- Update `README.md` when changing public options, storage layout, concurrency semantics, table provisioning requirements, test policy, or limitations.
- Update `CONTRIBUTING.md` when contributor workflow or quality gates change.
- Document migration/compatibility implications for any storage-format or API change.
- Keep installation and publication wording honest until the package is actually published.

## Public-repo hygiene

- Do not invent repository URLs, package availability, maintainers, security contacts, or governance.
- Keep examples generic and redact any private infrastructure identifiers.
- Package metadata should not point to nonexistent URLs.
- If adding public project files such as `LICENSE` or `SECURITY.md`, make sure the contents reflect an actual project decision rather than a guess.

## Backward compatibility

Before changing public options, export names, key formats, default index names, TTL defaults, or Better Auth adapter semantics, decide whether the change is backward compatible. If not, document the migration path and consider a major version bump once publishing begins.

## Definition of done

- The change is scoped to this repository and does not depend on sibling repos.
- Public behavior is covered by tests where feasible.
- `bun run verify` passes, including coverage and CRAP <= 6 for every production function.
- `bun run test:integration:local` passes for storage/transaction/pagination/TTL/client behavior changes, or an exact Dynoxide/environment blocker is reported.
- README/contributor docs are updated for public-facing behavior changes.
- No secrets, local-only paths, generated build output, or coverage artifacts are newly committed.
