import type { DynamoDBClientConfig } from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export interface BetterAuthDynamoDBOptions {
  tableName: string;
  client?: DynamoDBDocumentClient;
  region?: string;
  endpoint?: string;
  dynamoDBClientConfig?: DynamoDBClientConfig;
  ttl?: false | TtlOptions;
  unsafeAllowScan?: boolean;
  maxPages?: number;
  pageSize?: number;
  uniqueFields?: Record<string, string[]>;
  /** Opt in to Better Auth schema `indexes` unique constraints. */
  enforceSchemaUniqueIndexes?: boolean;
  /** Maximum number of independent bulk transactions in flight. */
  maxBulkConcurrency?: number;
  /**
   * Fields whose values are shared by many rows (per model). The query planner avoids
   * anchoring a keyed read on these when a more selective equality is available.
   * Merged with the built-in default `{ account: ["providerId"] }`.
   */
  lowCardinalityFields?: Record<string, string[]>;
  /**
   * Per-model allowlist of fields that get equality sidecar rows (storage model/field names).
   * Models not listed keep the default of indexing every scalar field. Equality queries on a
   * field that is not indexed need another indexed anchor or `unsafeAllowScan`.
   */
  indexedFields?: Record<string, string[]>;
  /**
   * Fields that never get equality sidecar rows. Merged with the built-in default
   * `{ account: ["password", "accessToken", "refreshToken", "idToken"] }`; `id` is never
   * sidecar-indexed because it is the entity key.
   */
  nonIndexedFields?: Record<string, string[]>;
  /**
   * Delete sidecar rows that older versions wrote for fields that are no longer indexed, as
   * part of each update/delete/consume/increment of the owning record. Defaults to `true`.
   * Set `false` on new tables, or once existing rows have been rewritten or cleaned up.
   */
  cleanupNonIndexedSidecars?: boolean;
}

/** Store options: public adapter options plus schema metadata resolved and validated by the adapter factory. */
export interface DynamoDBStoreOptions extends BetterAuthDynamoDBOptions {
  schemaUniqueIndexes?: SchemaUniqueIndex[];
}

export interface SchemaUniqueIndex {
  model: string;
  name: string;
  fields: string[];
}

export interface TtlOptions {
  attributeName?: string;
  fields?: Record<string, string>;
  defaultField?: string;
}

export interface StoredItem extends Record<string, unknown> {
  pk: string;
  sk: string;
  model: string;
  id: string;
  entity: Record<string, unknown>;
  __betterAuthDynamoDBRevision: string;
  ttl?: number;
  createdAtSort?: string;
}

export interface SidecarItem extends Record<string, unknown> {
  pk: string;
  sk: string;
  model: string;
  id: string;
  entity: Record<string, unknown>;
  ownerPk: string;
  ownerSk: string;
  indexModel?: string;
  indexField?: string;
  ttl?: number;
}

export interface CleanedWhere {
  field: string;
  value: string | number | boolean | string[] | number[] | Date | null;
  operator: "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "in" | "not_in" | "contains" | "starts_with" | "ends_with";
  connector?: "AND" | "OR";
  mode: "sensitive" | "insensitive";
}

export interface QueryPlan {
  kind: "byId" | "byIdValues" | "byFieldValue" | "byFieldValues" | "byModel";
  where: CleanedWhere[];
  /** The equality clause chosen to anchor a byFieldValue sidecar query. */
  clause?: CleanedWhere;
}

export interface PlannerHints {
  uniqueFields?: readonly string[];
  lowCardinalityFields?: readonly string[];
  /** When set, only these fields have sidecars. */
  indexedFields?: readonly string[];
  nonIndexedFields?: readonly string[];
}
