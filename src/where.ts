import { UnsupportedQueryError } from "./errors.js";
import type { CleanedWhere, PlannerHints, QueryPlan } from "./types.js";

type WhereOperator = CleanedWhere["operator"];

export function planQuery(where: CleanedWhere[] = [], allowScan = false, hints: PlannerHints = {}): QueryPlan {
  assertSupportedOperators(where);
  const keyedProblem = keyedAccessProblem(where, hints);
  if (keyedProblem) return scanOrThrow(where, allowScan, keyedProblem);
  const keyed = keyedPlan(where, hints);
  if (keyed) return keyed;
  if (allowScan) return { kind: "byModel", where };
  throw new UnsupportedQueryError(scanRequiredMessage(where, hints));
}

/** `id` is the entity key; other fields are sidecar-indexed unless excluded or outside a configured allowlist. */
export function isIndexedField(field: string, hints: PlannerHints = {}): boolean {
  if (field === "id") return false;
  if (hints.nonIndexedFields?.includes(field)) return false;
  return hints.indexedFields ? hints.indexedFields.includes(field) : true;
}

function scanRequiredMessage(where: CleanedWhere[], hints: PlannerHints): string {
  const unindexed = where.find((clause) => isKeyedEquality(clause) && clause.field !== "id" && !isIndexedField(clause.field, hints));
  const base = "Query requires a table scan. Pass unsafeAllowScan to enable bounded scans explicitly.";
  return unindexed ? `${base} Field "${unindexed.field}" is not sidecar-indexed (see indexedFields / nonIndexedFields).` : base;
}

function keyedPlan(where: CleanedWhere[], hints: PlannerHints): QueryPlan | undefined {
  if (eqWhere(where, "id")) return { kind: "byId", where };
  if (inWhere(where, "id")) return { kind: "byIdValues", where };
  const clause = mostSelectiveEquality(where, hints);
  if (clause) return { kind: "byFieldValue", where, clause };
  if (safeInWhere(where, hints)) return { kind: "byFieldValues", where };
  return undefined;
}

export function matchesWhere(item: Record<string, unknown>, where: CleanedWhere[] = []): boolean {
  if (where.length === 0) return true;
  return where.reduce((acc, clause, index) => combine(acc, evalClause(item, clause), clause.connector, index), true);
}

/**
 * Picks the equality clause whose sidecar partition is expected to be smallest:
 * unique fields first, ordinary fields next, and low-cardinality fields (booleans,
 * nulls, configured fields such as account.providerId) last. Ties keep where order.
 */
export function mostSelectiveEquality(where: CleanedWhere[] = [], hints: PlannerHints = {}): CleanedWhere | undefined {
  const candidates = where.filter((w) => isKeyedEquality(w) && isScalar(w.value) && isIndexedField(w.field, hints));
  return candidates.reduce<CleanedWhere | undefined>((best, clause) => (best && selectivityRank(best, hints) >= selectivityRank(clause, hints) ? best : clause), undefined);
}

function selectivityRank(clause: CleanedWhere, hints: PlannerHints): number {
  if (hints.uniqueFields?.includes(clause.field)) return 3;
  return isLowCardinality(clause, hints) ? 1 : 2;
}

function isLowCardinality(clause: CleanedWhere, hints: PlannerHints): boolean {
  if (clause.value === null || typeof clause.value === "boolean") return true;
  return hints.lowCardinalityFields?.includes(clause.field) ?? false;
}

export function inWhere(where: CleanedWhere[], field: string): CleanedWhere | undefined {
  return where.find((w) => w.field === field && w.operator === "in" && isScalarArray(w.value));
}

export function scalarValues(clause: CleanedWhere): (string | number | boolean | Date | null)[] {
  return Array.isArray(clause.value) ? clause.value.filter(isScalar) as (string | number | boolean | Date | null)[] : [];
}

export function safeInWhere(where: CleanedWhere[], hints: PlannerHints = {}): CleanedWhere | undefined {
  return where.find((clause) => isSafeIn(clause) && isIndexedField(clause.field, hints));
}

export function eqWhere(where: CleanedWhere[], field: string): CleanedWhere | undefined {
  return where.find((w) => w.field === field && isKeyedEquality(w));
}

export function compareValues(left: unknown, operator: CleanedWhere["operator"], right: CleanedWhere["value"], insensitive: boolean): boolean {
  assertSupportedOperator(operator);
  const l = normalize(left, insensitive);
  const r = normalize(right, insensitive);
  return comparators[operator](l, r);
}

const comparators: Record<WhereOperator, (left: any, right: any) => boolean> = {
  eq: (left, right) => left === right,
  ne: (left, right) => left !== right,
  lt: (left, right) => left < right,
  lte: (left, right) => left <= right,
  gt: (left, right) => left > right,
  gte: (left, right) => left >= right,
  contains: (left, right) => String(left).includes(String(right)),
  starts_with: (left, right) => String(left).startsWith(String(right)),
  ends_with: (left, right) => String(left).endsWith(String(right)),
  in: (left, right) => Array.isArray(right) && right.includes(left),
  not_in: (left, right) => Array.isArray(right) && !right.includes(left)
};

function assertSupportedOperator(operator: string): asserts operator is WhereOperator {
  if (operator in comparators) return;
  throw new UnsupportedQueryError(`Unsupported Better Auth where operator "${operator}". Supported operators: ${Object.keys(comparators).join(", ")}.`);
}

function assertSupportedOperators(where: CleanedWhere[]): void {
  where.forEach((clause) => assertSupportedOperator(clause.operator));
}

function evalClause(item: Record<string, unknown>, clause: CleanedWhere): boolean {
  return compareValues(item[clause.field], clause.operator, clause.value, clause.mode === "insensitive");
}

function combine(acc: boolean, value: boolean, connector: "AND" | "OR" | undefined, index: number): boolean {
  if (index === 0) return value;
  return connector === "OR" ? acc || value : acc && value;
}

function keyedAccessProblem(where: CleanedWhere[], hints: PlannerHints): string | undefined {
  if (hasOrPredicate(where)) return "OR predicates cannot use DynamoDB keyed access without risking incomplete results. Pass unsafeAllowScan: true to evaluate OR predicates with an explicit bounded scan.";
  if (hasSafeKeyedEquality(where, hints)) return undefined;
  if (hasInsensitiveEquality(where)) return "Case-insensitive equality cannot use DynamoDB keyed access (including case-insensitive IN) because id and scalar sidecar keys are case-sensitive. Pass unsafeAllowScan: true to evaluate it with an explicit bounded scan.";
  return undefined;
}

function scanOrThrow(where: CleanedWhere[], allowScan: boolean, message: string): QueryPlan {
  if (allowScan) return { kind: "byModel", where };
  throw new UnsupportedQueryError(message);
}

function hasOrPredicate(where: CleanedWhere[]): boolean {
  return where.length > 1 && where.some((clause) => clause.connector === "OR");
}

function hasSafeKeyedEquality(where: CleanedWhere[], hints: PlannerHints): boolean {
  return where.some((clause) => isKeyedAnchor(clause, hints));
}

function isKeyedAnchor(clause: CleanedWhere, hints: PlannerHints): boolean {
  const keyed = (isKeyedEquality(clause) && isScalar(clause.value)) || isSafeIn(clause);
  return keyed && (clause.field === "id" || isIndexedField(clause.field, hints));
}

function hasInsensitiveEquality(where: CleanedWhere[]): boolean {
  return where.some((clause) => clause.mode === "insensitive" && (clause.operator === "eq" || clause.operator === "in"));
}

function isSafeIn(clause: CleanedWhere): boolean {
  return clause.operator === "in" && clause.mode !== "insensitive" && isScalarArray(clause.value);
}

function isKeyedEquality(clause: CleanedWhere): boolean {
  return clause.operator === "eq" && clause.mode !== "insensitive";
}

function normalize(value: unknown, insensitive: boolean): any {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((entry) => normalize(entry, insensitive));
  if (typeof value === "string" && insensitive) return value.toLowerCase();
  return value;
}

function isScalar(value: unknown): boolean {
  return value === null || ["string", "number", "boolean"].includes(typeof value) || value instanceof Date;
}

function isScalarArray(value: unknown): boolean { return Array.isArray(value) && value.every(isScalar); }
