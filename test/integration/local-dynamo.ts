import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  ListTablesCommand,
  ResourceInUseException,
  ResourceNotFoundException,
  waitUntilTableExists
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

export interface LocalDynamo {
  client: DynamoDBClient;
  docClient: DynamoDBDocumentClient;
  endpoint: string;
  stop(): Promise<void>;
}

/** Each invocation owns an in-memory Dynoxide process; callers own uniquely named tables. */
export async function startLocalDynamo(): Promise<LocalDynamo> {
  const port = await freeLoopbackPort();
  const endpoint = `http://127.0.0.1:${port}`;
  const executable = fileURLToPath(new URL("../../node_modules/dynoxide/bin/dynoxide", import.meta.url));
  const child = spawn(process.execPath, [executable, "serve", "--host", "127.0.0.1", "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let failure: Error | undefined;
  child.on("error", (error) => { failure = error; });
  child.stdout.on("data", (data: Buffer) => { output = (output + data.toString()).slice(-8192); });
  child.stderr.on("data", (data: Buffer) => { output = (output + data.toString()).slice(-8192); });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const client = new DynamoDBClient({
    region: "us-east-1",
    endpoint,
    credentials: { accessKeyId: "fake", secretAccessKey: "fake" },
    maxAttempts: 1,
    requestHandler: { connectionTimeout: 500, requestTimeout: 1000 }
  });
  const docClient = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  let stopping: Promise<void> | undefined;
  function stop(): Promise<void> {
    stopping ??= (async () => {
      client.destroy();
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGTERM"), 2000); // The CLI forwards a second signal as SIGKILL.
      try { await closed; } finally { clearTimeout(timer); }
    })();
    return stopping;
  }
  try {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (failure || child.exitCode !== null || child.signalCode !== null) break;
      try {
        await client.send(new ListTablesCommand({}));
        return { client, docClient, endpoint, stop };
      } catch {
        await delay(50);
      }
    }
    throw new Error(`Could not start local Dynoxide. Run bun install (including optional platform dependencies); see https://dynoxide.dev/docs/installation. ${failure?.message ?? ""}\n${output}`);
  } catch (error) {
    await stop();
    throw error;
  }
}

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a loopback port for Dynoxide");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

export async function createTable(client: DynamoDBClient, name: string): Promise<void> {
  try {
    await client.send(new CreateTableCommand({
      TableName: name,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "S" }],
      KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }]
    }));
  } catch (error) {
    if (!(error instanceof ResourceInUseException)) throw error;
  }
  await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: name });
}

export async function deleteTable(client: DynamoDBClient, name: string): Promise<void> {
  try {
    await client.send(new DeleteTableCommand({ TableName: name }));
  } catch (error) {
    if (!(error instanceof ResourceNotFoundException)) throw error;
  }
}
