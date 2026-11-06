import { describe, expect, it } from "vitest";
import { UnsupportedQueryError } from "../src/errors.js";
import type { CleanedWhere } from "../src/types.js";
import { matchesWhere, planQuery } from "../src/where.js";

const clause = (field: string, operator: CleanedWhere["operator"], value: CleanedWhere["value"], overrides: Partial<CleanedWhere> = {}): CleanedWhere => ({ field, operator, value, connector: "AND", mode: "sensitive", ...overrides });

describe("where planning and matching", () => {
  it("plans id and scalar equality efficiently", () => {
    expect(planQuery([clause("id", "eq", "1")]).kind).toBe("byId");
    expect(planQuery([clause("email", "eq", "a")]).kind).toBe("byFieldValue");
  });

  it("plans scalar and id IN predicates without scans, including empty IN", () => {
    expect(planQuery([clause("id", "in", ["u1", "u1", "u2"])]).kind).toBe("byIdValues");
    expect(planQuery([clause("email", "in", ["a@example.com", "b@example.com"])]).kind).toBe("byFieldValues");
    expect(planQuery([clause("id", "in", [])]).kind).toBe("byIdValues");
    expect(() => planQuery([clause("name", "in", ["a"]), clause("role", "eq", "admin", { connector: "OR" })])).toThrow(UnsupportedQueryError);
  });

  it("refuses case-insensitive IN keyed access unless another safe anchor exists", () => {
    const insensitiveIn = clause("email", "in", ["A@EXAMPLE.COM"], { mode: "insensitive" });
    expect(() => planQuery([insensitiveIn])).toThrow(/case-sensitive/);
    expect(planQuery([insensitiveIn], true).kind).toBe("byModel");
    expect(planQuery([eqClause("id", "u1"), insensitiveIn]).kind).toBe("byId");
    expect(matchesWhere({ email: "a@example.com" }, [insensitiveIn])).toBe(true);
  });

  it("rejects OR predicates instead of narrowing to one keyed branch", () => {
    const where = [clause("email", "eq", "a@example.com"), clause("role", "eq", "admin", { connector: "OR" })];
    expect(() => planQuery(where)).toThrow(UnsupportedQueryError);
    expect(() => planQuery(where)).toThrow(/OR predicates cannot use DynamoDB keyed access/);
    expect(planQuery(where, true).kind).toBe("byModel");
  });

  it("still uses keyed access for a single clause whose connector is OR", () => {
    expect(planQuery([clause("email", "eq", "a@example.com", { connector: "OR" })]).kind).toBe("byFieldValue");
  });

  it("treats an undefined connector as AND for keyed planning", () => {
    const where: CleanedWhere[] = [{ field: "email", operator: "eq", value: "a@example.com", mode: "sensitive" }];
    expect(planQuery(where).kind).toBe("byFieldValue");
  });

  it("rejects case-insensitive equality as the only keyed access path", () => {
    const where = [clause("id", "eq", "U1", { mode: "insensitive" })];
    expect(() => planQuery(where)).toThrow(UnsupportedQueryError);
    expect(() => planQuery(where)).toThrow(/Case-insensitive equality cannot use DynamoDB keyed access/);
    expect(planQuery(where, true).kind).toBe("byModel");
  });

  it("can use another safe keyed equality beside an insensitive predicate", () => {
    const where = [clause("email", "eq", "a@example.com", { mode: "insensitive" }), clause("role", "eq", "admin")];
    expect(planQuery(where).kind).toBe("byFieldValue");
  });

  it("anchors keyed reads on the most selective equality instead of the first one", () => {
    const accountKey = [clause("providerId", "eq", "google"), clause("accountId", "eq", "g-123")];
    expect(planQuery(accountKey, false, { lowCardinalityFields: ["providerId"] }).clause?.field).toBe("accountId");
    expect(planQuery(accountKey).clause?.field).toBe("providerId");
    expect(planQuery([clause("org", "eq", "o1"), clause("email", "eq", "a@example.com")], false, { uniqueFields: ["email"] }).clause?.field).toBe("email");
    expect(planQuery([clause("emailVerified", "eq", true), clause("org", "eq", "o1")]).clause?.field).toBe("org");
    expect(planQuery([clause("deletedAt", "eq", null), clause("org", "eq", "o1")]).clause?.field).toBe("org");
    expect(planQuery([clause("a", "eq", "1"), clause("b", "eq", "2")]).clause?.field).toBe("a");
    expect(planQuery([clause("emailVerified", "eq", true)]).clause?.field).toBe("emailVerified");
  });

  it("treats only indexed fields as keyed anchors", () => {
    expect(() => planQuery([clause("password", "eq", "x")], false, { nonIndexedFields: ["password"] })).toThrow(/Field "password" is not sidecar-indexed/);
    expect(() => planQuery([clause("ipAddress", "eq", "x")], false, { indexedFields: ["token"] })).toThrow(/not sidecar-indexed/);
    expect(() => planQuery([clause("ipAddress", "in", ["x"])], false, { indexedFields: ["token"] })).toThrow(/requires a table scan\. Pass unsafeAllowScan to enable bounded scans explicitly\.$/);
    expect(planQuery([clause("ipAddress", "eq", "x")], true, { indexedFields: ["token"] }).kind).toBe("byModel");
    expect(planQuery([clause("ipAddress", "eq", "x"), clause("token", "eq", "t")], false, { indexedFields: ["token"] }).clause?.field).toBe("token");
    expect(planQuery([clause("ipAddress", "in", ["x"]), clause("token", "in", ["t"])], false, { indexedFields: ["token"] }).kind).toBe("byFieldValues");
    expect(() => planQuery([clause("email", "eq", "A", { mode: "insensitive" }), clause("ipAddress", "eq", "x")], false, { indexedFields: ["email"] })).toThrow(/Case-insensitive/);
    expect(planQuery([clause("id", "eq", "1")], false, { indexedFields: [] }).kind).toBe("byId");
  });

  it("does not anchor on insensitive or non-scalar equalities when ranking", () => {
    const where = [clause("email", "eq", "A@EXAMPLE.COM", { mode: "insensitive" }), clause("emailVerified", "eq", true)];
    expect(planQuery(where, false, { uniqueFields: ["email"] }).clause?.field).toBe("emailVerified");
  });

  it("evaluates comparison, string, and set operators", () => {
    const item = { email: "Hello@Test.com", count: 2 };
    expect(matchesWhere(item, [clause("count", "gte", 2), clause("email", "ends_with", ".com")])).toBe(true);
    expect(matchesWhere(item, [clause("count", "in", [1, 2])])).toBe(true);
    expect(matchesWhere(item, [clause("count", "not_in", [3])])).toBe(true);
  });

  it("supports insensitive comparisons", () => {
    const where: CleanedWhere[] = [{ field: "email", operator: "eq", value: "hello@test.com", connector: "AND", mode: "insensitive" }];
    expect(matchesWhere({ email: "Hello@Test.com" }, where)).toBe(true);
  });

  it("rejects unknown in-memory operators actionably", () => {
    const where = [{ field: "email", operator: "regex", value: "@", connector: "AND", mode: "sensitive" }] as unknown as CleanedWhere[];
    expect(() => matchesWhere({ email: "a@example.com" }, where)).toThrow(UnsupportedQueryError);
    expect(() => matchesWhere({ email: "a@example.com" }, where)).toThrow(/Unsupported Better Auth where operator "regex"/);
  });

  it("rejects unknown operators before scan planning", () => {
    const where = [{ field: "email", operator: "regex", value: "@", connector: "AND", mode: "sensitive" }] as unknown as CleanedWhere[];
    expect(() => planQuery(where)).toThrow(UnsupportedQueryError);
    expect(() => planQuery(where)).toThrow(/Unsupported Better Auth where operator "regex"/);
  });
});

function eqClause(field: string, value: string): CleanedWhere {
  return clause(field, "eq", value);
}
