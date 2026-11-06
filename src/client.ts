import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { DynamoDBClientConfig } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoDBAdapterError } from "./errors.js";
import type { BetterAuthDynamoDBOptions } from "./types.js";

export function createDocumentClient(options: BetterAuthDynamoDBOptions): DynamoDBDocumentClient {
  if (options.client) return options.client;
  const config: DynamoDBClientConfig = { ...options.dynamoDBClientConfig };
  if (options.region) config.region = options.region;
  if (options.endpoint) config.endpoint = options.endpoint;
  const client = new DynamoDBClient(config);
  return DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
}

export function normalizeOptions<O extends BetterAuthDynamoDBOptions>(options: O): Required<Pick<BetterAuthDynamoDBOptions, "maxPages" | "unsafeAllowScan" | "maxBulkConcurrency">> & O {
  const uniqueFields = dedupeUniqueFields(options.uniqueFields);
  const listableModels = options.listableModels ? [...new Set(options.listableModels)] : undefined;
  const pageSize = optionalPositiveSafeIntegerOption("pageSize", options.pageSize);
  const maxBulkConcurrency = positiveSafeIntegerOption("maxBulkConcurrency", options.maxBulkConcurrency, 8);
  return { ...options, ...(uniqueFields ? { uniqueFields } : {}), ...(listableModels ? { listableModels } : {}), ...(pageSize ? { pageSize } : {}), maxPages: positiveSafeIntegerOption("maxPages", options.maxPages, 25), unsafeAllowScan: options.unsafeAllowScan ?? false, maxBulkConcurrency };
}

function positiveSafeIntegerOption(name: string, value: number | undefined, defaultValue: number): number {
  return optionalPositiveSafeIntegerOption(name, value) ?? defaultValue;
}

function optionalPositiveSafeIntegerOption(name: string, value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (Number.isSafeInteger(value) && value > 0) return value;
  throw new DynamoDBAdapterError(`Better Auth DynamoDB option ${name} must be a positive safe integer.`);
}

function dedupeUniqueFields(fields?: Record<string, string[]>): Record<string, string[]> | undefined {
  if (!fields) return undefined;
  return Object.fromEntries(Object.entries(fields).map(([model, values]) => [model, [...new Set(values)]]));
}
