# @bjorntech/betterauth-dynamodb

Production-oriented DynamoDB adapter supporting Better Auth `^1.6.25` via the official `createAdapterFactory` API.

## Status

This package is published on npm as `@bjorntech/betterauth-dynamodb`. The repository has unit coverage for command construction, adapter semantics, query planning, and Better Auth factory wiring, plus explicit Docker-backed DynamoDB Local integration suites (including a separate Better Auth adapter conformance test file).

Storage compatibility note: the current storage format uses transactionally maintained scalar equality sidecar rows in the base table, delimiter-safe length-prefixed key components, SHA-256 hashes for sidecar/unique-lock values, and hidden internal revision metadata for ABA-safe mutations. Experimental tables using older generic `gsi1`/`idx_<field>_*`, pre-length-prefixed, pre-hash, or pre-revision formats should be recreated or migrated before using this version; pre-revision rows can still be read but fail clearly if mutated.

Upgrade note: 1.0.1 to 1.1.0 requires no migration when `enforceSchemaUniqueIndexes` remains at its default `false`, and `IN` support requires no migration. For existing records, opting into new schema unique constraints requires a stopped-write audit, duplicate repair, and application-owned lock backfill before all compatible writers restart with enforcement enabled. New empty affected models need no backfill. No migration utility is supplied.

**Use Better Auth 1.7.16 or newer for security fixes.** The adapter retains compatibility with older versions starting at 1.6.25 (`^1.6.25`). Consuming applications must upgrade their Better Auth runtime; updating the adapter alone does not patch it.

## Installation

Install the adapter and its Better Auth peer dependency with your package manager:

```sh
npm install @bjorntech/betterauth-dynamodb better-auth
bun add @bjorntech/betterauth-dynamodb better-auth
pnpm add @bjorntech/betterauth-dynamodb better-auth
```

AWS SDK DynamoDB packages are runtime dependencies of this adapter.

## Basic usage

Prefer injecting a `DynamoDBDocumentClient` so your application owns AWS configuration, credentials, middleware, tracing, and marshalling behavior:

```ts
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { betterAuth } from "better-auth";
import { dynamoDBAdapter } from "@bjorntech/betterauth-dynamodb";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true }
});

export const auth = betterAuth({
  database: dynamoDBAdapter({
    tableName: "better-auth",
    client: dynamo,
    ttl: { fields: { session: "expiresAt", verification: "expiresAt" } }
  }),
  verification: { disableCleanup: true },
  emailAndPassword: { enabled: true }
});
```

When the `verification` model uses adapter-managed TTL, disable Better Auth's verification cleanup as shown above. Otherwise Better Auth can issue a range-only `deleteMany` such as `expiresAt < now`, which this adapter rejects by default because it would require a hidden table/model scan.

For local development you may pass `region`, `endpoint`, and/or `dynamoDBClientConfig` instead of `client`. Production deployments should usually inject the client.

See [examples](./examples/) for standalone deployment examples that use local path dependencies.

## API

```ts
import { dynamoDBAdapter } from "@bjorntech/betterauth-dynamodb";
```

`dynamoDBAdapter(options)` accepts:

- `tableName: string` - required DynamoDB table name.
- `client?: DynamoDBDocumentClient` - preferred production integration path.
- `region?: string`, `endpoint?: string`, `dynamoDBClientConfig?: DynamoDBClientConfig` - used only when this package creates the AWS client.
- `ttl?: false | { attributeName?: string; fields?: Record<string, string>; defaultField?: string }` - derives a DynamoDB TTL epoch-seconds attribute from Better Auth date fields. When omitted or `false`, logical TTL filtering is inactive and a user/plugin field named `ttl` remains ordinary visible data.
- `unsafeAllowScan?: boolean` - defaults to `false`; must be explicitly enabled for scan-shaped query/update/delete/count operations.
- `maxPages?: number` - positive safe integer maximum DynamoDB Query/Scan pages drained for sidecar equality lookups and explicit unsafe scans; defaults to `25`. If DynamoDB still has more pages at this cap, the adapter throws rather than returning incomplete filtered/windowed results.
- `pageSize?: number` - optional positive safe integer DynamoDB `Limit` for each Query/Scan request. Pagination is still fully drained up to `maxPages`, so this controls request sizing and does not change the final logical result. It is mainly useful for testing pagination and tightly bounded local workloads; leave unset in normal production use unless you have measured the throughput/latency trade-off.
- `uniqueFields?: Record<string, string[]>` - optional manual unique-field configuration merged with Better Auth schema unique fields. Keys and fields must use the exact DynamoDB/storage names the adapter receives after Better Auth `modelName`/`fieldName` mapping (for example `{ app_user: ["email_address"] }`, not `{ user: ["email"] }`, when those mappings are configured). Each listed field is an independent single-field unique constraint; composite uniqueness is not supported by this option.
- `enforceSchemaUniqueIndexes?: boolean` - opt-in enforcement of unique Better Auth schema `indexes`; defaults to `false`. Unique index fields follow Better Auth's own rules: 1–16 distinct required fields, excluding `json`, `string[]`, and `number[]` types (enum-literal string types are allowed). Existing rows are not backfilled automatically and pre-existing records receive no retroactive locks; activate only after an application-owned duplicate audit and compatible lock backfill.
- `lowCardinalityFields?: Record<string, string[]>` - fields shared by many rows (per storage model name), merged with the built-in default `{ account: ["providerId"] }` (remapped through Better Auth `modelName`/`fieldName`). When a `where` has several scalar equalities, the planner anchors the sidecar query on the most selective one: configured unique fields first, then ordinary fields, then low-cardinality fields (these, plus any boolean or `null` equality). Ties keep `where` order. Add fields such as a plugin's `role` or `status` here when they appear beside a more selective equality.
- `indexedFields?: Record<string, string[]>` - per-model allowlist (storage model/field names) of fields that get equality sidecar rows. Models not listed keep indexing every scalar field. An equality or `IN` on a field outside the allowlist cannot anchor a keyed read: it needs another indexed anchor in the same `where`, or `unsafeAllowScan`. Every sidecar costs one extra transactional write per create/delete and, when its value changes, per update, so an allowlist is the main write-cost lever. Better Auth core only queries by the fields below; add the fields your plugins query by:

  ```ts
  indexedFields: {
    user: ["email"],
    session: ["token", "userId"],
    account: ["userId", "providerId", "accountId"],
    verification: ["identifier"],
    rateLimit: ["key"]
  }
  ```

- `nonIndexedFields?: Record<string, string[]>` - fields that never get sidecar rows, merged with the built-in default `{ account: ["password", "accessToken", "refreshToken", "idToken"] }` (remapped through Better Auth `modelName`/`fieldName`). `id` never gets a sidecar because it is the entity key.
- `cleanupNonIndexedSidecars?: boolean` - defaults to `true`. Each update, delete, `consumeOne`, and `incrementOne` also deletes (owner-guarded, no-op if absent) the sidecars an earlier configuration or release wrote for fields that are no longer indexed. Set `false` on new tables, or once every existing record has been rewritten, to avoid those extra write actions. Retained legacy sidecars and locks are also atomically rewritten without plaintext value copies when their owner record is mutated.
- `listableModels?: string[]` - opt in small models whose global `findMany`/`count` access must not scan the table. Each listed model gets one membership row per entity in a `LIST#…` partition, and listing queries that partition followed by strongly consistent owner reads. Membership rows are maintained atomically with create, update, increment, consume, and delete operations and carry the configured TTL. This is intended for small global collections such as Better Auth JWT `jwks` and OAuth-provider `oauthResource`, not users, sessions, or rate limits. Use storage model names (for example `listableModels: ["jwks", "oauthResource"]`).
- `maxBulkConcurrency?: number` - positive safe integer concurrency cap for independent `updateMany`/`deleteMany` transactions; defaults to `8`. A failure can follow successful mutations, so bulk operations are not aggregate-atomic and must not be blindly retried.

The schema-index option consumes Better Auth's actual table-level `indexes` array (`DBTableIndex[]`) and only acts on entries with `unique: true`; it does not add an alternative schema-definition option. On a new empty table it can be enabled directly. For a populated table, use a maintenance window with writes stopped: audit duplicates, repair them, and complete an application-owned lock backfill before restarting all writers with compatible code and enforcement enabled. This package provides no migration or backfill utility; do not enable it on unbackfilled rows or allow old/incompatible writers to continue. The `UNIQUE2` namespace is stable only while the index name (explicit or derived), ordered field list, and model/field mapping remain unchanged; changing any of those requires backfilling the new namespace, and pre-existing records do not acquire locks automatically. Rollback requires an explicit plan for versioned locks and writers that may have observed the constraint; disabling the option alone does not undo backfill or repair duplicates.

For an existing table, enabling `listableModels` does not discover or backfill existing entities: rows written before the option have no membership row and therefore are absent from listable queries. Keep writes stopped for the affected model, read its `MODEL#/ID#` entity rows with an application-owned maintenance job, and transactionally create owner-checked membership rows before enabling the option for all writers. A new empty model needs no migration. Until this backfill is complete, Better Auth's JWT plugin may find no existing key and create a replacement key; plan the maintenance window accordingly. Membership partitions are intentionally small and single-partition; do not use this option for high-volume models.

The package also exports `BetterAuthDynamoDBOptions`, `TtlOptions`, `DynamoDBAdapterError`, and `UnsupportedQueryError`.

## Deployment notes

Keep table ownership in your application infrastructure and inject a `DynamoDBDocumentClient` into the adapter. Provision a DynamoDB table with `pk` as the partition key, `sk` as the sort key, and DynamoDB TTL enabled on the adapter TTL attribute when you configure adapter-managed TTL. No GSIs are required for the current sidecar-index design.

For email OTP sign-in or other flows where verification rows expire through DynamoDB TTL, keep `verification.disableCleanup: true` in the Better Auth config. Without it, Better Auth attempts to clean verification rows with a range-only `deleteMany(expiresAt < now)`, and the adapter rejects that no-key access pattern under its no-hidden-scan policy.

Better Auth database-backed rate limiting has the same DynamoDB trade-off. The rate-limit `key` field is schema-unique and works well for exact-key increments, but Better Auth cleanup can require range-only predicates such as old `lastRequest` values. Leave `unsafeAllowScan` disabled for production unless you have a tightly bounded table and have accepted the cost/consistency profile. Prefer Better Auth's non-database/in-memory limiter for single-instance local development, an edge/API-gateway/WAF limiter, or an application-owned DynamoDB rate-limit table with access patterns designed for your cleanup needs.

If a needed access pattern has no id or scalar equality predicate, the adapter throws unless `unsafeAllowScan: true` is set. `OR` predicates and `mode: "insensitive"` equality also cannot use keyed access safely: `OR` can match rows outside one narrowed key branch, and DynamoDB entity/sidecar keys are case-sensitive. Those shapes require `unsafeAllowScan: true` so the adapter can explicitly scan the bounded model partition and evaluate the full expression in memory. A future optional native-GSI optimization may be added with descriptive API names, but there is no generic GSI option today.

## Scaling limits

Entity rows for a model share one DynamoDB partition key (`MODEL#…`). Every entity write targets that partition, and a scalar-sidecar lookup is followed by an owner `GetItem` against it. Scalar sidecars and unique locks use separate hashed partitions, so they do not all share the model partition's load. DynamoDB documents a per-partition design limit of approximately 1,000 write capacity units and 3,000 read capacity units; [adaptive capacity and split-for-heat](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-partition-key-design.html) can help, but are not guarantees.

The adapter does not require a local secondary index (LSI), so the 10 GB item-collection limit for a partition key with an LSI does not apply. Do not add an LSI on `pk` unless your own table design requires it; see [the DynamoDB LSI documentation](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/LSI.html).

Entity rows store the Better Auth record both at the top level and under `entity`, which roughly doubles that portion of item size and capacity consumption. Sidecars and unique locks store owner references only. A create, update, or delete also writes the entity and one or more transactional actions for each indexed scalar sidecar and unique lock (updates that replace an index can require both removal and creation actions). The total transaction is bounded by DynamoDB's transaction limits and by the adapter's preflight checks; reducing `indexedFields` is the main write-cost lever.

This matters when a single model sustains unusually high traffic—potentially hundreds to thousands of entity operations per second, most plausibly for sessions or rate limits. Monitor table and partition throttling, including CloudWatch's [`ThrottledRequests`](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/metrics-dimensions.html#ThrottledRequests) and, when diagnosing hot keys, [CloudWatch Contributor Insights for DynamoDB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/contributorinsights_HowItWorks.html). Also monitor consumed capacity and item sizes. Mitigations include a dedicated rate-limit store, and—where your Better Auth deployment supports it—moving session state to secondary storage rather than this table. A different per-entity partition or GSI layout would change the storage format and requires a versioned migration; do not assume it is a drop-in configuration change.

## Table and key model

- Table primary key: `pk = MODEL#s<byteLength>:<model>`, `sk = ID#s<byteLength>:<id>`. Model, field, and id components use deterministic length prefixes so embedded delimiters such as `#` cannot collide across entity, sidecar, or unique-lock rows.
- The Better Auth-visible record is stored in `entity` and scalar fields are duplicated at top level for conditional checks and scan-opt-in filtering.
- Before writes, `undefined` values are removed from plain object records and arrays because DynamoDB has no undefined value type. Array entries containing `undefined` are omitted, which compacts arrays. Non-plain values such as `Date`, binary values, sets, and class instances are preserved unchanged; if a preserved custom instance is not marshalable by your injected AWS SDK client, normalize it to a plain supported value before passing it to Better Auth.
- Scalar equality sidecars are stored in the same table for each indexed field (see `indexedFields` / `nonIndexedFields`; `id` is never sidecar-indexed): `pk = INDEX#s<byteLength>:<model>#FIELD#s<byteLength>:<field>#VALUE#<sha256(typed-value)>`, `sk = OWNER#s<byteLength>:<id>`. The typed value encoding (before hashing) preserves distinctions such as string `"1"`, number `1`, boolean `true`, dates, and `null`, and supports arbitrary Better Auth/plugin scalar fields without one GSI per field. Owner rows are always re-read and checked against the original typed predicate, so the hash is only a bounded DynamoDB key component. Sidecar and unique-lock rows store only owner keys and the field name, never a plaintext copy of the value. SHA-256 is unkeyed; indexing low-entropy secrets permits dictionary/equality inference by table readers.
- Listable membership rows use `pk = LIST#s<byteLength>:<model>` and `sk = MEMBER#s<byteLength>:<id>`, store only the owner key, and are queried before owner reads. They receive the same TTL as their entity and are deleted or rewritten in the same transaction.
- Unique fields declared by Better Auth schema, or by `uniqueFields`, create transactional lock rows: `pk = UNIQUE#s<byteLength>:<model>#s<byteLength>:<field>`, `sk = VALUE#<sha256(typed-value)>#s0:`.
- When `enforceSchemaUniqueIndexes` is enabled, each unique Better Auth schema index adds a `UNIQUE2` compound lock row (a storage-format addition; existing entity, scalar-sidecar, and single-field unique-lock rows are unchanged): `pk = UNIQUE2#s<byteLength>:<model>#s<byteLength>:<index-namespace>`, `sk = TUPLE#<sha256(type-prefixed tuple)>`. Components use delimiter-safe length prefixes, and tuple values are type-prefixed before hashing. An explicit index `name` is the namespace. Without one, the namespace is the ordered, model-remapped field list encoded as `s<UTF-8 byte length>:<field>` components joined by `#`, then length-prefixed again by `compoundUniquePk`; declared field order is preserved. For example, fields `email`, `tenantId` and values `"alice@example.com"`, `"acme"` produce `pk = UNIQUE2#s4:user#s20:s5:email#s8:tenantId` and `sk = TUPLE#7a2e1d8fc9815968b003de5dfc1ce4e013de254c811f4566bfaef8dc444963fa`. A `null` or `undefined` tuple component skips the lock; an empty string is a real value. Renaming an index or changing its field list or order changes its namespace, so existing locks must be re-backfilled; pre-existing records receive no retroactive locks.
- Do not bypass this adapter with direct DynamoDB writes for Better Auth records. Entity rows, scalar sidecars, unique locks, TTL attributes, and hidden revision metadata must be created, replaced, and deleted together; out-of-band writes can break uniqueness, query results, logical expiration, or optimistic mutation guards.
- Older releases stored plaintext copies in sidecar/lock attributes (`indexValue`, `entity.value`, or a value-bearing lock `id`). Reads and uniqueness remain compatible because the hashed key format is unchanged. Mutations rewrite touched rows atomically, but untouched records retain those copies. For a full cleanup, stop writes and run an application-owned, owner-checked backfill: read each entity by its `MODEL#/ID#` key, derive its current rows, and conditionally replace/delete only rows whose `ownerPk` and `ownerSk` match. Never delete by plaintext value alone; resume writes only after all writers are upgraded and the backfill is complete.
- Entity rows include a reserved top-level `__betterAuthDynamoDBRevision` UUID. It is generated on create and refreshed on each replacement/update/increment, used only for optimistic write guards, and never returned as Better Auth-visible metadata.
- DynamoDB partition keys are validated against the 2048-byte UTF-8 limit and sort keys against the 1024-byte UTF-8 limit. Long scalar field values are hashed in sidecar and unique-lock keys to avoid partition/sort key overflow; long model, field, or id components fail with an actionable error.
- TTL is derived from configured date fields into a DynamoDB TTL attribute (default `ttl`) and is not added to the Better Auth-visible `entity`. Entity, scalar sidecar, and unique-lock rows receive compatible TTL metadata when available. Reads treat configured TTL as logical expiration: an owner row at or before the current epoch second is hidden for id, sidecar, and explicit scan paths even if DynamoDB has not physically deleted it. Sidecars/locks may therefore expire with their owner; stale sidecars still cannot be returned because the owner entity must exist, be unexpired, and match the requested typed value. When `ttl` is omitted or `false`, this logical expiration path is completely disabled; use `attributeName` if you configure TTL and also need a user/plugin field named `ttl` at top level.
- Expired compound locks are logically ignored for reads, but reuse can still wait for DynamoDB's physical TTL deletion. Do not treat logical expiration as immediate physical lock removal.

## Concurrency guarantees and limitations

- `create` transactionally writes the entity row, scalar equality sidecars, and configured uniqueness locks with conditional non-existence checks.
- `update`, `updateMany`, `delete`, and `deleteMany` transactionally maintain sidecars and uniqueness locks. After the adapter reads and matches a target, the write uses an optimistic condition on the hidden per-entity revision rather than trying to translate arbitrary Better Auth operators into DynamoDB transaction conditions. This rejects stale ABA-shaped writes even if record contents changed away and back between read and mutation.
- `consumeOne` transactionally deletes the matched entity, sidecars, and uniqueness locks with the same revision guard. Exactly one concurrent caller can consume a row; normal stale/lost consume races resolve to `null` as Better Auth expects, while non-conditional AWS failures still throw.
- `incrementOne` uses a DynamoDB transactional `Update` with native numeric `ADD` for numeric/missing counter attributes plus the same revision guard, while maintaining scalar sidecars and uniqueness locks in the same `TransactWriteItems` request. Signed and zero finite deltas are supported; existing non-number counter values follow Better Auth's fallback semantics and are treated as zero with a guarded `SET` instead of invalid DynamoDB `ADD`. The returned row is the updated Better Auth-visible entity computed from the guarded snapshot; if the target guard no longer matches, the operation returns `null`. Unique-lock conflicts or non-conditional AWS failures still throw.
- Transactional writes include a fresh AWS `ClientRequestToken` per command construction. This gives AWS SDK/internal network retries of that single send a stable token, but it is not cross-invocation or application-level idempotency.
- DynamoDB `TransactWriteItems` is limited to 100 actions. The adapter de-duplicates configured unique-field lists, validates that a transaction contains at most one action per item key, rejects serialized transaction requests over approximately 4 MB, and fails early with an actionable error if entity + sidecars + unique locks for a mutation would exceed either limit.
- Better Auth callback transactions are unsupported because DynamoDB has no interactive transaction API; the adapter reports `transaction: false`. DynamoDB `TransactWriteItems` is single-shot and is used internally for single-record atomic operations.
- Queries without `id` equality or scalar equality require `unsafeAllowScan: true`; this avoids accidental full-table/model draining. Queries containing `OR` predicates, or equality clauses with `mode: "insensitive"` and no other safe keyed equality, also require explicit unsafe scans. `updateMany`, `deleteMany`, and `count` obey the same guard.
- Base entity gets, sidecar queries, owner gets, and explicit unsafe scans request `ConsistentRead: true`. Strongly consistent reads cost more RCUs than eventually consistent reads. DynamoDB still does not provide a whole-operation snapshot for a paginated scan, so explicit unsafe scans can observe changes between pages.
- Scalar equality queries anchor on the most selective equality clause (see `lowCardinalityFields`), use paginated base-table `Query` calls on that sidecar partition, then retrieve owner entity rows and apply residual `where`, sorting, offset, limit, and count in memory. Explicit unsafe scans are also paginated before in-memory filtering/windowing. Keep high-cardinality equality partitions and scan-enabled workloads bounded, and tune `maxPages` for your data shape; if the page cap is reached before `LastEvaluatedKey` clears, the adapter throws instead of returning a partial result. `pageSize` can force smaller Query/Scan pages when you intentionally want more, smaller requests.
- Scalar `IN` predicates on `id` or a scalar field use one keyed lookup per distinct candidate value, issued sequentially so the shared page budget stays deterministic; a 1,000-value `IN` therefore costs roughly 1,000 sequential DynamoDB round-trips before owner reads. Keep `IN` lists small in latency-sensitive paths. Empty lists are no-ops; duplicate values are removed; more than 1,000 distinct values are rejected before reads. Sidecar queries share one global `maxPages` budget, owner reads are bounded by `maxBulkConcurrency`, and residual filters run before global sorting, offset, and limit windowing. Case-insensitive `IN` cannot use exact-case indexes as a complete access path: it requires an independent safe equality anchor or explicit `unsafeAllowScan: true`; with an anchor it is evaluated as a residual predicate. Case-insensitive `IN`/`not_in` comparisons normalize array members.
- `updateMany` and `deleteMany` use bounded concurrency (controlled by `maxBulkConcurrency`, default `8`) and one revision-protected transaction per matched record. On failure they stop claiming new records and wait for started workers; earlier commits are not rolled back. They return numeric affected counts and are not aggregate-atomic or safe for blind retries. Each transaction has a 100-action and approximate JSON/practical byte-size preflight; AWS remains the ultimate size authority.
- Joins use Better Auth's fallback behavior by default: Better Auth performs separate `findOne`/`findMany` calls, which remain subject to this adapter's no-hidden-scan policy. Better Auth's native-join path (`advanced.database.joins` on 1.7.x, `experimental.joins` on 1.6.x) is not supported because DynamoDB cannot honestly join arbitrary Better Auth models without explicit access-pattern design; if enabled and Better Auth passes a native join to the adapter, the adapter throws `UnsupportedQueryError` with instructions to disable the option.
- The local integration suite uses AWS's official `amazon/dynamodb-local:2.6.1` image through Testcontainers. It proves command behavior against a real DynamoDB API surface for table keys, conditional transactions, sidecar/unique-lock persistence, logical TTL filtering, pagination tokens, and injected clients. The separate `test/integration/betterauth-conformance.test.ts` also runs Better Auth's adapter conformance suites and enables `unsafeAllowScan` because the canonical suites intentionally exercise scan-shaped predicates; production defaults still reject those shapes unless explicitly opted in. These tests do not prove IAM, global tables, streams, PITR/backups, encryption, adaptive capacity, throttling behavior, CloudWatch metrics, real service TTL deletion timing, or every production transaction-conflict edge; validate those in AWS for production-critical rollouts.

## Verification, coverage, and CRAP policy

```sh
bun run verify
bun run test:integration:local
```

`bun run verify` runs typecheck, ESLint, coverage tests, and build. The package is tested against Better Auth 1.7.16 and supports Better Auth `^1.6.25` as a peer dependency. `bun run test:integration:local` starts DynamoDB Local in Docker using a random mapped port, fake credentials, in-memory shared DB mode, telemetry disabled, and isolated tables for the local integration and separate adapter conformance suites.

Provider coverage uses the published `@better-auth/oauth-provider` 1.7.16 plugin schema and direct query-shape tests, plus ordinary Better Auth HTTP authentication flows. It does not include the provider's full OAuth endpoint surface.

Coverage thresholds are enforced for production `src` code (excluding pure types). CRAP is computed per production function as:

```txt
CRAP = complexity^2 * (1 - lineCoverage)^3 + complexity
```

The verification command fails if any implementation function has CRAP `> 6`. Do not lower coverage thresholds or exclude production implementation files to bypass this gate.

## Scripts

- `bun run typecheck`
- `bun run lint`
- `bun run test`
- `bun run test:coverage`
- `bun run test:integration:local`
- `bun run quality:crap`
- `bun run build`
- `bun run smoke:dist-import`
- `bun run verify`
- `bun run verify:integration`

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Contributions should preserve atomic correctness, avoid hidden scans, maintain injected-client compatibility, and keep the CRAP <= 6 gate passing.

## License

MIT © 2026 BjornTech AB. See [LICENSE](./LICENSE).
