import { createHash } from "node:crypto";

const SEP = "#";
const MAX_PARTITION_KEY_BYTES = 2048;
const MAX_SORT_KEY_BYTES = 1024;

export function modelPk(model: string): string {
  return checkedPartitionKey(`MODEL${SEP}${component(model)}`, "model partition key");
}

/** Partition containing membership rows for an opt-in small, globally-listable model. */
export function listablePk(model: string): string {
  return checkedPartitionKey(`LIST${SEP}${component(model)}`, "listable model partition key");
}

export function listableSk(id: string): string {
  return checkedSortKey(`MEMBER${SEP}${component(id)}`, "listable model member sort key");
}

export function entitySk(id: string): string {
  return checkedSortKey(`ID${SEP}${component(id)}`, "entity sort key");
}

export function fieldPk(model: string, field: string): string {
  return checkedPartitionKey(`MODEL${SEP}${component(model)}${SEP}FIELD${SEP}${component(field)}`, "field partition key");
}

export function indexPk(model: string, field: string, value: unknown): string {
  return checkedPartitionKey(`INDEX${SEP}${component(model)}${SEP}FIELD${SEP}${component(field)}${SEP}VALUE${SEP}${hashValue(value)}`, "scalar index partition key");
}

export function indexSk(id: string): string {
  return checkedSortKey(`OWNER${SEP}${component(id)}`, "scalar index sort key");
}

export function uniquePk(model: string, field: string): string {
  return checkedPartitionKey(`UNIQUE${SEP}${component(model)}${SEP}${component(field)}`, "unique lock partition key");
}

export function valueSk(value: unknown, id: string): string {
  return checkedSortKey(`VALUE${SEP}${hashValue(value)}${SEP}${component(id)}`, "unique lock sort key");
}

/** Versioned tuple namespace. Values are hashed only after type-preserving encoding. */
export function compoundUniquePk(model: string, index: string): string {
  return checkedPartitionKey(`UNIQUE2${SEP}${component(model)}${SEP}${component(index)}`, "compound unique lock partition key");
}

/** Stable unnamed-index namespace: preserve declared field order and length-prefix each field. */
export function compoundUniqueIndexName(fields: string[]): string {
  return fields.map(component).join(SEP);
}

export function compoundUniqueSk(values: unknown[]): string {
  return checkedSortKey(`TUPLE${SEP}${hashValue(JSON.stringify(values.map(encodeValue)))}`, "compound unique lock sort key");
}

export function encodeValue(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (value === null) return "null:null";
  return `${typeof value}:${String(value)}`;
}

function hashValue(value: unknown): string {
  return createHash("sha256").update(encodeValue(value)).digest("hex");
}

function component(value: string): string {
  return `s${Buffer.byteLength(value, "utf8")}:${value}`;
}

function checkedPartitionKey(value: string, label: string): string {
  return checkedKeyBytes(value, label, MAX_PARTITION_KEY_BYTES, "partition");
}

function checkedSortKey(value: string, label: string): string {
  return checkedKeyBytes(value, label, MAX_SORT_KEY_BYTES, "sort");
}

function checkedKeyBytes(value: string, label: string, maxBytes: number, keyType: "partition" | "sort"): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  throw new Error(`Better Auth DynamoDB ${label} exceeds DynamoDB ${maxBytes}-byte ${keyType} key limit. Shorten model, field, or id values.`);
}
