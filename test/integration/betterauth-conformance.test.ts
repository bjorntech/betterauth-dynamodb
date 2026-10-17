import {
  authFlowTestSuite,
  caseInsensitiveTestSuite,
  normalTestSuite,
  testAdapter,
  uuidTestSuite
} from "@better-auth/test-utils/adapter";
import { randomUUID } from "node:crypto";
import { createTable, deleteTable, startLocalDynamo } from "./local-dynamo.js";
import { dynamoDBAdapter } from "../../src/index.js";
import type { BetterAuthDynamoDBOptions } from "../../src/index.js";

const tableName = `betterauth_dynamodb_conformance_${randomUUID().replaceAll("-", "")}`;

const local = await startLocalDynamo();
const { client: nativeClient, docClient } = local;

const conformance = await testAdapter({
  adapter: () => dynamoDBAdapter(adapterOptions()),
  runMigrations: () => createTable(nativeClient, tableName),
  onFinish: async () => {
    try { await deleteTable(nativeClient, tableName); } finally { await local.stop(); }
  },
  overrideBetterAuthOptions: (options) => ({
    ...options,
    emailAndPassword: { enabled: true, ...options.emailAndPassword },
    verification: { disableCleanup: true, ...options.verification }
  }),
  tests: [
    // Included: canonical CRUD/query/mutation suite. Its fallback join cases are applicable because Better Auth
    // performs them as separate adapter reads when experimental native joins are disabled.
    normalTestSuite(),
    // Included: this adapter intentionally sets supportsNumericIds=false, but UUID string ids are supported.
    uuidTestSuite(),
    // Included with unsafeAllowScan=true: DynamoDB sidecar keys are case-sensitive, so insensitive predicates
    // require the adapter's explicit bounded model scan opt-in in tests.
    caseInsensitiveTestSuite(),
    // Included: exercises Better Auth's public auth flows against the adapter. Verification cleanup is disabled
    // above because Better Auth's range-only cleanup is an unsupported scan-shaped production access pattern.
    authFlowTestSuite()
    // Excluded: numberIdTestSuite because supportsNumericIds=false.
    // Excluded: transactionsTestSuite because config.transaction=false and DynamoDB cannot support Better Auth's
    // arbitrary callback transaction contract honestly.
    // Excluded: joinsTestSuite because experimental native joins are rejected; Better Auth fallback joins are
    // covered by the normal/UUID suites, while native join tests would conflict with the adapter invariant.
  ],
  prefixTests: "dynamodb-local-conformance"
});

conformance.execute();

function adapterOptions(): BetterAuthDynamoDBOptions {
  return {
    tableName,
    client: docClient,
    unsafeAllowScan: true,
    maxPages: 100
  };
}
