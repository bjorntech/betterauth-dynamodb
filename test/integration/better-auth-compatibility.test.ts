import { CreateTableCommand, DeleteTableCommand, DynamoDBClient, ListTablesCommand, ResourceNotFoundException, waitUntilTableExists } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dynamoDBAdapter } from "../../src/index.js";
import { entitySk, modelPk } from "../../src/keys.js";

const tableName = `betterauth_compatibility_${crypto.randomUUID().replaceAll("-", "")}`;
const port = 8000;
let container: StartedTestContainer;
let nativeClient: DynamoDBClient;
let client: DynamoDBDocumentClient;

describe("Better Auth 1.7.16 compatibility", () => {
  beforeAll(async () => {
    container = await new GenericContainer("amazon/dynamodb-local:2.6.1")
      .withExposedPorts(port)
      .withCommand(["-jar", "DynamoDBLocal.jar", "-inMemory", "-sharedDb", "-disableTelemetry"])
      .withWaitStrategy(Wait.forListeningPorts())
      .start();
    const endpoint = `http://${container.getHost()}:${container.getMappedPort(port)}`;
    nativeClient = new DynamoDBClient({ region: "us-east-1", endpoint, credentials: { accessKeyId: "fake", secretAccessKey: "fake" } });
    client = DynamoDBDocumentClient.from(nativeClient, { marshallOptions: { removeUndefinedValues: true } });
    await nativeClient.send(new ListTablesCommand({}));
    await nativeClient.send(new CreateTableCommand({
      TableName: tableName,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "S" }],
      KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }]
    }));
    await waitUntilTableExists({ client: nativeClient, maxWaitTime: 30 }, { TableName: tableName });
  });

  afterAll(async () => {
    try { await nativeClient?.send(new DeleteTableCommand({ TableName: tableName })); } catch (error) { if (!(error instanceof ResourceNotFoundException)) throw error; }
    client?.destroy();
    nativeClient?.destroy();
    await container?.stop();
  });

  it("preserves opaque, non-UUID invitation IDs through the organization auth flow", async () => {
    let invitationNumber = 0;
    const auth = makeAuth({ advanced: { database: { generateId: ({ model }: { model: string }) => model === "invitation" ? `opaque-invitation-${++invitationNumber}` : randomUUID() } } });
    const cookie = await signUp(auth, "owner@example.com");
    const organizationResult = await auth.api.createOrganization({ body: { name: "Opaque IDs", slug: "opaque-ids" }, headers: { cookie } });
    const invitation = await auth.api.createInvitation({ body: { email: "invitee@example.com", role: "member", organizationId: organizationResult.id }, headers: { cookie } });

    expect(invitation.id).toMatch(/^opaque-invitation-/);
    expect(invitation.id).not.toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
    await expect(auth.api.listUserInvitations({ query: { email: "invitee@example.com" } })).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: invitation.id })]));
  });

  it("matches invitation email equality exactly, without leaking accent-distinct identities", async () => {
    const auth = makeAuth();
    const adapter = dynamoDBAdapter({ tableName, client, unsafeAllowScan: true })({ secret: "test-secret-that-is-long-enough-for-better-auth", plugins: [organization()] } as never);
    await adapter.create({ model: "invitation", data: { id: "accent-a", email: "josé@example.com", organizationId: "org", role: "member", status: "pending", expiresAt: new Date(Date.now() + 86_400_000) }, forceAllowId: true });
    await adapter.create({ model: "invitation", data: { id: "accent-b", email: "jose@example.com", organizationId: "org", role: "member", status: "pending", expiresAt: new Date(Date.now() + 86_400_000) }, forceAllowId: true });

    await expect(auth.api.listUserInvitations({ query: { email: "josé@example.com" } })).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: "accent-a", email: "josé@example.com" })]));
    await expect(auth.api.listUserInvitations({ query: { email: "josé@example.com" } })).resolves.not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "accent-b" })]));
  });

  it("keeps returned timestamp milliseconds while storing TTL metadata in seconds", async () => {
    const adapter = dynamoDBAdapter({ tableName, client, ttl: { fields: { session: "expiresAt" } } })({ secret: "test-secret-that-is-long-enough-for-better-auth" } as never);
    const expiresAt = new Date("2035-04-05T06:07:08.901Z");
    const created = await adapter.create({ model: "session", data: { id: "millis", userId: "user", token: "token-millis", expiresAt }, forceAllowId: true });
    expect(created.expiresAt).toEqual(expiresAt);
    const row = await client.send(new GetCommand({ TableName: tableName, Key: { pk: modelPk("session"), sk: entitySk("millis") } }));
    expect(row.Item?.ttl).toBe(Math.floor(expiresAt.getTime() / 1000));
  });
});

function makeAuth(options: Record<string, unknown> = {}) {
  return betterAuth({
    secret: "test-secret-that-is-long-enough-for-better-auth",
    baseURL: "http://localhost:3000",
    database: dynamoDBAdapter({ tableName, client, unsafeAllowScan: true }),
    emailAndPassword: { enabled: true },
    rateLimit: { enabled: false },
    plugins: [organization({ allowUserToCreateOrganization: true, sendInvitationEmail: async () => undefined })],
    ...options
  });
}

async function signUp(auth: ReturnType<typeof makeAuth>, email: string): Promise<string> {
  const response = await auth.handler(new Request("http://localhost:3000/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "password-123", name: "Owner" }) }));
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
}
