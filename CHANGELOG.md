# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.0] - 2026-11-06

### Tests

- Adds production-default Better Auth integration coverage for database-backed rate limiting, email verification, email OTP sign-in, and existing core authentication flows without `unsafeAllowScan`.

### Changed (storage format, backwards compatible)

- `id` no longer gets a scalar sidecar: it is the entity key and the planner always reads it with `GetItem`. Creates write one fewer transactional action.
- New sidecar and unique-lock rows no longer store plaintext copies of the value (`indexValue`, `entity.value`, and a value-bearing lock `id`); they keep owner keys and the field name. Reads never used these attributes, so existing rows remain fully readable.
- Sidecars written by earlier releases for `id` and for fields that are now non-indexed are deleted, owner-guarded, when their record is next updated, deleted, consumed, or incremented (`cleanupNonIndexedSidecars`, default `true`). Records that are never mutated keep their old sidecars until deleted; they are harmless to reads but still hold the old plaintext copies, so rewrite or clean them up if that matters.

### Fixed

- The query planner now anchors keyed reads on the most selective scalar equality instead of the first one. Better Auth core looks up OAuth accounts with `providerId` before `accountId`, so every Google/Apple sign-in previously queried the `providerId` sidecar partition, drained every account of that provider, and issued one owner `GetItem` per account (or threw once `maxPages` was reached). Unique fields are preferred, then ordinary fields, then low-cardinality fields.

### Added

- `indexedFields` (per-model sidecar allowlist), `nonIndexedFields`, and `cleanupNonIndexedSidecars` options. By default Better Auth account secrets (`password`, `accessToken`, `refreshToken`, `idToken`) are no longer sidecar-indexed: core never queries by them, and each sidecar held extra plaintext copies and cost a transactional write on every token refresh.
- `lowCardinalityFields` option, defaulting to `{ account: ["providerId"] }`, to tell the planner which fields to avoid as an anchor. Boolean and `null` equalities are always treated as low-cardinality. No storage-format change.

### Security

- Transactional writes no longer request `ReturnValuesOnConditionCheckFailure: "ALL_OLD"`. Nothing in the adapter read the returned items, but AWS attached the full stored row (for example an account's password hash or OAuth tokens) to `TransactionCanceledException.CancellationReasons[].Item`, and `DynamoDBConflictError` carried that exception as `cause`, so logging a conflict could leak secrets.
- `DynamoDBConflictError.cause` is now a redacted `{ name, message, cancellationCodes }` object instead of the raw AWS exception.

  This is an intentional error API change: callers must use the redacted fields and must not depend on AWS exception internals or stored cancellation items.

### Added

- Adds Better Auth 1.7.16 compatibility coverage.

### Changed

- Supports the Better Auth peer range `^1.6.25`; development and compatibility
  coverage use Better Auth 1.7.16.
- Updates Better Auth development/test dependencies to 1.7.16 and upgrades test
  tooling to Vitest 4.

### Compatibility

- No adapter runtime or DynamoDB storage-format changes are included, so this
  work requires no storage migration.
- Applications should upgrade Better Auth to 1.7.16 or later for security;
  updating this adapter alone does not upgrade or patch the consuming
  application's Better Auth runtime.

### Migration

- Existing sidecar and single-field/schema unique-lock rows may contain plaintext value copies in `indexValue`, `entity.value`, or a value-bearing `id`. Any record mutation rewrites the sidecars and locks it touches atomically into the redacted shape; untouched records retain legacy copies until rewritten or removed. Existing hashed keys are unchanged, so legacy-format reads and uniqueness continue to work during rolling upgrades.
- For a complete cleanup, stop writes, audit and repair duplicate ownership, then run an application-owned backfill that reads each entity by its `MODEL#/ID#` key, derives the current sidecar/lock keys, and conditionally replaces only rows whose `ownerPk` and `ownerSk` match that entity. Delete retired legacy rows only with the same owner condition; do not scan or delete by plaintext value alone. Resume writes only after the backfill and all writers use this format.
- SHA-256 keys are unkeyed. Do not index low-entropy secrets: table readers who can observe hashes can perform dictionary/equality inference.

## [1.1.0] - 2026-09-19

### Added

- Opt-in schema unique-index enforcement (`enforceSchemaUniqueIndexes`, default `false`) using Better Auth's table-level `indexes` declarations (`DBTableIndex[]`), with a versioned `UNIQUE2` compound-lock namespace. Field rules mirror Better Auth: 1–16 distinct required fields, excluding `json`, `string[]`, and `number[]` types. Existing single-field/entity/sidecar/revision keys and defaults are unchanged; no automatic migration or backfill is performed.
- The `UNIQUE2` compound-lock storage format as a new row type only: length-prefixed, delimiter-safe model/index namespaces and SHA-256 hashes of type-prefixed tuples. Explicit index names are stable namespaces; unnamed indexes derive them from the ordered, model-remapped fields. Existing records receive no retroactive locks, and renaming an index or changing its fields/order requires an application-owned duplicate audit and lock backfill.
- Bounded bulk mutation concurrency through `maxBulkConcurrency` (default `8`), with per-record revision-protected transactions, 100-action/approximate JSON-size preflight, numeric affected counts, stopped new claims after failure, and possible partial progress on failure.
- Bounded scalar `IN` access on `id` and scalar fields: empty lists are no-ops, duplicate values are removed, more than 1,000 distinct values are rejected before reads, and a shared `maxPages` budget applies across candidate queries. Case-insensitive `IN` cannot use exact-case indexes as a complete access path without an independent safe equality anchor or explicit unsafe scan; case-insensitive `IN` and `not_in` normalize array members.

### Changed

- Updated Better Auth development dependencies (`better-auth`, `@better-auth/core`, `@better-auth/test-utils`) to 1.7.5. The package still requires Better Auth `^1.6.25` as a peer dependency.
- The native-join `UnsupportedQueryError` message now points at `advanced.database.joins` (Better Auth 1.7.x) as well as `experimental.joins` (1.6.x).

### Fixed

- Stale delete/update operations now fail with a `DynamoDBConflictError` when sidecar or lock ownership no longer matches, rather than succeeding and potentially removing a replacement owner's sidecar or lock.
- An epoch-zero (`1970-01-01T00:00:00.000Z`) TTL source is now stored as `ttl: 0` and treated as logically expired instead of being dropped and leaving the row visible indefinitely.

## [1.0.1] - 2026-07-26

### Fixed

- Adds explicit npm README filename metadata for the patch release after the `1.0.0` registry metadata rendered an empty README despite the packed tarball containing `README.md`.
- Updates README status wording now that the package is publicly available on npm.

## [1.0.0] - 2026-07-26

### Added

- Provides a production-oriented Better Auth DynamoDB adapter for Better Auth `^1.6.25` through the official `createAdapterFactory` API.
- Supports the Better Auth adapter operation set with transactional entity, scalar equality sidecar, and unique-lock maintenance for single-record writes.
- Guarantees atomic uniqueness, `consumeOne`, and `incrementOne` behavior with DynamoDB transactions, conditional checks, hidden revision guards, and native numeric `ADD` where applicable.
- Uses a no-hidden-scan query-planning model: id equality and scalar equality use keyed reads, while scan-shaped operations, `OR` predicates, and case-insensitive equality require explicit `unsafeAllowScan: true`.
- Supports injected `DynamoDBDocumentClient` instances so applications own AWS region, credentials, middleware, tracing, and marshalling behavior; local development can also configure client creation through adapter options.
- Provides adapter-managed DynamoDB TTL derivation from configured Better Auth date fields, including logical expiration filtering before DynamoDB physically removes expired rows.
- Defines the 1.0 storage layout contract for entity rows, scalar equality sidecar rows, unique lock rows, delimiter-safe length-prefixed key components, hashed sidecar/lock values, and hidden revision metadata.
- Includes unit coverage, DynamoDB Local integration tests, Better Auth adapter conformance suites, coverage thresholds, and a per-production-function CRAP `<= 6` quality gate through `bun run verify`.

[Unreleased]: https://github.com/bjorntech/betterauth-dynamodb/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/bjorntech/betterauth-dynamodb/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/bjorntech/betterauth-dynamodb/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/bjorntech/betterauth-dynamodb/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/bjorntech/betterauth-dynamodb/releases/tag/v1.0.0
