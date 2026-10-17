import { createHash } from "node:crypto";
import { QueryCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoDBAdapterError, UnsupportedQueryError } from "./errors.js";
import { entitySk, indexPk, modelPk } from "./keys.js";
import { fromStoredItem } from "./serialize.js";
import type { BetterAuthDynamoDBOptions, DynamoDBPage, DynamoDBPageRequest, SidecarItem, StoredItem } from "./types.js";
import { eqWhere, firstEquality, matchesWhere, planQuery } from "./where.js";

type Key = { pk: string; sk: string };
type Access = { pk: string; sk?: string; prefix: string };
type OwnerLoader = (items: SidecarItem[], clause: NonNullable<ReturnType<typeof firstEquality>>) => Promise<StoredItem[]>;

/** One native Query page only: never drains pages to fill residual-filter gaps. */
export async function findPage<T>(client: DynamoDBDocumentClient, options: BetterAuthDynamoDBOptions, request: DynamoDBPageRequest, loadOwners: OwnerLoader): Promise<DynamoDBPage<T>> {
  validateRequest(request);
  const access = pageAccess(request);
  const query = fingerprint(options, request);
  const key = decodeCursor(request.cursor, query, access);
  const result = await client.send(new QueryCommand({
    TableName: options.tableName,
    KeyConditionExpression: access.sk ? "#pk = :pk AND #sk = :sk" : "#pk = :pk",
    ExpressionAttributeNames: access.sk ? { "#pk": "pk", "#sk": "sk" } : { "#pk": "pk" },
    ExpressionAttributeValues: access.sk ? { ":pk": access.pk, ":sk": access.sk } : { ":pk": access.pk },
    ConsistentRead: true, Limit: request.limit, ScanIndexForward: request.sortBy?.direction !== "desc", ExclusiveStartKey: key
  }));
  const rows = await pageRows(result.Items ?? [], request, loadOwners);
  const items = visiblePage<T>(rows, options, request);
  return { items, nextCursor: encodeCursor(result.LastEvaluatedKey, query, access) };
}

function validateRequest(request: DynamoDBPageRequest): void {
  if (!Number.isSafeInteger(request.limit) || request.limit < 1) throw new DynamoDBAdapterError("Cursor page limit must be a positive safe integer.");
  validateSort(request.sortBy);
}

function validateSort(sort: DynamoDBPageRequest["sortBy"]): void {
  if (!sort) return;
  if (sort.field === "key" && ["asc", "desc"].includes(sort.direction)) return;
  throw new UnsupportedQueryError("Cursor pagination supports only native encoded key sorting (field: key, direction: asc or desc), not entity-field sorting.");
}

function pageAccess(request: DynamoDBPageRequest): Access {
  const plan = planQuery(request.where);
  if (plan.kind === "byId") return { pk: modelPk(request.model), sk: entitySk(String(eqWhere(request.where, "id")!.value)), prefix: "ID#" };
  if (plan.kind !== "byFieldValue") throw new UnsupportedQueryError("Cursor pagination requires a single id or scalar equality access path; IN fan-out and scans are unsupported.");
  const clause = firstEquality(request.where)!;
  return { pk: indexPk(request.model, clause.field, clause.value), prefix: "OWNER#" };
}

async function pageRows(items: Record<string, unknown>[], request: DynamoDBPageRequest, loadOwners: OwnerLoader): Promise<StoredItem[]> {
  if (eqWhere(request.where, "id")) return items as StoredItem[];
  return loadOwners(items as SidecarItem[], firstEquality(request.where)!);
}

function visiblePage<T>(rows: StoredItem[], options: BetterAuthDynamoDBOptions, request: DynamoDBPageRequest): T[] {
  const entities = rows.map((row) => fromStoredItem<Record<string, unknown>>(row, options.ttl));
  return entities.filter((row) => row !== null && matchesWhere(row, request.where)).map((row) => project(row!, request.select) as T);
}

function project(row: Record<string, unknown>, select?: string[]): Record<string, unknown> {
  if (!select) return row;
  return Object.fromEntries(select.map((field) => [field, row[field]]));
}

function fingerprint(options: BetterAuthDynamoDBOptions, request: DynamoDBPageRequest): string {
  // Tag dates before JSON's toJSON conversion; preserve typed predicates and clause order.
  const where = request.where.map((clause) => ({ ...clause, value: taggedValue(clause.value) }));
  return createHash("sha256").update(JSON.stringify([options.tableName, options.ttl, request.model, where, request.sortBy?.direction ?? "asc", request.select])).digest("hex");
}

function taggedValue(value: unknown): unknown {
  if (value instanceof Date) return { date: value.toISOString() };
  if (Array.isArray(value)) return value.map(taggedValue);
  return value;
}

function decodeCursor(cursor: string | undefined, query: string, access: Access): Key | undefined {
  if (cursor === undefined) return undefined;
  try {
    return parseCursor(cursor, query, access);
  } catch {
    throw new DynamoDBAdapterError("Invalid or query-mismatched pagination cursor. Use the opaque nextCursor from the same query.");
  }
}

function parseCursor(cursor: string, query: string, access: Access): Key {
  const value = JSON.parse(cursorText(cursor));
  if (value?.v !== 1 || value?.query !== query) throw new Error("query");
  return validatedKey(value.key, access);
}

function cursorText(cursor: string): string {
  // Accommodate JSON escaping of the maximum 2048/1024-byte pk/sk pair.
  if (typeof cursor !== "string" || cursor.length > 32768 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error("encoding");
  const text = Buffer.from(cursor, "base64url").toString("utf8");
  if (Buffer.from(text).toString("base64url") !== cursor) throw new Error("encoding");
  return text;
}

function validatedKey(key: any, access: Access): Key {
  if (!key || Object.keys(key).sort().join(",") !== "pk,sk") throw new Error("key shape");
  if (key.pk !== access.pk || typeof key.sk !== "string") throw new Error("key partition");
  validateSortKey(key.sk, access);
  return { pk: key.pk, sk: key.sk };
}

function validateSortKey(sk: string, access: Access): void {
  const match = new RegExp(`^${access.prefix}s(0|[1-9][0-9]*):([\\s\\S]*)$`).exec(sk);
  if (!match || Number(match[1]) !== Buffer.byteLength(match[2]!, "utf8")) throw new Error("key encoding");
  if (Buffer.byteLength(sk, "utf8") > 1024) throw new Error("key size");
  if (access.sk !== undefined && sk !== access.sk) throw new Error("key equality");
}

function encodeCursor(key: Record<string, unknown> | undefined, query: string, access: Access): string | null {
  if (!key || Object.keys(key).length === 0) return null;
  return Buffer.from(JSON.stringify({ v: 1, query, key: validatedKey(key, access) })).toString("base64url");
}
