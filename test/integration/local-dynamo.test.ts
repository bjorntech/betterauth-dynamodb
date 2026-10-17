import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createTable, deleteTable, startLocalDynamo } from "./local-dynamo.js";

it("owns isolated loopback databases and supports repeatable table/process cleanup", async () => {
  const first = await startLocalDynamo();
  try {
    const second = await startLocalDynamo();
    try {
      expect(first.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(second.endpoint).not.toBe(first.endpoint);
      const tableName = `helper_${randomUUID().replaceAll("-", "")}`;
      await createTable(first.client, tableName);
      await createTable(first.client, tableName);
      await createTable(second.client, tableName);
      const Key = { pk: "test", sk: "isolation" };
      await first.docClient.send(new PutCommand({ TableName: tableName, Item: { ...Key, value: "first-only", omitted: undefined } }));
      await expect(first.docClient.send(new GetCommand({ TableName: tableName, Key }))).resolves.toMatchObject({ Item: { ...Key, value: "first-only" } });
      await expect(second.docClient.send(new GetCommand({ TableName: tableName, Key }))).resolves.not.toHaveProperty("Item");
      await deleteTable(first.client, tableName);
      await deleteTable(first.client, tableName);
      await deleteTable(second.client, tableName);
    } finally {
      await second.stop();
      await second.stop();
    }
  } finally {
    await first.stop();
    await first.stop();
  }
});
