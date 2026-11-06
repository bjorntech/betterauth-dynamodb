import { CreateTableCommand, DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins/email-otp";
import { dynamoDBAdapter } from "../../src/index.js";
import type { BetterAuthDynamoDBOptions } from "../../src/index.js";

// Better Auth core flows with production-shaped adapter options: no unsafeAllowScan, a tiny
// page budget (so any partition fan-out fails loudly), TTL with cleanup disabled, and the
// core-only sidecar allowlist documented in the README.
const IMAGE = "amazon/dynamodb-local:2.6.1";
const REGION = "us-east-1";
const PORT = 8000;
const BASE_URL = "http://localhost:3000";

const CORE_INDEXED_FIELDS = {
  user: ["email"],
  session: ["token", "userId"],
  account: ["userId", "providerId", "accountId"],
  verification: ["identifier"],
  rateLimit: ["key"]
};

let container: StartedTestContainer;
let nativeClient: DynamoDBClient;
let docClient: DynamoDBDocumentClient;
let tableName: string;

type Identity = { id: string; email: string; name: string };
const identities = new Map<string, Identity>();

describe("Better Auth core flows under production defaults", () => {
  beforeAll(async () => {
    container = await new GenericContainer(IMAGE)
      .withExposedPorts(PORT)
      .withCommand(["-jar", "DynamoDBLocal.jar", "-inMemory", "-sharedDb", "-disableTelemetry"])
      .withWaitStrategy(Wait.forListeningPorts())
      .start();
    const endpoint = `http://${container.getHost()}:${container.getMappedPort(PORT)}`;
    nativeClient = new DynamoDBClient({ region: REGION, endpoint, credentials: { accessKeyId: "fake", secretAccessKey: "fake" } });
    docClient = DynamoDBDocumentClient.from(nativeClient, { marshallOptions: { removeUndefinedValues: true } });
    await waitForDynamoDBLocal(nativeClient);
  });

  afterAll(async () => {
    await nativeClient?.destroy();
    await container?.stop();
  });

  beforeEach(async () => {
    tableName = `betterauth_prod_${randomUUID().replaceAll("-", "")}`;
    await nativeClient.send(new CreateTableCommand({ TableName: tableName, BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "S" }], KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }] }));
    identities.clear();
  });

  it("signs up, signs in, lists, revokes, changes password, and signs out with email/password", async () => {
    const auth = createAuth();
    expect((await auth.handler(post("/api/auth/sign-up/email", { email: "pw@example.com", password: "password-123", name: "PW" }))).status).toBe(200);
    const first = await signIn(auth, "pw@example.com", "password-123");
    const second = await signIn(auth, "pw@example.com", "password-123");

    await expect(getSession(auth, first)).resolves.toMatchObject({ user: { email: "pw@example.com" } });
    await expect(json(auth, get("/api/auth/list-sessions", first))).resolves.toHaveLength(3);

    expect((await auth.handler(post("/api/auth/revoke-other-sessions", {}, first))).status).toBe(200);
    await expect(getSession(auth, second)).resolves.toBeNull();

    expect((await auth.handler(post("/api/auth/change-password", { currentPassword: "password-123", newPassword: "password-456" }, first))).status).toBe(200);
    expect((await auth.handler(post("/api/auth/sign-in/email", { email: "pw@example.com", password: "password-123" }))).status).toBe(401);
    const third = await signIn(auth, "pw@example.com", "password-456");

    expect((await auth.handler(post("/api/auth/sign-out", {}, third))).status).toBe(200);
    await expect(getSession(auth, third)).resolves.toBeNull();
  });

  it("resets a password through a verification row and consumes the token once", async () => {
    const sent: string[] = [];
    const auth = createAuth({ emailAndPassword: { enabled: true, sendResetPassword: async ({ token }: { token: string }) => void sent.push(token) } });
    await auth.handler(post("/api/auth/sign-up/email", { email: "reset@example.com", password: "password-123", name: "R" }));

    expect((await auth.handler(post("/api/auth/request-password-reset", { email: "reset@example.com", redirectTo: "/reset" }))).status).toBe(200);
    expect(sent).toHaveLength(1);
    expect((await auth.handler(post("/api/auth/reset-password", { token: sent[0], newPassword: "password-789" }))).status).toBe(200);
    expect((await auth.handler(post("/api/auth/reset-password", { token: sent[0], newPassword: "password-000" }))).status).toBe(400);
    await signIn(auth, "reset@example.com", "password-789");
  });

  it("signs in natively with Google and Apple ID tokens, links by verified email, and scales past the page budget", async () => {
    const auth = createAuth();
    // More Google accounts than the page budget can drain: a providerId-anchored lookup would throw.
    for (let index = 0; index < 6; index += 1) {
      identities.set(`google-filler-${index}`, { id: `g-filler-${index}`, email: `filler-${index}@example.com`, name: `F${index}` });
      expect((await auth.handler(post("/api/auth/sign-in/social", { provider: "google", idToken: { token: `google-filler-${index}` } }))).status).toBe(200);
    }

    identities.set("google-alice", { id: "g-alice", email: "alice@example.com", name: "Alice" });
    const google = await socialSignIn(auth, "google", "google-alice");
    const again = await socialSignIn(auth, "google", "google-alice");
    identities.set("apple-alice", { id: "a-alice", email: "alice@example.com", name: "Alice" });
    const apple = await socialSignIn(auth, "apple", "apple-alice");

    const [googleSession, againSession, appleSession] = await Promise.all([getSession(auth, google), getSession(auth, again), getSession(auth, apple)]);
    expect(googleSession?.user.email).toBe("alice@example.com");
    expect(againSession?.user.id).toBe(googleSession?.user.id);
    expect(appleSession?.user.id).toBe(googleSession?.user.id);
    const accounts = (await json(auth, get("/api/auth/list-accounts", google))) as { providerId: string }[];
    expect(accounts.map((account) => account.providerId).sort()).toEqual(["apple", "google"]);
    await expect(rawUsers()).resolves.toHaveLength(7);
  });

  it("rejects a concurrent duplicate email sign-up atomically", async () => {
    const auth = createAuth();
    const results = await Promise.all([1, 2, 3].map(() => auth.handler(post("/api/auth/sign-up/email", { email: "race@example.com", password: "password-123", name: "Race" }))));
    expect(results.filter((result) => result.status === 200)).toHaveLength(1);
    await expect(rawUsers()).resolves.toHaveLength(1);
  });

  it("persists database rate limits and atomically rejects concurrent excess requests", async () => {
    const auth = createAuth({ rateLimit: { enabled: true, storage: "database", customRules: { "/api/auth/sign-in/email": { window: 60_000, max: 2 } } } });
    await auth.handler(post("/api/auth/sign-up/email", { email: "limited@example.com", password: "password-123", name: "Limited" }));
    const responses = await Promise.all(Array.from({ length: 4 }, () => auth.handler(post("/api/auth/sign-in/email", { email: "limited@example.com", password: "password-123" }))));
    expect(responses.filter((response) => response.status === 200)).toHaveLength(2);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(2);
    await expect(rawModel("rateLimit")).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ entity: expect.objectContaining({ key: expect.stringContaining("/sign-in/email"), count: 2 }) })]));
  });

  it("verifies an email through a single-use verification token", async () => {
    const sent: string[] = [];
    const auth = createAuth({ emailAndPassword: { enabled: true, requireEmailVerification: true }, emailVerification: { sendVerificationEmail: async ({ token }: { token: string }) => void sent.push(token) } });
    const signup = await auth.handler(post("/api/auth/sign-up/email", { email: "verify@example.com", password: "password-123", name: "Verify" }));
    expect(signup.status).toBe(200);
    expect(sent).toHaveLength(1);
    const token = sent[0]!;
    const first = await auth.handler(getVerification(token));
    expect(first.status).toBe(200);
    const verifiedSession = await signIn(auth, "verify@example.com", "password-123");
    expect((await getSession(auth, verifiedSession))?.user.emailVerified).toBe(true);
    // Better Auth's signed verification token is idempotent after the user is verified:
    // the second use is a no-op and cannot change or create another user.
    const second = await auth.handler(getVerification(token));
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({ status: true, user: null });
  });

  it("signs in with an email OTP exactly once", async () => {
    const otp = "246810";
    const sent: string[] = [];
    const auth = createAuth({ plugins: [emailOTP({ generateOTP: () => otp, sendVerificationOTP: async ({ otp: value }: { otp: string }) => void sent.push(value) })] });
    await auth.handler(post("/api/auth/sign-up/email", { email: "otp@example.com", password: "password-123", name: "OTP" }));
    expect((await auth.handler(post("/api/auth/email-otp/send-verification-otp", { email: "otp@example.com", type: "sign-in" }))).status).toBe(200);
    expect(sent).toEqual([otp]);
    const first = await auth.handler(post("/api/auth/sign-in/email-otp", { email: "otp@example.com", otp }));
    expect(first.status).toBe(200);
    expect((await auth.handler(post("/api/auth/sign-in/email-otp", { email: "otp@example.com", otp }))).status).toBe(400);
  });
});

function createAuth(overrides: Record<string, unknown> = {}) {
  const adapterOptions: BetterAuthDynamoDBOptions = { tableName, client: docClient, ttl: { fields: { session: "expiresAt", verification: "expiresAt" } }, indexedFields: CORE_INDEXED_FIELDS, cleanupNonIndexedSidecars: false, pageSize: 2, maxPages: 3 };
  return betterAuth({
    secret: "test-secret-that-is-long-enough-for-better-auth",
    baseURL: BASE_URL,
    database: dynamoDBAdapter(adapterOptions),
    emailAndPassword: { enabled: true },
    verification: { disableCleanup: true },
    rateLimit: { enabled: false },
    account: { accountLinking: { enabled: true, trustedProviders: ["google", "apple"] } },
    socialProviders: { google: idTokenProvider(), apple: idTokenProvider() },
    ...overrides
  } as never);
}

/** Stands in for the provider's ID-token verification so the full Better Auth social sign-in path runs offline. */
function idTokenProvider() {
  return {
    clientId: "test-client",
    clientSecret: "test-secret",
    verifyIdToken: async (token: string) => identities.has(token),
    getUserInfo: async (tokens: { idToken?: string }) => {
      const identity = identities.get(tokens.idToken ?? "");
      return identity ? { user: { id: identity.id, email: identity.email, name: identity.name, emailVerified: true }, data: { sub: identity.id, email: identity.email } } : null;
    }
  };
}

type Auth = ReturnType<typeof createAuth>;

async function signIn(auth: Auth, email: string, password: string): Promise<string> {
  const response = await auth.handler(post("/api/auth/sign-in/email", { email, password }));
  expect(response.status).toBe(200);
  return sessionCookie(response);
}

async function socialSignIn(auth: Auth, provider: string, token: string): Promise<string> {
  const response = await auth.handler(post("/api/auth/sign-in/social", { provider, idToken: { token } }));
  expect(response.status).toBe(200);
  return sessionCookie(response);
}

function sessionCookie(response: Response): string {
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  expect(cookie).toMatch(/^better-auth\.session_token=/);
  return cookie;
}

async function getSession(auth: Auth, cookie: string): Promise<{ user: { id: string; email: string; emailVerified?: boolean } } | null> {
  return (await json(auth, get("/api/auth/get-session", cookie))) as { user: { id: string; email: string; emailVerified?: boolean } } | null;
}

async function json(auth: Auth, request: Request): Promise<unknown> {
  const response = await auth.handler(request);
  expect(response.status).toBe(200);
  return response.json();
}

function post(path: string, body: Record<string, unknown>, cookie?: string): Request {
  return new Request(`${BASE_URL}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: BASE_URL, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
}

function get(path: string, cookie: string): Request {
  return new Request(`${BASE_URL}${path}`, { headers: { cookie } });
}

function getVerification(token: string): Request {
  return new Request(`${BASE_URL}/api/auth/verify-email?token=${encodeURIComponent(token)}`, { headers: { origin: BASE_URL } });
}

async function rawUsers(): Promise<Record<string, unknown>[]> {
  const result = await docClient.send(new ScanCommand({ TableName: tableName, ConsistentRead: true, FilterExpression: "#model = :model", ExpressionAttributeNames: { "#model": "model" }, ExpressionAttributeValues: { ":model": "user" } }));
  return result.Items ?? [];
}

async function rawModel(model: string): Promise<Record<string, unknown>[]> {
  const result = await docClient.send(new ScanCommand({ TableName: tableName, ConsistentRead: true, FilterExpression: "#model = :model", ExpressionAttributeNames: { "#model": "model" }, ExpressionAttributeValues: { ":model": model } }));
  return result.Items ?? [];
}

async function waitForDynamoDBLocal(client: DynamoDBClient): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await client.send(new ListTablesCommand({}));
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("DynamoDB Local did not become ready");
}
