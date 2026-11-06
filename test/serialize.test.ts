import { describe, expect, it } from "vitest";
import { compoundUniquePk, compoundUniqueSk, entitySk, indexPk, indexSk, modelPk, uniquePk } from "../src/keys.js";
import { REVISION_ATTRIBUTE, fromStoredItem, isLogicallyExpired, stripUndefined, toIndexSidecars, toSchemaUniqueLocks, toStoredItem, toUniqueLocks } from "../src/serialize.js";

class CustomValue {
  constructor(
    readonly keep: string,
    readonly missing?: unknown
  ) {}
}

describe("serialization helpers", () => {
  it("uses delimiter-safe length-prefixed model, field, and id key components", () => {
    const a = toStoredItem("user#x", { id: "a#b", "email#work": "a@example.com" });
    const b = toStoredItem("user", { id: "x#a#b", "email#work": "a@example.com" });

    expect(a.pk).toBe(modelPk("user#x"));
    expect(a.sk).toBe(entitySk("a#b"));
    expect(indexSk("a#b")).toBe("OWNER#s3:a#b");
    expect(indexPk("user#x", "email#work", "a@example.com")).toContain("INDEX#s6:user#x#FIELD#s10:email#work#VALUE#");
    expect(uniquePk("user#x", "email#work")).toBe("UNIQUE#s6:user#x#s10:email#work");
    expect(a.pk).not.toBe(b.pk);
    expect(a.sk).not.toBe(b.sk);
  });

  it("uses a versioned, type-preserving namespace for compound unique tuples", () => {
    expect(compoundUniquePk("user", "email_provider")).toContain("UNIQUE2#");
    expect(compoundUniqueSk(["1", 2])).not.toBe(compoundUniqueSk([1, "2"]));
    expect(compoundUniqueSk(["a#b", "c"])).not.toBe(compoundUniqueSk(["a", "b#c"]));
    expect(compoundUniqueSk(["ab", ""])).not.toBe(compoundUniqueSk(["a", "b"]));
    const lock = toSchemaUniqueLocks("user", { id: "u1", email: "a", provider: "google" }, [{ model: "user", name: "email_provider", fields: ["email", "provider"] }])[0];
    expect(lock).toBeDefined();
    expect(lock).toMatchObject({ entity: { ownerPk: modelPk("user"), ownerSk: entitySk("u1"), fields: ["email", "provider"] } });
    expect(lock).not.toHaveProperty("entity.values");
    expect(JSON.stringify(lock)).not.toContain("google");
    expect(toSchemaUniqueLocks("user", { id: "u1", email: null, provider: "google" }, [{ model: "user", name: "email_provider", fields: ["email", "provider"] }])).toHaveLength(0);
    expect(toSchemaUniqueLocks("user", { id: "u1", provider: "google" }, [{ model: "user", name: "email_provider", fields: ["email", "provider"] }])).toHaveLength(0);
    expect(toSchemaUniqueLocks("user", { id: "u1", email: "a", provider: undefined }, [{ model: "user", name: "email_provider", fields: ["email", "provider"] }])).toHaveLength(0);
    expect(toSchemaUniqueLocks("user", { id: "u1", email: "", provider: "google" }, [{ model: "user", name: "email_provider", fields: ["email", "provider"] }])).toHaveLength(1);
  });

  it("enforces DynamoDB partition and sort key byte limits at UTF-8 boundaries", () => {
    expect(modelPk("x".repeat(2036))).toHaveLength(2048);
    expect(() => modelPk("x".repeat(2037))).toThrow(/2048-byte partition key limit/);
    expect(entitySk("x".repeat(1015))).toHaveLength(1024);
    expect(() => entitySk("x".repeat(1016))).toThrow(/1024-byte sort key limit/);
    expect(entitySk("😀".repeat(253))).toBe(`ID#s1012:${"😀".repeat(253)}`);
    expect(() => entitySk("😀".repeat(254))).toThrow(/1024-byte sort key limit/);
  });

  it("keeps internal revision metadata out of Better Auth-visible rows and refreshes it per write", () => {
    const first = toStoredItem("user", { id: "u1", email: "a@example.com" });
    const second = toStoredItem("user", { id: "u1", email: "a@example.com" });

    expect(first[REVISION_ATTRIBUTE]).toMatch(/^[0-9a-f-]{36}$/);
    expect(second[REVISION_ATTRIBUTE]).not.toBe(first[REVISION_ATTRIBUTE]);
    expect(fromStoredItem(first)).toEqual({ id: "u1", email: "a@example.com" });
  });

  it("treats a numeric ttl field as ordinary visible data when TTL is omitted or disabled", () => {
    const omitted = toStoredItem("plugin", { id: "p1", ttl: 1, name: "kept" });
    const disabled = toStoredItem("plugin", { id: "p2", ttl: 1, name: "kept" }, false);

    expect(isLogicallyExpired(omitted, undefined, 2)).toBe(false);
    expect(isLogicallyExpired(disabled, false, 2)).toBe(false);
    expect(fromStoredItem(omitted)).toEqual({ id: "p1", ttl: 1, name: "kept" });
    expect(fromStoredItem(disabled, false)).toEqual({ id: "p2", ttl: 1, name: "kept" });
    expect(fromStoredItem({ ...disabled, entity: undefined }, false)).toMatchObject({ id: "p2", ttl: 1, name: "kept" });
  });

  it("uses configured TTL only from the configured physical TTL attribute", () => {
    const item = toStoredItem("session", { id: "s1", ttl: 1, expiresAt: "2030-01-01T00:00:00.000Z" }, { attributeName: "expiresAtTtl", defaultField: "expiresAt" });
    const sidecar = toIndexSidecars("session", item.entity, { attributeName: "expiresAtTtl", defaultField: "expiresAt" })[0];

    expect(item.ttl).toBe(1);
    expect(item.expiresAtTtl).toBe(1893456000);
    expect(sidecar).toMatchObject({ expiresAtTtl: 1893456000 });
    expect(isLogicallyExpired({ ttl: 1 }, { attributeName: "expiresAtTtl", defaultField: "expiresAt" }, 2)).toBe(false);
    expect(isLogicallyExpired({ expiresAtTtl: 1 }, { attributeName: "expiresAtTtl", defaultField: "expiresAt" }, 2)).toBe(true);
    expect(fromStoredItem(item, { attributeName: "expiresAtTtl", defaultField: "expiresAt" })).toEqual({ id: "s1", ttl: 1, expiresAt: "2030-01-01T00:00:00.000Z" });
  });

  it("preserves epoch-zero TTL metadata", () => {
    const item = toStoredItem("session", { id: "s0", expiresAt: "1970-01-01T00:00:00.000Z" }, { defaultField: "expiresAt" });
    expect(item.ttl).toBe(0);
    expect(toIndexSidecars("session", item.entity, { defaultField: "expiresAt" })[0]).toHaveProperty("ttl", 0);
    expect(toUniqueLocks("session", item.entity, ["id"], { defaultField: "expiresAt" })[0]).toHaveProperty("ttl", 0);
  });

  it("strips undefined only from arrays and nested plain object records", () => {
    const cleaned = stripUndefined({
      id: "u1",
      missing: undefined,
      array: ["a", undefined, { keep: true, drop: undefined }, [undefined, "b"]],
      nested: { keep: { value: 1, missing: undefined }, drop: undefined }
    });

    expect(cleaned).toEqual({ id: "u1", array: ["a", { keep: true }, ["b"]], nested: { keep: { value: 1 } } });
  });

  it("preserves DynamoDB-supported non-plain values unchanged", () => {
    const date = new Date("2030-01-01T00:00:00.000Z");
    const bytes = new Uint8Array([1, 2, 3]);
    const buffer = Buffer.from([4, 5, 6]);
    const set = new Set(["a", "b"]);
    const cleaned = stripUndefined({ date, bytes, buffer, set });

    expect(cleaned.date).toBe(date);
    expect(cleaned.bytes).toBe(bytes);
    expect(cleaned.buffer).toBe(buffer);
    expect(cleaned.set).toBe(set);
  });

  it("preserves class instances unchanged instead of converting them to plain records", () => {
    const instance = new CustomValue("value", undefined);
    const cleaned = stripUndefined({ instance });

    expect(cleaned.instance).toBe(instance);
    expect((cleaned.instance as CustomValue).missing).toBeUndefined();
  });
});
