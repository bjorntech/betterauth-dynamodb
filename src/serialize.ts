import { compoundUniquePk, compoundUniqueSk, entitySk, indexPk, indexSk, listablePk, listableSk, modelPk, uniquePk, valueSk } from "./keys.js";
import type { SchemaUniqueIndex, SidecarItem, StoredItem, TtlOptions } from "./types.js";
import { randomUUID } from "node:crypto";

export const REVISION_ATTRIBUTE = "__betterAuthDynamoDBRevision";

const BASE_META_KEYS = ["pk", "sk", "model", "entity", "createdAtSort", REVISION_ATTRIBUTE] as const;

export function toStoredItem(model: string, data: Record<string, unknown>, ttl?: false | TtlOptions): StoredItem {
  const id = requireId(data);
  const entity = stripUndefined(data);
  const item: StoredItem = { ...entity, pk: modelPk(model), sk: entitySk(id), model, id, entity, [REVISION_ATTRIBUTE]: newRevision() };
  const ttlValue = deriveTtl(model, data, ttl);
  if (ttlValue !== undefined) item[ttlAttribute(ttl)] = ttlValue;
  if (typeof data.createdAt === "string") item.createdAtSort = data.createdAt;
  if (data.createdAt instanceof Date) item.createdAtSort = data.createdAt.toISOString();
  return item;
}

export function revisionOf(item: StoredItem): string {
  const revision = item[REVISION_ATTRIBUTE];
  if (typeof revision === "string" && revision.length > 0) return revision;
  throw new Error("Better Auth DynamoDB row is missing internal revision metadata. Pre-release rows written before revision metadata must be recreated before mutation.");
}

function newRevision(): string {
  return randomUUID();
}

/** Builds equality sidecars for scalar fields accepted by `include` (default: every scalar field). */
export function toIndexSidecars(model: string, data: Record<string, unknown>, ttl?: false | TtlOptions, include: (field: string) => boolean = () => true): SidecarItem[] {
  const id = requireId(data);
  const ttlValue = deriveTtl(model, data, ttl);
  return indexEntries(data).filter(([field]) => include(field)).map(([field, value]) => sidecarItem(model, id, field, value, ttlValue, ttl));
}

export function toUniqueLocks(model: string, data: Record<string, unknown>, fields: string[], ttl?: false | TtlOptions): SidecarItem[] {
  const id = requireId(data);
  const ttlValue = deriveTtl(model, data, ttl);
  return fields.flatMap((field) => uniqueLockItem(model, id, field, data[field], ttlValue, ttl));
}

export function toSchemaUniqueLocks(model: string, data: Record<string, unknown>, indexes: SchemaUniqueIndex[], ttl?: false | TtlOptions): SidecarItem[] {
  const id = requireId(data);
  const ttlValue = deriveTtl(model, data, ttl);
  return indexes.flatMap((index) => schemaUniqueLockItem(model, id, data, index, ttlValue, ttl));
}

export function toListableMembership(model: string, data: Record<string, unknown>, ttl?: false | TtlOptions): SidecarItem {
  const id = requireId(data);
  const item: SidecarItem = { pk: listablePk(model), sk: listableSk(id), model: `_listable_${model}`, id, entity: { ownerPk: modelPk(model), ownerSk: entitySk(id) }, ownerPk: modelPk(model), ownerSk: entitySk(id) };
  const ttlValue = deriveTtl(model, data, ttl);
  if (ttlValue !== undefined) item[ttlAttribute(ttl)] = ttlValue;
  return item;
}

function schemaUniqueLockItem(model: string, id: string, data: Record<string, unknown>, index: SchemaUniqueIndex, ttlValue: number | undefined, ttl?: false | TtlOptions): SidecarItem[] {
  const values = index.fields.map((field) => data[field]);
  if (values.some((value) => value === undefined || value === null)) return [];
  const item: SidecarItem = { pk: compoundUniquePk(model, index.name), sk: compoundUniqueSk(values), model: `_unique2_${model}`, id: `${index.name}:${id}`, entity: { ownerPk: modelPk(model), ownerSk: entitySk(id), fields: index.fields }, ownerPk: modelPk(model), ownerSk: entitySk(id) };
  if (ttlValue !== undefined) item[ttlAttribute(ttl)] = ttlValue;
  return [item];
}

export function fromStoredItem<T>(item?: Record<string, unknown> | null, ttlOptions?: false | TtlOptions): T | null {
  if (!item) return null;
  if (isLogicallyExpired(item, ttlOptions)) return null;
  if (isRecord(item.entity)) return item.entity as T;
  return Object.fromEntries(Object.entries(item).filter(([key]) => !metadataKeys(ttlOptions).has(key))) as T;
}

export function isLogicallyExpired(item: Record<string, unknown>, ttlOptions?: false | TtlOptions, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  if (!ttlOptions) return false;
  const ttlValue = item[ttlAttribute(ttlOptions)];
  return typeof ttlValue === "number" && ttlValue <= nowSeconds;
}

function metadataKeys(ttlOptions?: false | TtlOptions): Set<string> {
  return new Set(ttlOptions ? [...BASE_META_KEYS, ttlAttribute(ttlOptions)] : BASE_META_KEYS);
}

export function stripUndefined(data: Record<string, unknown>): Record<string, unknown> {
  return stripRecord(data);
}

function stripValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.map(stripValue).filter((entry) => entry !== undefined);
  if (isPlainRecord(value)) return stripRecord(value);
  return value;
}

function stripRecord(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, stripValue(value)]).filter((entry) => entry[1] !== undefined));
}

export function requireId(data: Record<string, unknown>): string {
  const id = data.id;
  if (typeof id === "string" && id.length > 0) return id;
  if (typeof id === "number") return String(id);
  throw new Error("Better Auth DynamoDB records require a string-compatible id");
}

function deriveTtl(model: string, data: Record<string, unknown>, ttl?: false | TtlOptions): number | undefined {
  if (!ttl) return undefined;
  const field = ttl.fields?.[model] ?? ttl.defaultField;
  return epochSeconds(field ? data[field] : undefined);
}

function epochSeconds(value: unknown): number | undefined {
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  if (typeof value !== "string") return undefined;
  const millis = Date.parse(value);
  return Number.isNaN(millis) ? undefined : Math.floor(millis / 1000);
}

export function ttlAttribute(ttl?: false | TtlOptions): string {
  return ttl ? (ttl.attributeName ?? "ttl") : "ttl";
}

export function isIndexable(value: unknown): boolean {
  return ["string", "number", "boolean"].includes(typeof value) || value instanceof Date || value === null;
}

function indexEntries(data: Record<string, unknown>): [string, unknown][] {
  return Object.entries(data).filter((entry) => isIndexable(entry[1]));
}

function sidecarItem(model: string, id: string, field: string, value: unknown, ttlValue: number | undefined, ttl?: false | TtlOptions): SidecarItem {
  const item: SidecarItem = { pk: indexPk(model, field, value), sk: indexSk(id), model: `_index_${model}`, id: `${field}:${id}`, entity: { ownerPk: modelPk(model), ownerSk: entitySk(id), field }, ownerPk: modelPk(model), ownerSk: entitySk(id), indexModel: model, indexField: field };
  if (ttlValue !== undefined) item[ttlAttribute(ttl)] = ttlValue;
  return item;
}

function uniqueLockItem(model: string, id: string, field: string, value: unknown, ttlValue: number | undefined, ttl?: false | TtlOptions): SidecarItem[] {
  if (value === undefined || value === null) return [];
  const item: SidecarItem = { pk: uniquePk(model, field), sk: valueSk(value, ""), model: `_unique_${model}`, id: `${field}:${id}`, entity: { ownerPk: modelPk(model), ownerSk: entitySk(id), field }, ownerPk: modelPk(model), ownerSk: entitySk(id) };
  if (ttlValue !== undefined) item[ttlAttribute(ttl)] = ttlValue;
  return [item];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
