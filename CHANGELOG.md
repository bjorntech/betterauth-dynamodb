# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Cursor-based pagination with validated, query-bound continuation tokens and native DynamoDB key ordering; existing Better Auth offset-based `findMany` behavior remains available.
- Multi-record callback transactions through Better Auth's adapter transaction hook, with buffered writes committed atomically in one DynamoDB transaction.
- Local Dynoxide-backed integration coverage for pagination, transaction rollback and Better Auth's official adapter test suites.

### Compatibility

- Entity, sidecar, unique-lock and revision storage formats remain unchanged. DynamoDB's 100-action and 4 MB transaction limits apply to physical entity/index/lock actions, not just logical Better Auth records. See README for cursor ordering and callback transaction isolation limits.

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

[1.1.0]: https://github.com/bjorntech/betterauth-dynamodb/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/bjorntech/betterauth-dynamodb/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/bjorntech/betterauth-dynamodb/releases/tag/v1.0.0
