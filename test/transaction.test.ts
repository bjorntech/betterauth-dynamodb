import { describe, expect, it, vi } from "vitest";
import { GetCommand, QueryCommand, ScanCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { TransactionStore } from "../src/transaction.js";
import { dynamoDBAdapter } from "../src/index.js";
import { toStoredItem, toIndexSidecars, REVISION_ATTRIBUTE } from "../src/serialize.js";
import type { CleanedWhere, DynamoDBStoreOptions, StoredItem } from "../src/types.js";

const id = (value: string): CleanedWhere[] => [{ field: "id", value, operator: "eq", mode: "sensitive" }];
function setup(rows: StoredItem[] = [], options: Partial<DynamoDBStoreOptions> = {}) {
  const send = vi.fn(async (command: any): Promise<any> => {
    if (command instanceof GetCommand) return { Item: rows.find((row) => row.pk === command.input.Key?.pk && row.sk === command.input.Key?.sk) };
    if (command instanceof QueryCommand) return { Items: rows.flatMap((row) => toIndexSidecars(row.model, row.entity)).filter((sidecar) => sidecar.pk === command.input.ExpressionAttributeValues?.[":pk"]) };
    if (command instanceof ScanCommand) return { Items: rows.filter((row) => row.model === command.input.ExpressionAttributeValues?.[":model"]) };
    return {};
  });
  const config = { tableName: "auth", client: { send } as never, ...options };
  const store = new TransactionStore(config);
  const commits = () => send.mock.calls.map(([command]) => command).filter((command): command is TransactWriteCommand => command instanceof TransactWriteCommand);
  return { store, send, config, commits };
}

describe("buffered transaction callbacks", () => {
  it("uses Better Auth's actual config hook and wraps scoped model/field transformations", async () => {
    const { config, commits, send } = setup();
    const adapter = dynamoDBAdapter(config)({ secret: "x", user: { modelName: "people", fields: { email: "mail" } } });
    const result = await adapter.transaction(async (tx) => {
      const created = await tx.create({ model: "user", data: { id: "u", email: "a@example.com", name: "Ada" }, forceAllowId: true });
      expect(created).toMatchObject({ id: "u", email: "a@example.com" });
      expect(commits()).toHaveLength(0);
      await tx.update({ model: "user", where: [{ field: "id", value: "u" }], update: { email: "b@example.com" } });
      expect(await tx.findOne({ model: "user", where: [{ field: "id", value: "u" }] })).toMatchObject({ email: "b@example.com" });
      return "committed";
    });
    expect(result).toBe("committed");
    expect(commits()).toHaveLength(1);
    expect(send.mock.calls.filter(([command]) => command instanceof GetCommand)).toHaveLength(1);
    expect(commits()[0]?.input.TransactItems).toContainEqual(expect.objectContaining({ Put: expect.objectContaining({ Item: expect.objectContaining({ model: "people", entity: expect.objectContaining({ mail: "b@example.com" }) }) }) }));
  });

  it("rolls back on callback throw and rejects escaped adapters after both success and failure", async () => {
    const { config, commits } = setup();
    const adapter = dynamoDBAdapter(config)({ secret: "x" });
    let escaped: any;
    await expect(adapter.transaction(async (tx) => {
      escaped = tx;
      await tx.create({ model: "user", data: { id: "u", email: "a@example.com" }, forceAllowId: true });
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect(commits()).toHaveLength(0);
    await expect(escaped.findOne({ model: "user", where: [{ field: "id", value: "u" }] })).rejects.toThrow("closed");
    await adapter.transaction(async (tx) => { escaped = tx; });
    await expect(escaped.create({ model: "user", data: { id: "u" }, forceAllowId: true })).rejects.toThrow("closed");
    await expect(escaped.transaction(async () => null)).rejects.toThrow("Nested");
  });

  it("does not return callback results on commit failure", async () => {
    const { store, send, commits } = setup();
    send.mockImplementation(async (command) => {
      if (command instanceof TransactWriteCommand) throw new Error("network failure");
      return {};
    });
    await expect(store.run(async (tx) => { await tx.create("user", { id: "u" }); return 42; })).rejects.toThrow("network failure");
    expect(commits()).toHaveLength(1);
    await expect(store.create("user", { id: "v" })).rejects.toThrow("closed");
  });

  it.each([
    { name: "ConditionalCheckFailedException" },
    { name: "TransactionCanceledException", CancellationReasons: [{ Code: "ConditionalCheckFailed" }] }
  ])("makes conditional commit failures actionable", async (error) => {
    const { store, send } = setup();
    send.mockImplementation(async (command) => {
      if (command instanceof TransactWriteCommand) throw error;
      return {};
    });
    await expect(store.run(async (tx) => { await tx.create("user", { id: "u" }); })).rejects.toThrow("No buffered writes committed");
  });

  it("isolates transaction configuration when a factory initializes multiple adapters", async () => {
    const { config, commits } = setup();
    const factory = dynamoDBAdapter(config);
    const first = factory({ secret: "first", user: { modelName: "first_people", fields: { email: "first_mail" } } });
    const second = factory({ secret: "second", user: { modelName: "second_people", fields: { email: "second_mail" } } });
    await first.transaction(async (tx) => { await tx.create({ model: "user", data: { id: "a", email: "first" }, forceAllowId: true }); });
    await second.transaction(async (tx) => { await tx.create({ model: "user", data: { id: "b", email: "second" }, forceAllowId: true }); });
    expect(commits()[0]?.input.TransactItems).toContainEqual(expect.objectContaining({ Put: expect.objectContaining({ Item: expect.objectContaining({ model: "first_people", entity: expect.objectContaining({ first_mail: "first" }) }) }) }));
    expect(commits()[1]?.input.TransactItems).toContainEqual(expect.objectContaining({ Put: expect.objectContaining({ Item: expect.objectContaining({ model: "second_people", entity: expect.objectContaining({ second_mail: "second" }) }) }) }));
  });

  it("coalesces mixed writes and keeps original revision guards including read-only rows", async () => {
    const a = toStoredItem("user", { id: "a", counter: 1, email: "old" });
    const b = toStoredItem("session", { id: "b" });
    const c = toStoredItem("user", { id: "c" });
    const { store, commits } = setup([a, b, c], { uniqueFields: { user: ["email"] } });
    await store.run(async (tx) => {
      await tx.update("user", id("a"), { email: "new" });
      expect(await tx.incrementOne("user", id("a"), { counter: 2 })).toMatchObject({ counter: 3 });
      expect(await tx.incrementOne("user", id("a"), { counter: -1 }, { flag: true })).toMatchObject({ counter: 2, flag: true });
      expect(await tx.consumeOne("session", id("b"))).toMatchObject({ id: "b" });
      expect(await tx.findOne("session", id("b"))).toBeNull();
      await tx.findOne("user", id("c"));
      await tx.findOne("user", id("missing"));
      await tx.create("user", { id: "d", name: "new" });
      await tx.create("user", { id: "temporary" });
      await tx.delete("user", id("temporary"));
      await tx.delete("user", id("missing"));
    });
    const actions = commits()[0]!.input.TransactItems!;
    expect(actions.find((action) => action.Put?.Item?.id === "a")?.Put).toMatchObject({ Item: { counter: 2 }, ExpressionAttributeValues: { ":revision": a[REVISION_ATTRIBUTE] } });
    expect(actions.find((action) => action.Delete?.Key?.sk === b.sk)?.Delete).toMatchObject({ ExpressionAttributeValues: { ":revision": b[REVISION_ATTRIBUTE] } });
    expect(actions.filter((action) => action.ConditionCheck)).toHaveLength(3);
    expect(actions.filter((action) => action.Put?.Item?.id === "a")).toHaveLength(1);
    expect(actions.some((action) => action.Put?.Item?.id === "temporary")).toBe(false);
  });

  it("replaces delete/recreate from its original snapshot and preserves TTL sidecar changes", async () => {
    const ttl = { fields: { user: "expiresAt" } };
    const original = toStoredItem("user", { id: "u", email: "same", expiresAt: new Date(Date.now() + 100_000) }, ttl);
    const { store, commits } = setup([original], { ttl, uniqueFields: { user: ["email"] } });
    await store.run(async (tx) => {
      await tx.delete("user", id("u"));
      await tx.create("user", { id: "u", email: "same", expiresAt: new Date(Date.now() + 200_000) });
    });
    const actions = commits()[0]!.input.TransactItems!;
    expect(actions[0]?.Put?.ExpressionAttributeValues).toEqual({ ":revision": original[REVISION_ATTRIBUTE] });
    expect(actions.some((action) => action.Update?.UpdateExpression === "SET #ttl = :ttl")).toBe(true);
  });

  it("supports keyed bulk methods, residual filters, sorting and projection", async () => {
    const { store } = setup([toStoredItem("user", { id: "u", name: "Ada" })]);
    await store.run(async (tx) => {
      expect(await tx.count("user", id("u"))).toBe(1);
      expect(await tx.findMany("user", id("u"), 1, 0, { field: "name", direction: "asc" }, ["name"])).toEqual([{ name: "Ada" }]);
      expect(await tx.updateMany("user", id("u"), { name: "New" })).toBe(1);
      expect(await tx.findOne("user", [...id("u"), { field: "name", value: "Ada", operator: "eq", mode: "sensitive" }])).toBeNull();
      expect(await tx.deleteMany("user", id("u"))).toBe(1);
      expect(await tx.count("user", id("u"))).toBe(0);
    });
  });

  it("isolates returned objects from the scoped cache", async () => {
    const original = toStoredItem("user", { id: "u", nested: { value: 1 } });
    const { store, commits } = setup([original]);
    await store.run(async (tx) => {
      const row = await tx.findOne<any>("user", id("u"));
      row.nested.value = 999;
      expect(await tx.findOne("user", id("u"))).toMatchObject({ nested: { value: 1 } });
    });
    expect(commits()[0]?.input.TransactItems?.[0]?.ConditionCheck?.ExpressionAttributeValues).toEqual({ ":revision": original[REVISION_ATTRIBUTE] });
  });

  it("rejects hidden scans, nested raw batches, existing creates and changing ids", async () => {
    const { store, commits } = setup([toStoredItem("user", { id: "u" })]);
    await store.run(async (tx) => {
      await expect(tx.findMany("user")).rejects.toThrow("unsafeAllowScan");
      await expect(tx.transactCreate([])).rejects.toThrow("nested transactCreate");
      await expect(tx.create("user", { id: "u" })).rejects.toThrow("absent id");
      await expect(tx.update("user", id("u"), { id: "v" })).rejects.toThrow("cannot change");
    });
    expect(commits()).toHaveLength(1);
  });

  it("overlays scalar and IN keyed reads and guards every observed entity", async () => {
    const { store, commits } = setup([toStoredItem("user", { id: "a", email: "old" }), toStoredItem("user", { id: "b", email: "new" })]);
    const email = (value: string): CleanedWhere[] => [{ field: "email", value, operator: "eq", mode: "sensitive" }];
    await store.run(async (tx) => {
      expect(await tx.findOne("user", email("old"))).toMatchObject({ id: "a" });
      await tx.update("user", id("a"), { email: "new" });
      expect(await tx.count("user", email("old"))).toBe(0);
      await tx.create("user", { id: "c", email: "new" });
      expect(await tx.count("user", email("new"))).toBe(3);
      expect(await tx.findMany("user", [{ field: "id", value: ["a", "b", "missing", "missing"], operator: "in", mode: "sensitive" }])).toHaveLength(2);
      expect(await tx.findMany("user", [{ field: "email", value: ["old", "new"], operator: "in", mode: "sensitive" }])).toHaveLength(3);
      await tx.delete("user", id("b"));
      expect(await tx.count("user", email("new"))).toBe(2);
      await expect(tx.findMany("user", [{ field: "id", value: Array.from({ length: 1001 }, (_, i) => String(i)), operator: "in", mode: "sensitive" }])).rejects.toThrow("1,000");
    });
    expect(commits()).toHaveLength(1);
    expect(commits()[0]?.input.TransactItems?.filter((action) => action.ConditionCheck)).toHaveLength(1);
  });

  it("honors explicit unsafe scan opt-in without pretending to guard phantom inserts", async () => {
    const { store, commits } = setup([toStoredItem("user", { id: "a" })], { unsafeAllowScan: true });
    await store.run(async (tx) => {
      await tx.create("user", { id: "b" });
      expect(await tx.findMany("user")).toHaveLength(2);
      await tx.delete("user", id("a"));
      expect(await tx.count("user")).toBe(1);
    });
    expect(commits()).toHaveLength(1);
  });

  it("fails all-or-nothing before send for aggregate action, size and duplicate-key conflicts", async () => {
    const capped = setup();
    await expect(capped.store.run(async (tx) => {
      for (let i = 0; i < 51; i++) await tx.create("user", { id: String(i) });
    })).rejects.toThrow("100");
    expect(capped.commits()).toHaveLength(0);
    const oversized = setup();
    await expect(oversized.store.run(async (tx) => {
      for (let i = 0; i < 5; i++) await tx.create("user", { id: String(i), blob: "x".repeat(500_000) });
    })).rejects.toThrow("4 MB");
    expect(oversized.commits()).toHaveLength(0);
    const duplicate = setup([], { uniqueFields: { user: ["email"] } });
    await expect(duplicate.store.run(async (tx) => {
      await tx.create("user", { id: "a", email: "same" });
      await tx.create("user", { id: "b", email: "same" });
    })).rejects.toThrow("duplicate operation");
    expect(duplicate.commits()).toHaveLength(0);
  });

  it("does not commit expired reads or pre-revision rows", async () => {
    const ttl = { fields: { user: "expiresAt" } };
    const expired = setup([toStoredItem("user", { id: "u", expiresAt: new Date(0) }, ttl)], { ttl });
    await expect(expired.store.run(async (tx) => { expect(await tx.findOne("user", id("u"))).toBeNull(); })).rejects.toThrow("expired");
    expect(expired.commits()).toHaveLength(0);
    const legacy = toStoredItem("user", { id: "u" });
    delete (legacy as Partial<StoredItem>)[REVISION_ATTRIBUTE];
    const old = setup([legacy]);
    await expect(old.store.run(async (tx) => { await tx.findOne("user", id("u")); })).rejects.toThrow("missing internal revision");
  });

  it("rejects same-record concurrent writes rather than losing a staged write", async () => {
    const { store, commits } = setup([toStoredItem("user", { id: "u" })]);
    await expect(store.run(async (tx) => {
      await Promise.all([tx.update("user", id("u"), { name: "A" }), tx.update("user", id("u"), { name: "B" })]);
    })).rejects.toThrow("conflicted");
    expect(commits()).toHaveLength(0);
  });
});
