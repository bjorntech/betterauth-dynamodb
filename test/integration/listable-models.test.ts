import { CreateTableCommand, DeleteTableCommand, DynamoDBClient, ListTablesCommand, ResourceNotFoundException, waitUntilTableExists } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { dynamoDBAdapter } from "../../src/index.js";
import type { BetterAuthDynamoDBOptions } from "../../src/index.js";
import { listablePk, listableSk } from "../../src/keys.js";

const IMAGE = "amazon/dynamodb-local:2.6.1";
const REGION = "us-east-1";
const PORT = 8000;
type TestAdapter = ReturnType<ReturnType<typeof dynamoDBAdapter>>;
type Where = { field: string; value: string | number | null; operator: "eq"; connector: "AND"; mode: "sensitive" };

let container: StartedTestContainer;
let nativeClient: DynamoDBClient;
let docClient: DynamoDBDocumentClient;
let tableName: string;
let endpoint: string;

const eq = (field: string, value: string | number | null): Where => ({ field, value, operator: "eq", connector: "AND", mode: "sensitive" });

describe("listable model integration", () => {
  beforeAll(async () => {
    container = await new GenericContainer(IMAGE).withExposedPorts(PORT).withCommand(["-jar", "DynamoDBLocal.jar", "-inMemory", "-sharedDb", "-disableTelemetry"]).withWaitStrategy(Wait.forListeningPorts()).start();
    endpoint = `http://${container.getHost()}:${container.getMappedPort(PORT)}`;
    nativeClient = new DynamoDBClient({ region: REGION, endpoint, credentials: { accessKeyId: "fake", secretAccessKey: "fake" } });
    docClient = DynamoDBDocumentClient.from(nativeClient, { marshallOptions: { removeUndefinedValues: true } });
    await waitForDynamoDBLocal();
  });

  afterAll(async () => {
    await nativeClient?.destroy();
    await container?.stop();
  });

  beforeEach(async () => {
    tableName = `betterauth_dynamodb_listable_${randomUUID().replaceAll("-", "")}`;
    await createTable(tableName);
  });

  afterEach(async () => {
    await deleteTable(tableName);
  });

  it("keeps membership current through update, increment, consume, delete, and deleteMany", async () => {
    const adapter = adapterFor({ listableModels: ["jwks"], ttl: { fields: { jwks: "expiresAt" } } });
    await create(adapter, "jwks", { id: "k1", key: "one", hits: 1, expiresAt: "2030-01-01T00:00:00.000Z" });
    await create(adapter, "jwks", { id: "k2", key: "two", hits: 1, expiresAt: "2030-01-01T00:00:00.000Z" });
    await expect(adapter.findMany({ model: "jwks", where: [], limit: 10 })).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: "k1" }), expect.objectContaining({ id: "k2" })]));

    await expect(adapter.update({ model: "jwks", where: [eq("id", "k1")], update: { key: "updated" } })).resolves.toMatchObject({ id: "k1" });
    await expect(adapter.findOne({ model: "jwks", where: [eq("id", "k1")] })).resolves.toMatchObject({ key: "updated" });
    await expect(adapter.incrementOne({ model: "jwks", where: [eq("id", "k1")], increment: { hits: 2 } })).resolves.toMatchObject({ hits: 3 });

    await expect(adapter.consumeOne({ model: "jwks", where: [eq("id", "k2")] })).resolves.toMatchObject({ id: "k2" });
    await expect(adapter.findMany({ model: "jwks", where: [], limit: 10 })).resolves.toEqual([expect.objectContaining({ id: "k1" })]);
    await adapter.delete({ model: "jwks", where: [eq("id", "k1")] });
    await expect(adapter.findMany({ model: "jwks", where: [], limit: 10 })).resolves.toEqual([]);

    await create(adapter, "jwks", { id: "k3", key: "three" });
    await create(adapter, "jwks", { id: "k4", key: "four" });
    await expect(adapter.deleteMany({ model: "jwks", where: [] })).resolves.toBe(2);
    await expect(adapter.findMany({ model: "jwks", where: [], limit: 10 })).resolves.toEqual([]);
    await expect(rawRowsByModel("_listable_jwks")).resolves.toEqual([]);
  });

  it("updates membership TTL and hides expired owners without stale list results", async () => {
    const adapter = adapterFor({ listableModels: ["jwks"], ttl: { fields: { jwks: "expiresAt" } } });
    await create(adapter, "jwks", { id: "ttl", key: "ttl", expiresAt: "2030-01-01T00:00:00.000Z" });

    await expect(adapter.update({ model: "jwks", where: [eq("id", "ttl")], update: { expiresAt: "2031-01-01T00:00:00.000Z" } })).resolves.toMatchObject({ id: "ttl" });
    await expect(rawRow(listablePk("jwks"), listableSk("ttl"))).resolves.toMatchObject({ ttl: 1924992000 });
    await expect(adapter.findMany({ model: "jwks", where: [], limit: 10 })).resolves.toEqual([expect.objectContaining({ id: "ttl" })]);

    await adapter.update({ model: "jwks", where: [eq("id", "ttl")], update: { expiresAt: "2000-01-01T00:00:00.000Z" } });
    await expect(adapter.findMany({ model: "jwks", where: [], limit: 10 })).resolves.toEqual([]);
  });

  it("reads all listable membership pages and rejects an exhausted maxPages budget", async () => {
    const adapter = adapterFor({ listableModels: ["jwks"], pageSize: 1, maxPages: 10 });
    for (let index = 0; index < 5; index += 1) await create(adapter, "jwks", { id: `page-${index}`, key: `key-${index}` });
    await expect(adapter.findMany({ model: "jwks", where: [], limit: 10 })).resolves.toHaveLength(5);

    const limited = adapterFor({ listableModels: ["jwks"], pageSize: 1, maxPages: 2 });
    await expect(limited.findMany({ model: "jwks", where: [], limit: 10 })).rejects.toThrow(/exceeded maxPages/);
  });
});

function adapterFor(options: Omit<BetterAuthDynamoDBOptions, "tableName">): TestAdapter {
  return dynamoDBAdapter({ tableName, client: docClient, ...options })({
    secret: "test-secret",
    plugins: [{ id: "listable-schema", schema: { jwks: { fields: { key: { type: "string", required: true }, hits: { type: "number", required: false }, expiresAt: { type: "string", required: false } } } } }]
  } as never) as TestAdapter;
}

function create(adapter: TestAdapter, model: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
  return adapter.create({ model, data, forceAllowId: true }) as Promise<Record<string, unknown>>;
}

async function waitForDynamoDBLocal(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { await nativeClient.send(new ListTablesCommand({})); return; } catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  await nativeClient.send(new ListTablesCommand({}));
}

async function createTable(name: string): Promise<void> {
  await nativeClient.send(new CreateTableCommand({ TableName: name, BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "S" }], KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }] }));
  await waitUntilTableExists({ client: nativeClient, maxWaitTime: 30 }, { TableName: name });
}

async function deleteTable(name: string): Promise<void> {
  try { await nativeClient.send(new DeleteTableCommand({ TableName: name })); } catch (error) { if (!(error instanceof ResourceNotFoundException)) throw error; }
}

async function rawRow(pk: string, sk: string): Promise<Record<string, unknown> | undefined> {
  const result = await docClient.send(new GetCommand({ TableName: tableName, Key: { pk, sk }, ConsistentRead: true }));
  return result.Item;
}

async function rawRowsByModel(model: string): Promise<Record<string, unknown>[]> {
  const result = await docClient.send(new ScanCommand({ TableName: tableName, ConsistentRead: true, FilterExpression: "#model = :model", ExpressionAttributeNames: { "#model": "model" }, ExpressionAttributeValues: { ":model": model } }));
  return result.Items ?? [];
}
