import { DynamoDBAdapterError, createDynamoDBPaginator, dynamoDBAdapter } from "../dist/index.js";

if (typeof dynamoDBAdapter !== "function") throw new Error("dynamoDBAdapter export is not importable");
if (typeof DynamoDBAdapterError !== "function") throw new Error("DynamoDBAdapterError export is not importable");
if (typeof createDynamoDBPaginator !== "function") throw new Error("createDynamoDBPaginator export is not importable");

console.log("dist ESM import smoke passed");
