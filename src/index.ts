import { createAdapterFactory } from "better-auth/adapters";
import { DynamoDBStore } from "./dynamodb-adapter.js";
import { UnsupportedQueryError } from "./errors.js";
import { compoundUniqueIndexName } from "./keys.js";
import type { BetterAuthDynamoDBOptions, SchemaUniqueIndex } from "./types.js";

export type { BetterAuthDynamoDBOptions, TtlOptions } from "./types.js";
export { DynamoDBAdapterError, DynamoDBConflictError, UnsupportedQueryError } from "./errors.js";

export function dynamoDBAdapter(adapterOptions: BetterAuthDynamoDBOptions) {
  return createAdapterFactory({
    config: {
      adapterId: "betterauth-dynamodb",
      adapterName: "Better Auth DynamoDB",
      supportsDates: false,
      supportsBooleans: true,
      supportsJSON: true,
      supportsArrays: true,
      supportsNumericIds: false,
      transaction: false
    },
    adapter: ({ schema, getModelName, getFieldName }) => {
      const schemaUniqueFields = collectUniqueFields(schema, getModelName, getFieldName);
      const schemaUniqueIndexes = adapterOptions.enforceSchemaUniqueIndexes ? collectSchemaUniqueIndexes(schema, getModelName, getFieldName) : [];
      const lowCardinalityFields = mergeUniqueFields(defaultLowCardinalityFields(getModelName, getFieldName), adapterOptions.lowCardinalityFields);
      const nonIndexedFields = mergeUniqueFields(defaultNonIndexedFields(getModelName, getFieldName), adapterOptions.nonIndexedFields);
      const store = new DynamoDBStore({ ...adapterOptions, uniqueFields: mergeUniqueFields(schemaUniqueFields, adapterOptions.uniqueFields), lowCardinalityFields, nonIndexedFields, schemaUniqueIndexes });
      const adapter: any = {
        create: <T extends Record<string, unknown>>(data: { model: string; data: T }) => store.create(data.model, data.data),
        findOne: <T>(data: { model: string; where: any[]; select?: string[]; join?: Record<string, unknown> }) => {
          assertNoNativeJoin(data.join);
          return store.findOne<T>(data.model, data.where, storageSelect(data.model, data.select, schema, getModelName, getFieldName));
        },
        findMany: <T>(data: { model: string; where?: any[]; limit: number; offset?: number; sortBy?: { field: string; direction: "asc" | "desc" }; select?: string[]; join?: Record<string, unknown> }) => {
          assertNoNativeJoin(data.join);
          return store.findMany<T>(data.model, data.where, data.limit, data.offset, data.sortBy, storageSelect(data.model, data.select, schema, getModelName, getFieldName));
        },
        count: (data: { model: string; where?: any[] }) => store.count(data.model, data.where),
        update: <T>(data: { model: string; where: any[]; update: Record<string, unknown> }) => store.update<T>(data.model, data.where, data.update),
        updateMany: (data: { model: string; where: any[]; update: Record<string, unknown> }) => store.updateMany(data.model, data.where, data.update),
        delete: (data: { model: string; where: any[] }) => store.delete(data.model, data.where),
        deleteMany: (data: { model: string; where: any[] }) => store.deleteMany(data.model, data.where),
        consumeOne: <T>(data: { model: string; where: any[] }) => store.consumeOne<T>(data.model, data.where),
        incrementOne: <T>(data: { model: string; where: any[]; increment: Record<string, number>; set?: Record<string, unknown> }) =>
          store.incrementOne<T>(data.model, data.where, data.increment, data.set),
        options: { tableName: adapterOptions.tableName }
      };
      return adapter;
    }
  });
}

function mergeUniqueFields(...sources: (Record<string, string[]> | undefined)[]): Record<string, string[]> {
  const merged: Record<string, string[]> = {};
  for (const source of sources) {
    for (const [model, fields] of Object.entries(source ?? {})) merged[model] = [...new Set([...(merged[model] ?? []), ...fields])];
  }
  return merged;
}

/** Better Auth core looks accounts up by providerId + accountId with providerId first; providerId is shared by every account of a provider. */
function defaultLowCardinalityFields(getModelName: ModelNameResolver, getFieldName: FieldNameResolver): Record<string, string[]> {
  return { [getModelName("account")]: [getFieldName({ model: "account", field: "providerId" })] };
}

/** Secrets Better Auth core never queries by; indexing them only multiplies copies and write cost. */
const DEFAULT_NON_INDEXED_ACCOUNT_FIELDS = ["password", "accessToken", "refreshToken", "idToken"];

function defaultNonIndexedFields(getModelName: ModelNameResolver, getFieldName: FieldNameResolver): Record<string, string[]> {
  return { [getModelName("account")]: DEFAULT_NON_INDEXED_ACCOUNT_FIELDS.map((field) => getFieldName({ model: "account", field })) };
}

type AdapterSchema = Record<string, { fields: Record<string, { unique?: boolean | undefined }> }>;
type ModelNameResolver = (model: string) => string;
type FieldNameResolver = (input: { model: string; field: string }) => string;

function collectUniqueFields(schema: AdapterSchema, getModelName: ModelNameResolver, getFieldName: FieldNameResolver): Record<string, string[]> {
  return mergeUniqueEntries(Object.entries(schema).map((entry) => uniqueFieldEntry(entry, getModelName, getFieldName)).filter(hasUniqueFields));
}

function mergeUniqueEntries(entries: [string, string[]][]): Record<string, string[]> {
  return mergeUniqueFields(...entries.map(([model, fields]) => ({ [model]: fields })));
}

function uniqueFieldEntry(entry: [string, AdapterSchema[string]], getModelName: ModelNameResolver, getFieldName: FieldNameResolver): [string, string[]] {
  const [model, table] = entry;
  return [getModelName(model), Object.entries(table.fields).filter((field) => field[1].unique).map((field) => getFieldName({ model, field: field[0] }))];
}

function hasUniqueFields(entry: [string, string[]]): boolean {
  return entry[1].length > 0;
}

/** Mirrors Better Auth's `DBTableIndex`: `indexes` is always an array of table-level index definitions. */
type IndexDefinition = { name?: string; fields?: readonly string[]; unique?: boolean };
type IndexedTable = AdapterSchema[string] & { indexes?: readonly IndexDefinition[] };

export function collectSchemaUniqueIndexes(schema: AdapterSchema, getModelName: ModelNameResolver, getFieldName: FieldNameResolver): SchemaUniqueIndex[] {
  return Object.entries(schema as Record<string, IndexedTable>).flatMap(([model, table]) => schemaIndexesForModel(model, table, getModelName, getFieldName));
}

function schemaIndexesForModel(logicalModel: string, table: IndexedTable, getModelName: ModelNameResolver, getFieldName: FieldNameResolver): SchemaUniqueIndex[] {
  return (table.indexes ?? []).filter((index) => index.unique).map((index) => validatedSchemaIndex(logicalModel, table, index, getModelName, getFieldName));
}

function validatedSchemaIndex(logicalModel: string, table: AdapterSchema[string], index: IndexDefinition, getModelName: ModelNameResolver, getFieldName: FieldNameResolver): SchemaUniqueIndex {
  const fields = [...(index.fields ?? [])];
  validateIndexFields(logicalModel, table, index.name ?? "unnamed", fields);
  const mappedFields = fields.map((field) => getFieldName({ model: logicalModel, field }));
  // Better Auth 1.7.5's getDatabaseIndexName (in @better-auth/core/db/database-index.ts)
  // uses declared field order; preserve it here too. Unlike that SQL name, each component
  // is length-prefixed so delimiters cannot collide in this DynamoDB namespace.
  const name = index.name ?? compoundUniqueIndexName(mappedFields);
  return { model: getModelName(logicalModel), name, fields: mappedFields };
}

function validateIndexFields(model: string, table: AdapterSchema[string], name: string, fields: string[]): void {
  validateIndexSize(model, name, fields);
  validateIndexPresence(model, table, name, fields);
  validateIndexTypes(model, table, name, fields);
}

function validateIndexSize(model: string, name: string, fields: string[]): void {
  rejectEmptyIndex(model, name, fields);
  rejectWideIndex(model, name, fields);
  rejectDuplicateFields(model, name, fields);
}

function rejectDuplicateFields(model: string, name: string, fields: string[]): void {
  if (new Set(fields).size !== fields.length) throw new Error(`Better Auth DynamoDB schema unique index "${name}" on model "${model}" contains the same field more than once.`);
}

function rejectEmptyIndex(model: string, name: string, fields: string[]): void { if (fields.length === 0) throw invalidIndexSize(model, name); }
function rejectWideIndex(model: string, name: string, fields: string[]): void { if (fields.length > 16) throw invalidIndexSize(model, name); }

function invalidIndexSize(model: string, name: string): Error { return new Error(`Better Auth DynamoDB schema unique index "${name}" on model "${model}" must contain 1-16 fields.`); }

function validateIndexPresence(model: string, table: AdapterSchema[string], name: string, fields: string[]): void {
  const missing = fields.find((field) => missingIndexField(table, field));
  if (missing) throw new Error(`Better Auth DynamoDB schema unique index "${name}" on model "${model}" references an optional or unknown field "${missing}".`);
}

function missingIndexField(table: AdapterSchema[string], field: string): boolean {
  if (!table.fields[field]) return true;
  return (table.fields[field] as { required?: boolean }).required === false;
}

// Same deny-list as Better Auth's resolveDatabaseTableIndexes; enum-literal array types are indexable strings.
const NON_INDEXABLE_FIELD_TYPES = ["json", "string[]", "number[]"];

function validateIndexTypes(model: string, table: AdapterSchema[string], name: string, fields: string[]): void {
  const nonScalar = fields.find((field) => NON_INDEXABLE_FIELD_TYPES.includes(String((table.fields[field] as { type?: unknown }).type)));
  if (nonScalar) throw new Error(`Better Auth DynamoDB schema unique index "${name}" on model "${model}" references non-scalar field "${nonScalar}".`);
}

function storageSelect(model: string, select: string[] | undefined, schema: AdapterSchema, getModelName: ModelNameResolver, getFieldName: FieldNameResolver): string[] | undefined {
  if (!select) return undefined;
  const defaultModel = defaultModelName(model, schema, getModelName);
  return select.map((field) => getFieldName({ model: defaultModel, field }));
}

function defaultModelName(model: string, schema: AdapterSchema, getModelName: ModelNameResolver): string {
  return Object.keys(schema).find((key) => getModelName(key) === model) ?? model;
}

function assertNoNativeJoin(join: Record<string, unknown> | undefined): void {
  if (!join || Object.keys(join).length === 0) return;
  throw new UnsupportedQueryError("Better Auth native joins are not supported by the DynamoDB adapter. Disable advanced.database.joins (experimental.joins on Better Auth 1.6.x) so Better Auth can use its fallback join queries.");
}
