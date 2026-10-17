import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { DynamoDBStore } from "../../src/dynamodb-adapter.js";
import { TransactionStore } from "../../src/transaction.js";
import { dynamoDBAdapter } from "../../src/index.js";
import type { CleanedWhere, DynamoDBStoreOptions } from "../../src/types.js";
import { startLocalDynamo, createTable, deleteTable, type LocalDynamo } from "./local-dynamo.js";

const id = (value: string): CleanedWhere[] => [{ field: "id", value, operator: "eq", mode: "sensitive" }];
const email = (value: string): CleanedWhere[] => [{ field: "email", value, operator: "eq", mode: "sensitive" }];

describe("all-or-nothing buffered callback transactions", () => {
  let local: LocalDynamo;
  let tableName: string;
  let config: DynamoDBStoreOptions;
  let store: DynamoDBStore;
  const tables: string[] = [];
  beforeAll(async () => { local = await startLocalDynamo(); });
  beforeEach(async () => {
    tableName = `transactions-${randomUUID()}`;
    tables.push(tableName);
    await createTable(local.client, tableName);
    config = { tableName, client: local.docClient, uniqueFields: { user: ["email"] } };
    store = new DynamoDBStore(config);
  });
  afterAll(async () => {
    if (!local) return;
    try { for (const name of tables) await deleteTable(local.client, name); } finally { await local.stop(); }
  });

  it("commits several models through Better Auth's public callback hook", async () => {
    const adapter = dynamoDBAdapter(config)({ secret: "test-secret", user: { modelName: "people", fields: { email: "mail" } } });
    await adapter.transaction(async (tx) => {
      await tx.create({ model: "user", data: { id: "u", email: "a@example.com", name: "Ada" }, forceAllowId: true });
      expect(await adapter.findOne({ model: "user", where: [{ field: "id", value: "u" }] })).toBeNull();
      expect(await tx.findOne({ model: "user", where: [{ field: "email", value: "a@example.com" }] })).toMatchObject({ id: "u" });
      await tx.create({ model: "account", data: { id: "a", userId: "u", accountId: "external", providerId: "credential" }, forceAllowId: true });
      await tx.update({ model: "user", where: [{ field: "id", value: "u" }], update: { name: "Updated" } });
    });
    expect(await adapter.findOne({ model: "user", where: [{ field: "email", value: "a@example.com" }] })).toMatchObject({ name: "Updated" });
    expect(await adapter.findOne({ model: "account", where: [{ field: "id", value: "a" }] })).toMatchObject({ userId: "u" });
  });

  it("leaves no entities, sidecars or locks after callback failure", async () => {
    await expect(new TransactionStore(config).run(async (tx) => {
      await tx.create("user", { id: "u", email: "a" });
      await tx.create("session", { id: "s", userId: "u" });
      throw new Error("abort");
    })).rejects.toThrow("abort");
    expect((await local.docClient.send(new ScanCommand({ TableName: tableName, ConsistentRead: true }))).Items).toEqual([]);
  });

  it("rolls back every model when a unique lock conflicts at commit", async () => {
    await store.create("user", { id: "existing", email: "taken" });
    await expect(new TransactionStore(config).run(async (tx) => {
      await tx.create("session", { id: "s", userId: "new" });
      await tx.create("user", { id: "new", email: "taken" });
    })).rejects.toThrow();
    expect(await store.findOne("session", id("s"))).toBeNull();
    expect(await store.findOne("user", id("new"))).toBeNull();
    expect(await store.findOne("user", email("taken"))).toMatchObject({ id: "existing" });
  });

  it("revision-checks read-only observations and absent id reads at commit", async () => {
    await store.create("user", { id: "observed", email: "initial" });
    await expect(new TransactionStore(config).run(async (tx) => {
      await tx.findOne("user", email("initial"));
      await tx.create("session", { id: "s" });
      await store.update("user", id("observed"), { email: "changed" });
    })).rejects.toThrow();
    expect(await store.findOne("session", id("s"))).toBeNull();
    await expect(new TransactionStore(config).run(async (tx) => {
      expect(await tx.findOne("user", id("new"))).toBeNull();
      await tx.create("session", { id: "s" });
      await store.create("user", { id: "new" });
    })).rejects.toThrow();
    expect(await store.findOne("session", id("s"))).toBeNull();
  });

  it("coalesces repeated updates, increments, consume and delete/recreate without leftover sidecars", async () => {
    await store.create("user", { id: "u", email: "old", count: 1 });
    await store.create("verification", { id: "token", value: "secret" });
    await store.create("session", { id: "replace", userId: "old" });
    await new TransactionStore(config).run(async (tx) => {
      await tx.update("user", id("u"), { email: "new" });
      await tx.incrementOne("user", id("u"), { count: 2 });
      await tx.incrementOne("user", id("u"), { count: -1 });
      expect(await tx.consumeOne("verification", id("token"))).toMatchObject({ value: "secret" });
      expect(await tx.consumeOne("verification", id("token"))).toBeNull();
      await tx.delete("session", id("replace"));
      await tx.create("session", { id: "replace", userId: "u" });
      await tx.create("session", { id: "temporary" });
      await tx.delete("session", id("temporary"));
      expect(await tx.findMany("user", email("old"))).toEqual([]);
      expect(await tx.findMany("user", email("new"))).toMatchObject([{ count: 2 }]);
    });
    expect(await store.findOne("user", email("old"))).toBeNull();
    expect(await store.findOne("user", email("new"))).toMatchObject({ count: 2 });
    expect(await store.findOne("verification", id("token"))).toBeNull();
    expect(await store.findOne("session", id("replace"))).toMatchObject({ userId: "u" });
    const rows = (await local.docClient.send(new ScanCommand({ TableName: tableName, ConsistentRead: true }))).Items!;
    expect(rows.some((row) => row.id === "temporary" || row.id === "token")).toBe(false);
    await store.create("user", { id: "reclaimed", email: "old" });
  });

  it("rejects an ABA mutation and rolls back the whole callback", async () => {
    await store.create("user", { id: "u", email: "same", counter: 1 });
    await expect(new TransactionStore(config).run(async (tx) => {
      await tx.incrementOne("user", id("u"), { counter: 1 });
      await tx.create("session", { id: "s" });
      await store.update("user", id("u"), { email: "different" });
      await store.update("user", id("u"), { email: "same" });
    })).rejects.toThrow();
    expect(await store.findOne("session", id("s"))).toBeNull();
    expect(await store.findOne("user", id("u"))).toMatchObject({ counter: 1 });
  });

  it("has exactly one commit winner for concurrent token-consuming callbacks", async () => {
    await store.create("verification", { id: "token", value: "secret" });
    let arrive = 0;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    const consume = (session: string) => new TransactionStore(config).run(async (tx) => {
      const token = await tx.consumeOne("verification", id("token"));
      expect(token).toMatchObject({ value: "secret" });
      await tx.create("session", { id: session });
      if (++arrive === 2) release();
      await ready;
      return token;
    });
    const results = await Promise.allSettled([consume("first"), consume("second")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await store.findOne("verification", id("token"))).toBeNull();
    expect([await store.findOne("session", id("first")), await store.findOne("session", id("second"))].filter(Boolean)).toHaveLength(1);
  });

  it("maintains retained lock TTL and compound locks in a multi-item commit", async () => {
    config = { ...config, ttl: { fields: { user: "expiresAt" } }, schemaUniqueIndexes: [{ model: "user", name: "tenant-name", fields: ["tenant", "name"] }] };
    store = new DynamoDBStore(config);
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    await store.create("user", { id: "u", email: "same", tenant: "t", name: "n", expiresAt });
    const later = new Date(Date.now() + 900_000).toISOString();
    await new TransactionStore(config).run(async (tx) => {
      await tx.update("user", id("u"), { expiresAt: later });
      await tx.create("session", { id: "s", userId: "u" });
    });
    const rows = (await local.docClient.send(new ScanCommand({ TableName: tableName, ConsistentRead: true }))).Items!;
    const locks = rows.filter((row) => row.pk.startsWith("UNIQUE"));
    expect(locks).toHaveLength(2);
    expect(locks.every((row) => row.ttl === Math.floor(Date.parse(later) / 1000))).toBe(true);
    await expect(new TransactionStore(config).run(async (tx) => {
      await tx.create("session", { id: "bad" });
      await tx.create("user", { id: "duplicate", email: "other", tenant: "t", name: "n" });
    })).rejects.toThrow();
    expect(await store.findOne("session", id("bad"))).toBeNull();
  });

  it("rejects oversized aggregate action sets without partially writing", async () => {
    await expect(new TransactionStore(config).run(async (tx) => {
      for (let i = 0; i < 51; i++) await tx.create("session", { id: String(i) });
    })).rejects.toThrow("100");
    expect((await local.docClient.send(new ScanCommand({ TableName: tableName, ConsistentRead: true }))).Items).toEqual([]);
  });
});
