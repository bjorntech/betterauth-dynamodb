import { GetCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { DynamoDBStore } from "./dynamodb-adapter.js";
import { DynamoDBAdapterError, DynamoDBConflictError, UnsupportedQueryError, isConditionalCheckFailed, isConditionalTransactionCanceled } from "./errors.js";
import { entitySk, modelPk } from "./keys.js";
import { fromStoredItem, isLogicallyExpired, REVISION_ATTRIBUTE, revisionOf, toStoredItem } from "./serialize.js";
import type { DynamoDBStoreOptions, QueryPlan, StoredItem } from "./types.js";
import { eqWhere, inWhere, scalarValues } from "./where.js";

type Actions = NonNullable<TransactWriteCommandInput["TransactItems"]>;
type Entry = { key: { pk: string; sk: string }; original: StoredItem | null; current: StoredItem | null; dirty: boolean };

/** Buffered unit of work; observed-row guards do not provide predicate/phantom isolation. */
export class TransactionStore extends DynamoDBStore {
  private active = true;
  private readonly entries = new Map<string, Promise<Entry>>();
  private actions: Actions = [];

  async run<T>(callback: (store: DynamoDBStore) => Promise<T>): Promise<T> {
    this.assertActive();
    try {
      const result = await callback(this);
      this.active = false;
      await this.commit();
      return result;
    } finally {
      this.active = false;
    }
  }

  override async create<T extends Record<string, unknown>>(model: string, data: T): Promise<T> {
    this.assertActive();
    const item = toStoredItem(model, data, this.options.ttl);
    const entry = await this.entry(model, item.id);
    this.assertActive();
    if (entry.current) throw new DynamoDBConflictError("Better Auth DynamoDB transaction create requires an absent id.");
    entry.current = structuredClone(item);
    entry.dirty = true;
    return structuredClone(fromStoredItem<T>(item, this.options.ttl)) as T;
  }

  override async transactCreate(): Promise<void> {
    throw new UnsupportedQueryError("Use create inside the callback; nested transactCreate is not supported.");
  }

  protected override async loadRows(model: string, plan: QueryPlan): Promise<StoredItem[]> {
    this.assertActive();
    await this.observePlan(model, plan);
    this.assertActive();
    const entries = await Promise.all(this.entries.values());
    this.assertActive();
    return entries.filter((entry) => entry.key.pk === modelPk(model)).flatMap((entry) => visibleEntry(entry, this.options));
  }

  private async observePlan(model: string, plan: QueryPlan): Promise<void> {
    if (plan.kind === "byId") {
      await this.entry(model, String(eqWhere(plan.where, "id")?.value));
      return;
    }
    if (plan.kind === "byIdValues") {
      await this.observeIds(model, plan);
      return;
    }
    const rows = await super.loadRows(model, plan);
    for (const row of rows) this.remember(row);
  }

  private async observeIds(model: string, plan: QueryPlan): Promise<void> {
    const ids = [...new Set(scalarValues(inWhere(plan.where, "id")!).map(String))];
    if (ids.length > 1000) throw new UnsupportedQueryError("Better Auth DynamoDB transaction IN exceeds 1,000 distinct ids. Narrow the predicate.");
    for (const id of ids) await this.entry(model, id);
  }

  private remember(row: StoredItem): void {
    const key = { pk: row.pk, sk: row.sk };
    const encoded = JSON.stringify(key);
    if (!this.entries.has(encoded)) this.entries.set(encoded, Promise.resolve({ key, original: structuredClone(row), current: structuredClone(row), dirty: false }));
  }

  protected override async transactReplace(_model: string, oldItem: StoredItem, newItem: StoredItem): Promise<void> {
    this.assertActive();
    if (oldItem.pk !== newItem.pk || oldItem.sk !== newItem.sk) throw new UnsupportedQueryError("Better Auth DynamoDB transaction cannot change a record id. Delete and create explicitly instead.");
    const entry = await this.entry(oldItem.model, oldItem.id);
    this.assertActive();
    assertCurrent(entry, oldItem);
    entry.current = structuredClone(newItem);
    entry.dirty = true;
  }

  protected override async transactDelete(item: StoredItem): Promise<void> {
    this.assertActive();
    const entry = await this.entry(item.model, item.id);
    this.assertActive();
    assertCurrent(entry, item);
    entry.current = null;
    entry.dirty = true;
  }

  protected override async transactIncrement(model: string, oldItem: StoredItem, newItem: StoredItem): Promise<void> {
    await this.transactReplace(model, oldItem, newItem);
  }

  protected override async sendTransactionActions(actions: Actions): Promise<void> {
    this.actions.push(...actions);
  }

  private assertActive(): void {
    if (!this.active) throw new DynamoDBAdapterError("Better Auth DynamoDB transaction adapter is closed. Await all callback operations and do not retain the scoped adapter.");
  }

  private entry(model: string, id: string): Promise<Entry> {
    const key = { pk: modelPk(model), sk: entitySk(id) };
    const encoded = JSON.stringify(key);
    let pending = this.entries.get(encoded);
    if (!pending) {
      pending = this.readEntry(key);
      this.entries.set(encoded, pending);
    }
    return pending;
  }

  private async readEntry(key: Entry["key"]): Promise<Entry> {
    const result = await this.client.send(new GetCommand({ TableName: this.options.tableName, Key: key, ConsistentRead: true }));
    const original = (result.Item as StoredItem | undefined) ?? null;
    return { key, original: structuredClone(original), current: structuredClone(original), dirty: false };
  }

  private async commit(): Promise<void> {
    const entries = await Promise.all(this.entries.values());
    for (const entry of entries) await this.buildEntry(entry);
    if (!this.actions.length) return;
    try {
      await super.sendTransactionActions(this.actions);
    } catch (error) {
      throw commitError(error);
    }
  }

  private async buildEntry(entry: Entry): Promise<void> {
    assertNotExpired(entry.original, this.options);
    if (!entry.dirty) {
      this.actions.push(readGuard(this.options.tableName, entry));
      return;
    }
    await this.buildMutation(entry);
  }

  private async buildMutation(entry: Entry): Promise<void> {
    const { original, current } = entry;
    if (!original) {
      if (current) await super.create(current.model, current.entity);
      else this.actions.push(readGuard(this.options.tableName, entry));
      return;
    }
    if (current) await super.transactReplace(original.model, original, current);
    else await super.transactDelete(original);
  }
}

function assertCurrent(entry: Entry, expected: StoredItem): void {
  if (entry.current?.[REVISION_ATTRIBUTE] !== revisionOf(expected)) throw new DynamoDBConflictError("Concurrent operations on the same scoped transaction record conflicted. Await operations sequentially.");
}

function visibleEntry(entry: Entry, options: DynamoDBStoreOptions): StoredItem[] {
  if (!entry.current) return [];
  return isLogicallyExpired(entry.current, options.ttl) ? [] : [structuredClone(entry.current)];
}

function assertNotExpired(item: StoredItem | null, options: DynamoDBStoreOptions): void {
  if (item && isLogicallyExpired(item, options.ttl)) throw new DynamoDBConflictError("Better Auth DynamoDB transaction observed an expired record. Retry after TTL cleanup or outside the callback.");
}

function readGuard(tableName: string, entry: Entry): Actions[number] {
  const base = { TableName: tableName, Key: entry.key };
  if (!entry.original) return { ConditionCheck: { ...base, ConditionExpression: "attribute_not_exists(pk)" } };
  return { ConditionCheck: { ...base, ConditionExpression: "#revision = :revision", ExpressionAttributeNames: { "#revision": REVISION_ATTRIBUTE }, ExpressionAttributeValues: { ":revision": revisionOf(entry.original) } } };
}

function commitError(error: unknown): unknown {
  if (isConditionalCheckFailed(error) || isConditionalTransactionCanceled(error)) return new DynamoDBConflictError("Better Auth DynamoDB callback commit conflicted with a changed observed row or uniqueness lock. No buffered writes committed. Retry the whole callback only if its external effects are safe to repeat.", { cause: error });
  return error;
}
