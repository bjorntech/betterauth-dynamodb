export class DynamoDBAdapterError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DynamoDBAdapterError";
  }
}

export class UnsupportedQueryError extends DynamoDBAdapterError {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedQueryError";
  }
}

export class DynamoDBConflictError extends DynamoDBAdapterError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DynamoDBConflictError";
  }
}

export function isConditionalCheckFailed(error: unknown): boolean {
  return isNamed(error, "ConditionalCheckFailedException");
}

export function isTransactionCanceled(error: unknown): boolean {
  return isNamed(error, "TransactionCanceledException");
}

export function isConditionalTransactionCanceled(error: unknown): boolean {
  return isTransactionCanceled(error) && cancellationCodes(error).includes("ConditionalCheckFailed");
}

export function transactionCancellationCodes(error: unknown): string[] {
  return cancellationCodes(error);
}

function cancellationCodes(error: unknown): string[] {
  if (!hasCancellationReasons(error)) return [];
  return error.CancellationReasons.map((reason) => reason.Code).filter((code): code is string => typeof code === "string");
}

function hasCancellationReasons(error: unknown): error is { CancellationReasons: { Code?: unknown }[] } {
  return typeof error === "object" && error !== null && "CancellationReasons" in error && Array.isArray(error.CancellationReasons);
}

function isNamed(error: unknown, name: string): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === name;
}

/** Conflict causes keep the AWS error name, message, and cancellation codes but never item contents (CancellationReasons[].Item). */
export function redactedAwsError(error: unknown): { name: string; message: string; cancellationCodes: string[] } {
  return { name: errorField(error, "name"), message: errorField(error, "message"), cancellationCodes: cancellationCodes(error) };
}

function errorField(error: unknown, field: "name" | "message"): string {
  if (typeof error !== "object" || error === null || !(field in error)) return "";
  return String((error as Record<string, unknown>)[field]);
}
