import { describe, expect, it } from "vitest";
import { evaluateFunctions, metricsForSource, parseLcov } from "../scripts/crap-check.js";

function coverage(functions: string, lines = "DA:2,1"): ReturnType<typeof parseLcov> {
  return parseLcov(`SF:src/example.ts\n${functions}\n${lines}\nend_of_record\n`);
}

describe("CRAP coverage mapping", () => {
  it("uses FNDA when Vitest omits the function declaration DA line", () => {
    const functions = metricsForSource("function covered() { return 1; }", "src/example.ts");
    const result = evaluateFunctions(functions, coverage("FN:1,covered\nFNDA:1,covered"));

    expect(result).toHaveLength(1);
    expect(result[0]?.coverage).toBe(100);
    expect(result[0]?.crap).toBe(1);
  });

  it("maps nested same-line functions by occurrence and preserves zero FNDA", () => {
    const functions = metricsForSource("function outer() { return () => 1; }", "src/example.ts");
    const result = evaluateFunctions(functions, coverage("FN:1,outer\nFN:1,(anonymous_1)\nFNDA:1,outer\nFNDA:0,(anonymous_1)"));

    expect(result.map((fn) => fn.coverage)).toEqual([100, 0]);
    expect(result[1]?.crap).toBe(2);
  });

  it("matches inferred variable and property arrows to V8 anonymous records", () => {
    const functions = metricsForSource(
      "const variable = () => { if (true) return 1; if (false) return 2; return 0; }; const object = { property: () => { if (true) return 1; if (false) return 2; return 0; } }; function named() { if (true) return 1; if (false) return 2; return 0; }",
      "src/example.ts"
    );
    const result = evaluateFunctions(
      functions,
      coverage("FN:1,(anonymous_0)\nFN:1,(anonymous_1)\nFN:1,named\nFNDA:8,(anonymous_0)\nFNDA:7,(anonymous_1)\nFNDA:6,named")
    );

    expect(functions.map((fn) => fn.name)).toEqual(["anonymous", "anonymous", "named"]);
    expect(functions.map((fn) => fn.complexity)).toEqual([3, 3, 3]);
    expect(result.map((fn) => fn.coverage)).toEqual([100, 100, 100]);
  });

  it("keeps explicit names for named function expressions", () => {
    const functions = metricsForSource(
      "const inferred = function named() { if (true) return 1; return 0; }; const arrow = () => { if (true) return 1; return 0; };",
      "src/example.ts"
    );
    const result = evaluateFunctions(
      functions,
      coverage("FN:1,named\nFN:1,(anonymous_1)\nFNDA:3,named\nFNDA:4,(anonymous_1)")
    );

    expect(functions.map((fn) => fn.name)).toEqual(["named", "anonymous"]);
    expect(result.map((fn) => fn.coverage)).toEqual([100, 100]);
  });

  it("follows Vitest disambiguation for duplicate method names and suffix-like names", () => {
    const functions = metricsForSource(
      "const object = { method() { if (true) return 1; if (false) return 2; return 0; } }; const arrow = () => { if (true) return 1; if (false) return 2; return 0; }; class Example { method() { if (true) return 1; if (false) return 2; return 0; } method_2() { if (true) return 1; if (false) return 2; return 0; } }",
      "src/example.ts"
    );
    const result = evaluateFunctions(
      functions,
      coverage("FN:1,method\nFN:1,(anonymous_1)\nFN:1,method_2\nFN:1,method_2_2\nFNDA:3,method\nFNDA:0,(anonymous_1)\nFNDA:4,method_2\nFNDA:5,method_2_2")
    );

    expect(functions.map((fn) => fn.name)).toEqual(["method", "anonymous", "method", "method_2"]);
    expect(functions.every((fn) => fn.complexity === 3)).toBe(true);
    expect(result.map((fn) => fn.coverage)).toEqual([100, 0, 100, 100]);
  });

  it("fails closed when a function record is missing or names do not match", () => {
    const functions = metricsForSource("const first = () => 1; const second = () => 2;", "src/example.ts");
    const missing = evaluateFunctions(functions, coverage("FN:1,(anonymous_1)\nFNDA:1,(anonymous_1)"));
    const mismatched = evaluateFunctions(functions, coverage("FN:1,(anonymous_1)\nFN:1,unexpected\nFNDA:1,(anonymous_1)\nFNDA:1,unexpected"));

    expect(missing.every((fn) => fn.coverage === 0)).toBe(true);
    expect(mismatched.every((fn) => fn.coverage === 0)).toBe(true);
  });
});
