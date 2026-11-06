import { describe, expect, it, vi } from "vitest";
import type { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { createDocumentClient, normalizeOptions } from "../src/client.js";
import { DynamoDBAdapterError, DynamoDBConflictError, UnsupportedQueryError, dynamoDBAdapter } from "../src/index.js";
import { uniquePk, valueSk } from "../src/keys.js";
import { REVISION_ATTRIBUTE } from "../src/serialize.js";

describe("public adapter and client helpers", () => {
  it("normalizes option defaults and builds a document client", () => {
    expect(normalizeOptions({ tableName: "auth" })).toMatchObject({ maxPages: 25, unsafeAllowScan: false });
    expect(normalizeOptions({ tableName: "auth", pageSize: 10, maxPages: 2 })).toMatchObject({ pageSize: 10, maxPages: 2 });
    expect(createDocumentClient({ tableName: "auth", region: "us-east-1", endpoint: "http://localhost:8000" })).toBeTruthy();
  });

  it.each(["maxPages", "pageSize"] as const)("rejects invalid %s values", (name) => {
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => normalizeOptions({ tableName: "auth", [name]: value })).toThrow(DynamoDBAdapterError);
      expect(() => normalizeOptions({ tableName: "auth", [name]: value })).toThrow(new RegExp(`${name} must be a positive safe integer`));
    }
  });

  it("never sidecar-indexes Better Auth account secrets by default, including remapped names", async () => {
    const writes: TransactWriteCommand[] = [];
    const send = async (command: any) => {
      if (command.constructor.name === "TransactWriteCommand") writes.push(command);
      return {};
    };
    const adapter = dynamoDBAdapter({ tableName: "auth", client: { send } as never })({ secret: "x", emailAndPassword: { enabled: true }, account: { fields: { accessToken: "access_token" } } } as never);
    await adapter.create({ model: "account", data: { userId: "u", providerId: "google", accountId: "g", password: "hash", accessToken: "at", refreshToken: "rt", idToken: "it", createdAt: new Date(), updatedAt: new Date() } });
    const items = (writes[0]?.input.TransactItems ?? []).map((item) => item.Put?.Item as Record<string, unknown>);
    const indexed = items.filter((item) => item.model === "_index_account").map((item) => item.indexField);
    expect(indexed).toEqual(expect.arrayContaining(["userId", "providerId", "accountId"]));
    expect(indexed).not.toEqual(expect.arrayContaining(["password"]));
    for (const field of ["password", "access_token", "accessToken", "refreshToken", "idToken"]) expect(indexed).not.toContain(field);
  });

  it("creates a Better Auth adapter factory", async () => {
    const send = async (command: any) => {
      if (command.constructor.name === "GetCommand") return { Item: { pk: "MODEL#s4:user", sk: "ID#s1:u", id: "u", [REVISION_ATTRIBUTE]: "rev-1", entity: { id: "u", email: "a@example.com", emailVerified: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } } };
      if (command.constructor.name === "QueryCommand") return { Items: [] };
      if (command.constructor.name === "UpdateCommand") return { Attributes: { id: "u", entity: { id: "u" } } };
      return {};
    };
    const adapter = dynamoDBAdapter({ tableName: "auth", client: { send } as never })({ secret: "x", emailAndPassword: { enabled: true } } as never);
    expect(adapter.id).toBe("betterauth-dynamodb");
    expect(adapter.options?.tableName).toBe("auth");
    await adapter.findOne({ model: "user", where: [{ field: "id", value: "u" }] });
    await adapter.findMany({ model: "user", where: [{ field: "email", value: "a@example.com" }], limit: 1 });
    await adapter.count({ model: "user", where: [{ field: "email", value: "a@example.com" }] });
    await adapter.update({ model: "user", where: [{ field: "id", value: "u" }], update: { name: "A" } });
    await adapter.delete({ model: "user", where: [{ field: "id", value: "u" }] });
    await adapter.deleteMany({ model: "user", where: [{ field: "email", value: "a@example.com" }] });
    await adapter.consumeOne({ model: "user", where: [{ field: "id", value: "u" }] });
  });

  it.each([
    ["model remapping", { modelName: "app_user" }, "app_user", "email"],
    ["field remapping", { fields: { email: "email_address" } }, "user", "email_address"],
    ["model and field remapping", { modelName: "app_user", fields: { email: "email_address" } }, "app_user", "email_address"]
  ] as const)("derives unique locks from transformed schema names for %s", async (_label, userConfig, storedModel, storedField) => {
    const send = vi.fn(async (command: unknown) => {
      void command;
      return {};
    });
    const doc = { send };
    const adapter = dynamoDBAdapter({ tableName: "auth", client: doc as never })({ secret: "x", emailAndPassword: { enabled: true }, user: userConfig } as never);

    await adapter.create({ model: "user", data: { id: "u1", email: "same@example.com", name: "Ada" }, forceAllowId: true });

    const command = send.mock.calls[0]?.[0] as TransactWriteCommand;
    expect(command.input.TransactItems).toContainEqual(expect.objectContaining({ Put: expect.objectContaining({ Item: expect.objectContaining({ pk: uniquePk(storedModel, storedField), sk: valueSk("same@example.com", "") }) }) }));
  });

  it("treats manual uniqueFields as transformed DynamoDB model and field names", async () => {
    const send = vi.fn(async (command: unknown) => {
      void command;
      return {};
    });
    const doc = { send };
    const adapter = dynamoDBAdapter({ tableName: "auth", client: doc as never, uniqueFields: { app_user: ["handle"] } })({ secret: "x", user: { modelName: "app_user", additionalFields: { username: { type: "string", required: true, fieldName: "handle" } } } } as never);

    await adapter.create({ model: "user", data: { id: "u1", name: "Ada", email: "a@example.com", emailVerified: true, username: "ada" }, forceAllowId: true });

    const command = send.mock.calls[0]?.[0] as TransactWriteCommand;
    expect(command.input.TransactItems).toContainEqual(expect.objectContaining({ Put: expect.objectContaining({ Item: expect.objectContaining({ pk: uniquePk("app_user", "handle"), sk: valueSk("ada", "") }) }) }));
    expect(command.input.TransactItems).not.toContainEqual(expect.objectContaining({ Put: expect.objectContaining({ Item: expect.objectContaining({ pk: uniquePk("user", "username") }) }) }));
  });

  it("projects selected fields using transformed storage names", async () => {
    const send = vi.fn(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === "ScanCommand") return { Items: [{ pk: "MODEL#s8:app_user", sk: "ID#s2:u1", id: "u1", email_address: "a@example.com", name: "Ada", [REVISION_ATTRIBUTE]: "rev-1", entity: { id: "u1", email_address: "a@example.com", name: "Ada" } }] };
      return {};
    });
    const adapter = dynamoDBAdapter({ tableName: "auth", client: { send } as never, unsafeAllowScan: true })({ secret: "x", user: { modelName: "app_user", fields: { email: "email_address" } } } as never);

    const [result] = (await adapter.findMany({ model: "user", select: ["id", "email"], limit: 1 })) as Record<string, unknown>[];

    expect(result).toMatchObject({ id: "u1", email: "a@example.com" });
    expect(result?.name).toBeUndefined();
  });

  it("rejects duplicate creates through mapped schema unique locks", async () => {
    const duplicate = Object.assign(new Error("duplicate"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "None" }, { Code: "ConditionalCheckFailed" }] });
    const send = vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(duplicate);
    const adapter = dynamoDBAdapter({ tableName: "auth", client: { send } as never })({ secret: "x", emailAndPassword: { enabled: true }, user: { modelName: "app_user", fields: { email: "email_address" } } } as never);

    await adapter.create({ model: "user", data: { id: "u1", email: "same@example.com", name: "Ada" }, forceAllowId: true });
    await expect(adapter.create({ model: "user", data: { id: "u2", email: "same@example.com", name: "Grace" }, forceAllowId: true })).rejects.toBeInstanceOf(DynamoDBConflictError);

    const command = send.mock.calls[1]?.[0] as TransactWriteCommand;
    expect(command.input.TransactItems).toContainEqual(expect.objectContaining({ Put: expect.objectContaining({ Item: expect.objectContaining({ pk: uniquePk("app_user", "email_address"), sk: valueSk("same@example.com", "") }) }) }));
  });

  it("rejects experimental native joins while leaving fallback joins to Better Auth", async () => {
    const send = vi.fn(async () => ({ Items: [] }));
    const adapter = dynamoDBAdapter({ tableName: "auth", client: { send } as never })({ secret: "x", advanced: { database: { joins: true } }, emailAndPassword: { enabled: true } } as never);

    await expect(adapter.findMany({ model: "session", where: [{ field: "userId", value: "u1" }], limit: 1, join: { user: true } } as never)).rejects.toBeInstanceOf(UnsupportedQueryError);
    expect(send).not.toHaveBeenCalled();
  });
});
