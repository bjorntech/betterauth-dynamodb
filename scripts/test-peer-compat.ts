// Run with Bun from the repository root; only the local Dynoxide process is contacted.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { dynamoDBAdapter } from "../src/index.js";
import { createTable, deleteTable, startLocalDynamo } from "../test/integration/local-dynamo.js";

const require = createRequire(import.meta.url);
const expectedVersion = process.env.BETTER_AUTH_PEER_VERSION ?? "1.6.25";
for (const name of ["better-auth", "@better-auth/core", "@better-auth/test-utils"]) {
  let directory = dirname(require.resolve(name === "@better-auth/test-utils" ? `${name}/adapter` : name));
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
      if (manifest.name === name) {
        assert.equal(manifest.version, expectedVersion, `${name} must resolve to the requested exact peer`);
        console.log(`${name}: ${manifest.version}`);
        break;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(directory);
    assert.notEqual(parent, directory, `Cannot locate ${name} manifest`);
    directory = parent;
  }
}

const local = await startLocalDynamo();
const tableName = `peer_compat_${randomUUID().replaceAll("-", "")}`;
const commands: string[] = [];
const client = {
  send: (command: Parameters<typeof local.docClient.send>[0]) => {
    commands.push(command.constructor.name);
    return local.docClient.send(command);
  }
};
try {
  await createTable(local.client, tableName);
  const adapter = dynamoDBAdapter({ tableName, client: client as never })({
    secret: "local-peer-compatibility-only-secret",
    user: { modelName: "app_user", fields: { email: "email_address", createdAt: "created_at" } }
  });
  const createdAt = new Date("2026-01-02T03:04:05.000Z");
  const data = { id: "peer-user", email: "peer@example.com", name: "Peer", emailVerified: false, createdAt, updatedAt: createdAt };
  const created = await adapter.create({ model: "user", data, forceAllowId: true });
  assert.equal(created.id, data.id);
  assert.equal(created.email, data.email);
  assert.ok(created.createdAt instanceof Date);
  const found = await adapter.findOne<typeof data>({ model: "user", where: [{ field: "email", value: data.email }] });
  assert.equal(found?.id, data.id);
  assert.equal(found?.createdAt.toISOString(), createdAt.toISOString());
  const selected = await adapter.findOne<Record<string, unknown>>({ model: "user", where: [{ field: "id", value: data.id }], select: ["id", "email"] });
  assert.equal(selected?.email, data.email);
  assert.equal(selected?.name, undefined);
  console.log("factory model/field/date/selection transformations: passed");

  if (process.argv.includes("--transactions")) {
    commands.length = 0;
    const result = await adapter.transaction(async (tx) => {
      await tx.create({ model: "user", data: { ...data, id: "tx-a", email: "tx-a@example.com" }, forceAllowId: true });
      const row = await tx.create({ model: "user", data: { ...data, id: "tx-b", email: "tx-b@example.com" }, forceAllowId: true });
      assert.equal(row.email, "tx-b@example.com");
      assert.ok(row.createdAt instanceof Date);
      return "committed";
    });
    assert.equal(result, "committed");
    assert.equal(commands.filter((name) => name === "TransactWriteCommand").length, 1, "the factory transaction hook must aggregate writes");
    assert.ok(await adapter.findOne({ model: "user", where: [{ field: "id", value: "tx-a" }] }));
    const rollback = new Error("intentional callback rollback");
    await assert.rejects(adapter.transaction(async (tx) => {
      await tx.create({ model: "user", data: { ...data, id: "tx-rollback", email: "tx-rollback@example.com" }, forceAllowId: true });
      throw rollback;
    }), (error) => error === rollback);
    assert.equal(await adapter.findOne({ model: "user", where: [{ field: "id", value: "tx-rollback" }] }), null);
    await assert.rejects(adapter.transaction(async (tx) => {
      await tx.create({ model: "user", data: { ...data, id: "tx-atomic", email: "tx-atomic@example.com" }, forceAllowId: true });
      await tx.create({ model: "user", data: { ...data, id: "tx-conflict" }, forceAllowId: true });
    }));
    assert.equal(await adapter.findOne({ model: "user", where: [{ field: "id", value: "tx-atomic" }] }), null);
    console.log("factory transaction hook / transformed scoped adapter / callback and conflict rollback: passed");
  } else {
    console.log("transaction assertions not requested (use --transactions for the revised adapter)");
  }
} finally {
  try { await deleteTable(local.client, tableName); } finally { await local.stop(); }
}
