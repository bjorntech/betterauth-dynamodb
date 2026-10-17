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
  indexValue?: unknown;
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
}

/** Uses exact storage model/field names, not Better Auth's logical-name mapping. */
export interface DynamoDBPageRequest {
  model: string;
  where: CleanedWhere[];
  /** Maximum evaluated keys, not matching records. Empty pages may have a cursor. */
  limit: number;
  cursor?: string;
  /** Native encoded DynamoDB sort-key order, NOT lexical/numeric entity id order. */
  sortBy?: { field: "key"; direction: "asc" | "desc" };
  select?: string[];
}

export interface DynamoDBPage<T> {
  items: T[];
  /** Opaque continuation, not an authorization token or a snapshot. Null means exhausted. */
  nextCursor: string | null;
}

export interface DynamoDBPaginator {
  findPage<T = Record<string, unknown>>(request: DynamoDBPageRequest): Promise<DynamoDBPage<T>>;
}
