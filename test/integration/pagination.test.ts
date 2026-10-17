import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDynamoDBPaginator } from "../../src/index.js";
import type { CleanedWhere, DynamoDBPageRequest } from "../../src/index.js";
import { DynamoDBStore } from "../../src/dynamodb-adapter.js";
import { createTable, deleteTable, startLocalDynamo } from "./local-dynamo.js";

const eq = (field: string, value: CleanedWhere["value"]): CleanedWhere => ({ field, value, operator: "eq", mode: "sensitive" });

describe("native key cursor pagination", () => {
  let local: Awaited<ReturnType<typeof startLocalDynamo>>;
  const tableName = `pagination_${randomUUID().replaceAll("-", "")}`;
  let store: DynamoDBStore;
  let paginator: ReturnType<typeof createDynamoDBPaginator>;

  beforeAll(async () => {
    local = await startLocalDynamo();
    await createTable(local.client, tableName);
    const options = { tableName, client: local.docClient, ttl: { defaultField: "expiresAt" } };
    store = new DynamoDBStore(options);
    paginator = createDynamoDBPaginator(options);
  });

  afterAll(async () => {
    if (!local) return;
    try { await deleteTable(local.client, tableName); } finally { await local.stop(); }
  });

  it("resumes across intervening inserts without offset repeats and reverses native key order", async () => {
    for (const id of ["b", "d", "zz"]) await store.create("member", { id, group: "stable" });
    const request: DynamoDBPageRequest = { model: "member", where: [eq("group", "stable")], limit: 1 };
    const first = await paginator.findPage<{ id: string }>(request);
    expect(first.items.map((row) => row.id)).toEqual(["b"]);
    expect(first.nextCursor).toEqual(expect.any(String));
    // A newly inserted earlier key must not shift the cursor's position.
    await store.create("member", { id: "a", group: "stable" });
    await store.create("member", { id: "c", group: "stable" });
    const rest: string[] = [];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await paginator.findPage<{ id: string }>({ ...request, cursor });
      rest.push(...page.items.map((row) => row.id));
      cursor = page.nextCursor;
    }
    expect(rest).toEqual(["c", "d", "zz"]);
    const reverse = await paginator.findPage<{ id: string }>({ ...request, limit: 20, sortBy: { field: "key", direction: "desc" } });
    expect(reverse.items.map((row) => row.id)).toEqual(["zz", "d", "c", "b", "a"]);
    expect(reverse.nextCursor).toBeNull();
  });

  it("exposes empty residual-filter and expired-owner pages with resumable native cursors", async () => {
    await store.create("filtered", { id: "a", group: "g", active: false });
    await store.create("filtered", { id: "b", group: "g", active: true, expiresAt: "2000-01-01T00:00:00Z" });
    await store.create("filtered", { id: "c", group: "g", active: true });
    const request: DynamoDBPageRequest = { model: "filtered", where: [eq("group", "g"), eq("active", true)], limit: 1, select: ["id"] };
    const first = await paginator.findPage(request);
    expect(first.items).toEqual([]);
    expect(first.nextCursor).not.toBeNull();
    const second = await paginator.findPage({ ...request, cursor: first.nextCursor! });
    expect(second.items).toEqual([]);
    expect(second.nextCursor).not.toBeNull();
    const third = await paginator.findPage({ ...request, cursor: second.nextCursor! });
    expect(third.items).toEqual([{ id: "c" }]);
    // Some engines return LEK on an exactly full final page; continue until absent.
    if (third.nextCursor) expect(await paginator.findPage({ ...request, cursor: third.nextCursor })).toEqual({ items: [], nextCursor: null });
    await expect(paginator.findPage({ ...request, where: [eq("group", "other")], cursor: first.nextCursor! })).rejects.toThrow(/query-mismatched/);
  });

  it("uses encoded length-prefix order rather than lexical id order and supports exact id access", async () => {
    for (const id of ["z", "aa", "é", "#"]) await store.create("encoded", { id, group: "g" });
    const page = await paginator.findPage<{ id: string }>({ model: "encoded", where: [eq("group", "g")], limit: 10 });
    expect(page.items.map((row) => row.id)).toEqual(["#", "z", "aa", "é"]);
    expect(await paginator.findPage({ model: "encoded", where: [eq("id", "é")], limit: 10 })).toEqual({ items: [{ id: "é", group: "g" }], nextCursor: null });
    expect(await paginator.findPage({ model: "encoded", where: [eq("id", "missing")], limit: 10 })).toEqual({ items: [], nextCursor: null });
    await expect(paginator.findPage({ model: "encoded", where: [], limit: 10 })).rejects.toThrow(/scan/);
    await expect(paginator.findPage({ model: "encoded", where: [eq("group", "g")], limit: 10, sortBy: { field: "id", direction: "asc" } as never })).rejects.toThrow(/native encoded key/);
  });
});
