import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { createDynamoDBPaginator, DynamoDBAdapterError, UnsupportedQueryError } from "../src/index.js";
import type { CleanedWhere, DynamoDBPageRequest } from "../src/index.js";
import { entitySk, indexPk, indexSk, modelPk } from "../src/keys.js";
import { toIndexSidecars, toStoredItem } from "../src/serialize.js";

const eq = (field: string, value: CleanedWhere["value"]): CleanedWhere => ({ field, value, operator: "eq", mode: "sensitive" });
const base: DynamoDBPageRequest = { model: "user", where: [eq("group", "a")], limit: 1 };
const key = { pk: indexPk("user", "group", "a"), sk: indexSk("a") };
const token = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

function harness() {
  const send = vi.fn<(command: any) => Promise<any>>().mockResolvedValue({});
  const options = { tableName: "auth", client: { send } as never };
  return { send, options, paginator: createDynamoDBPaginator(options) };
}

describe("public cursor paginator", () => {
  it("reads exactly one keyed page and resumes using LastEvaluatedKey, not an offset", async () => {
    const { send, paginator } = harness();
    send.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: key }).mockResolvedValueOnce({ Items: [], LastEvaluatedKey: {} });
    const first = await paginator.findPage(base);
    expect(first).toEqual({ items: [], nextCursor: expect.any(String) });
    expect(send.mock.calls[0]![0]).toBeInstanceOf(QueryCommand);
    expect(send.mock.calls[0]![0].input).toEqual({ TableName: "auth", KeyConditionExpression: "#pk = :pk", ExpressionAttributeNames: { "#pk": "pk" }, ExpressionAttributeValues: { ":pk": key.pk }, ConsistentRead: true, Limit: 1, ScanIndexForward: true, ExclusiveStartKey: undefined });
    expect(await paginator.findPage({ ...base, limit: 2, cursor: first.nextCursor! })).toEqual({ items: [], nextCursor: null });
    expect(send.mock.calls[1]![0].input.ExclusiveStartKey).toEqual(key);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("hydrates owners, rejects missing, expired and stale sidecars, applies residual filters and projection", async () => {
    const { send, options } = harness();
    const rows = [
      toStoredItem("user", { id: "a", group: "a", active: true }),
      toStoredItem("user", { id: "b", group: "a", active: false }),
      toStoredItem("user", { id: "c", group: "other", active: true }),
      { ...toStoredItem("user", { id: "d", group: "a", active: true }), ttl: 1 },
      undefined
    ];
    const sidecars = ["a", "b", "c", "d", "e"].flatMap((id) => toIndexSidecars("user", { id, group: "a" }).filter((row) => row.indexField === "group"));
    send.mockImplementation(async (command: any) => command instanceof QueryCommand ? { Items: sidecars } : { Item: rows.find((row) => row?.sk === command.input.Key.sk) });
    const paginator = createDynamoDBPaginator({ ...options, ttl: { defaultField: "expiresAt" } });
    expect(await paginator.findPage({ ...base, where: [...base.where, eq("active", true)], select: ["id"] })).toEqual({ items: [{ id: "a" }], nextCursor: null });
    expect(send.mock.calls.slice(1).every(([command]) => command instanceof GetCommand && command.input.ConsistentRead)).toBe(true);
  });

  it("supports exact id Query, desc direction and TTL filtering without owner reads", async () => {
    const { send, options } = harness();
    const request: DynamoDBPageRequest = { model: "user", where: [eq("id", "a")], limit: 2, sortBy: { field: "key", direction: "desc" } };
    const entityKey = { pk: modelPk("user"), sk: entitySk("a") };
    send.mockResolvedValueOnce({ Items: [toStoredItem("user", { id: "a" })], LastEvaluatedKey: entityKey });
    const paginator = createDynamoDBPaginator(options);
    const first = await paginator.findPage(request);
    expect(first.items).toEqual([{ id: "a" }]);
    expect(send.mock.calls[0]![0].input).toMatchObject({ KeyConditionExpression: "#pk = :pk AND #sk = :sk", ScanIndexForward: false, ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" }, ExpressionAttributeValues: { ":pk": entityKey.pk, ":sk": entityKey.sk } });
    send.mockResolvedValue({ Items: [{ ...toStoredItem("user", { id: "a" }), ttl: 1 }] });
    expect((await paginator.findPage({ ...request, cursor: first.nextCursor! })).items).toHaveLength(1);
    expect((await createDynamoDBPaginator({ ...options, ttl: {} }).findPage(request)).items).toEqual([]);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid limit %s before reads", async (limit) => {
    const { send, paginator } = harness();
    await expect(paginator.findPage({ ...base, limit })).rejects.toThrow(DynamoDBAdapterError);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    { where: [] },
    { where: [{ ...eq("group", "a"), mode: "insensitive" }] },
    { where: [eq("group", "a"), { ...eq("id", "a"), connector: "OR" }] },
    { where: [{ ...eq("group", ["a", "b"]), operator: "in" }] },
    { sortBy: { field: "id", direction: "asc" } },
    { sortBy: { field: "key", direction: "up" } }
  ])("rejects unsupported query/sort shapes even when scans are opted in: %j", async (change) => {
    const { send, options } = harness();
    await expect(createDynamoDBPaginator({ ...options, unsafeAllowScan: true }).findPage({ ...base, ...change } as DynamoDBPageRequest)).rejects.toThrow(UnsupportedQueryError);
    expect(send).not.toHaveBeenCalled();
  });

  it("binds cursors to table/model/predicates/direction/projection/TTL and typed dates", async () => {
    const { send, options, paginator } = harness();
    send.mockResolvedValue({ LastEvaluatedKey: key });
    const cursor = (await paginator.findPage(base)).nextCursor!;
    const changes = [{ model: "session" }, { where: [eq("group", "b")] }, { where: [...base.where, eq("active", true)] }, { sortBy: { field: "key", direction: "desc" } }, { select: ["id"] }];
    for (const change of changes) await expect(paginator.findPage({ ...base, ...change, cursor } as DynamoDBPageRequest)).rejects.toThrow(/query-mismatched/);
    for (const change of [{ tableName: "other" }, { ttl: {} }]) await expect(createDynamoDBPaginator({ ...options, ...change }).findPage({ ...base, cursor })).rejects.toThrow(/query-mismatched/);
    const dateRequest = { ...base, where: [eq("group", new Date("2030-01-01")), { ...eq("extra", ["a"]), operator: "in" as const }] };
    send.mockResolvedValue({ LastEvaluatedKey: { ...key, pk: indexPk("user", "group", new Date("2030-01-01")) } });
    const dateCursor = (await paginator.findPage(dateRequest)).nextCursor!;
    await expect(paginator.findPage({ ...dateRequest, where: [eq("group", "2030-01-01T00:00:00.000Z")], cursor: dateCursor })).rejects.toThrow(/query-mismatched/);
  });

  it("validates cursor encoding, version, key shape, partition and canonical length-prefix bytes", async () => {
    const { send, paginator } = harness();
    send.mockResolvedValue({ LastEvaluatedKey: key });
    const cursor = (await paginator.findPage(base)).nextCursor!;
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString());
    const invalid = ["", "!", "a".repeat(32769), "a", token(null), token({}), token({ ...decoded, v: 2 }), token({ ...decoded, key: null }), token({ ...decoded, key: { ...key, extra: true } }), token({ ...decoded, key: { ...key, pk: "other" } }), token({ ...decoded, key: { ...key, sk: 1 } }), token({ ...decoded, key: { ...key, sk: "OWNER#s01:a" } }), token({ ...decoded, key: { ...key, sk: "OWNER#s1:é" } }), token({ ...decoded, key: { ...key, sk: `OWNER#s1025:${"a".repeat(1025)}` } }), token({ ...decoded, key: { ...key, sk: entitySk("a") } }), 5];
    send.mockClear();
    for (const bad of invalid) await expect(paginator.findPage({ ...base, cursor: bad as string })).rejects.toThrow(/Invalid or query-mismatched/);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects id cursor keys outside the exact equality and propagates AWS errors", async () => {
    const { send, paginator } = harness();
    const request = { ...base, where: [eq("id", "a")] };
    send.mockResolvedValue({ LastEvaluatedKey: { pk: modelPk("user"), sk: entitySk("a") } });
    const cursor = (await paginator.findPage(request)).nextCursor!;
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString());
    await expect(paginator.findPage({ ...request, cursor: token({ ...decoded, key: { ...decoded.key, sk: entitySk("b") } }) })).rejects.toThrow(/Invalid/);
    send.mockRejectedValue(new Error("AWS unavailable"));
    await expect(paginator.findPage(base)).rejects.toThrow("AWS unavailable");
  });

  it("round-trips unicode/delimiter keys and preserves Query order despite out-of-order owner reads", async () => {
    const { send, paginator } = harness();
    const ids = ["a", "é#"];
    const sidecars = ids.flatMap((id) => toIndexSidecars("user", { id, group: "a" }).filter((row) => row.indexField === "group"));
    const unicodeKey = { pk: key.pk, sk: indexSk("é#") };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    send.mockImplementation(async (command: any) => {
      if (command instanceof QueryCommand) return { Items: sidecars, LastEvaluatedKey: unicodeKey };
      const id = command.input.Key.sk === entitySk("a") ? "a" : "é#";
      if (id === "a") await gate;
      else release();
      return { Item: toStoredItem("user", { id, group: "a" }) };
    });
    const page = await paginator.findPage<{ id: string }>(base);
    expect(page.items.map((row) => row.id)).toEqual(ids);
    send.mockResolvedValue({});
    expect(await paginator.findPage({ ...base, cursor: page.nextCursor! })).toEqual({ items: [], nextCursor: null });
    expect(send.mock.lastCall![0].input.ExclusiveStartKey).toEqual(unicodeKey);
  });

  it("keeps companion instances isolated and round-trips heavily escaped maximum-size keys", async () => {
    const first = harness();
    const second = harness();
    const other = createDynamoDBPaginator({ ...second.options, tableName: "other" });
    const model = "\u0001".repeat(2000);
    const id = "\u0002".repeat(1000);
    const request = { ...base, model, where: [eq("id", id)] };
    const hugeKey = { pk: modelPk(model), sk: entitySk(id) };
    first.send.mockResolvedValue({ LastEvaluatedKey: hugeKey });
    const page = await first.paginator.findPage(request);
    expect(page.nextCursor!.length).toBeGreaterThan(16384);
    await other.findPage(base);
    first.send.mockResolvedValue({});
    await first.paginator.findPage({ ...request, cursor: page.nextCursor! });
    expect(first.send.mock.calls.map(([command]) => command.input.TableName)).toEqual(["auth", "auth"]);
    expect(first.send.mock.lastCall![0].input.ExclusiveStartKey).toEqual(hugeKey);
    expect(second.send.mock.calls.map(([command]) => command.input.TableName)).toEqual(["other"]);
  });
});
