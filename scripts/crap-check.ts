import { parse } from "@babel/parser";
import traverse from "@babel/traverse";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const traverseAst = typeof traverse === "function" ? traverse : traverse.default;

export interface FnMetric { file: string; line: number; name: string; complexity: number }

interface LcovFunction { line: number; name: string; hits?: number }

export interface LcovFile {
  lines: Map<number, number>;
  functions: LcovFunction[];
}

export type LcovCoverage = Map<string, LcovFile>;

export interface EvaluatedFunction extends FnMetric {
  coverage: number;
  crap: number;
}

export function crap(complexity: number, coveragePercent: number): number {
  const uncovered = 1 - coveragePercent / 100;
  return complexity ** 2 * uncovered ** 3 + complexity;
}

export function evaluateFunctions(functions: FnMetric[], coverage: LcovCoverage): EvaluatedFunction[] {
  const functionHits = matchFunctionHits(functions, coverage);
  return functions.map((fn, index) => {
    const covered = (functionHits[index] ?? 0) > 0 ? 100 : 0;
    return { ...fn, coverage: covered, crap: crap(fn.complexity, covered) };
  });
}

export function parseLcov(text: string, cwd = process.cwd()): LcovCoverage {
  const records = new Map<string, LcovFile>();
  let current = "";
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) {
      current = relative(cwd, line.slice(3));
      records.set(current, { lines: new Map(), functions: [] });
    }
    if (line.startsWith("DA:")) addLine(records, current, line);
    if (line.startsWith("FN:")) addFunction(records, current, line);
    if (line.startsWith("FNDA:")) addFunctionHits(records, current, line);
  }
  return records;
}

function addLine(records: LcovCoverage, file: string, line: string): void {
  const record = records.get(file);
  if (!record) return;
  const [lineNo, hits] = line.slice(3).split(",").map(Number);
  record.lines.set(lineNo ?? 0, hits ?? 0);
}

function addFunction(records: LcovCoverage, file: string, line: string): void {
  const record = records.get(file);
  if (!record) return;
  const [lineNo, ...name] = line.slice(3).split(",");
  record.functions.push({ line: Number(lineNo), name: name.join(",") });
}

function addFunctionHits(records: LcovCoverage, file: string, line: string): void {
  const record = records.get(file);
  if (!record) return;
  const [hits, ...name] = line.slice(5).split(",");
  const fn = record.functions.find((candidate) => candidate.hits === undefined && candidate.name === name.join(","));
  if (fn) fn.hits = Number(hits);
}

export function listFunctions(root: string): FnMetric[] {
  return walk(root).flatMap((file) => metricsForFile(file));
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)])).filter((file) => file.endsWith(".ts"));
}

function metricsForFile(file: string): FnMetric[] {
  return metricsForSource(readFileSync(file, "utf8"), file);
}

export function metricsForSource(source: string, file: string): FnMetric[] {
  const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
  const metrics: FnMetric[] = [];
  traverseAst(ast, {
    Function(path: any) {
      metrics.push({ file, line: path.node.loc?.start.line ?? 1, name: functionName(path), complexity: complexity(path) });
    }
  });
  return metrics;
}

function matchFunctionHits(functions: FnMetric[], coverage: LcovCoverage): number[] {
  const hits = new Array<number>(functions.length).fill(0);
  const lcovNames = lcovFunctionNames(functions);
  const byLocation = new Map<string, number[]>();
  functions.forEach((fn, index) => {
    const key = `${fn.file}:${fn.line}`;
    byLocation.set(key, [...(byLocation.get(key) ?? []), index]);
  });
  for (const [key, indexes] of byLocation) {
    const separator = key.lastIndexOf(":");
    const file = key.slice(0, separator);
    const line = Number(key.slice(separator + 1));
    const records = coverage.get(file)?.functions.filter((fn) => fn.line === line) ?? [];
    if (records.length !== indexes.length) continue;
    if (!records.every((record, index) => lcovNames.get(indexes[index]!) === record.name)) continue;
    for (const [index, record] of records.entries()) hits[indexes[index]!] = record.hits ?? 0;
  }
  return hits;
}

function lcovFunctionNames(functions: FnMetric[]): Map<number, string> {
  const names = new Map<number, string>();
  const stateByFile = new Map<string, { index: number; counts: Map<string, number> }>();
  functions.forEach((fn, index) => {
    const state = stateByFile.get(fn.file) ?? { index: 0, counts: new Map<string, number>() };
    names.set(index, fn.name === "anonymous" ? `(anonymous_${state.index})` : uniqueLcovName(fn.name, state.counts));
    state.index++;
    stateByFile.set(fn.file, state);
  });
  return names;
}

function uniqueLcovName(name: string, counts: Map<string, number>): string {
  let count = (counts.get(name) ?? 0) + 1;
  let candidate = count > 1 ? `${name}_${count}` : name;
  while (counts.has(candidate)) {
    count++;
    candidate = `${name}_${count}`;
  }
  counts.set(name, count);
  if (candidate !== name) counts.set(candidate, 0);
  return candidate;
}

function complexity(path: any): number {
  let score = 1;
  path.traverse({
    IfStatement: () => { score++; },
    ConditionalExpression: () => { score++; },
    LogicalExpression: (p: any) => { if (["&&", "||", "??"].includes(p.node.operator)) score++; },
    ForStatement: () => { score++; },
    ForOfStatement: () => { score++; },
    ForInStatement: () => { score++; },
    WhileStatement: () => { score++; },
    DoWhileStatement: () => { score++; },
    CatchClause: () => { score++; },
    SwitchCase: (p: any) => { if (p.node.test) score++; }
  });
  return score;
}

function functionName(path: any): string {
  // V8's LCOV names arrows and unnamed function expressions as anonymous even
  // when Babel can infer a name from the variable/property containing them.
  // Only use names that are part of the function's own syntax (or a method
  // key), otherwise a covered function can be rejected as a name mismatch.
  if (path.node.id?.name) return path.node.id.name;
  if (path.node.type.endsWith("Method") && path.node.key?.name) return path.node.key.name;
  return "anonymous";
}

if (process.argv[1]?.endsWith("/scripts/crap-check.ts")) {
  const [lcovPath, sourceRoot = "src"] = process.argv.slice(2);
  if (!lcovPath) throw new Error("Usage: bun scripts/crap-check.ts coverage/lcov.info src");
  const evaluated = evaluateFunctions(listFunctions(sourceRoot), parseLcov(readFileSync(lcovPath, "utf8")));
  const failures = evaluated.filter((fn) => fn.crap > 6);
  const max = Math.max(...evaluated.map((fn) => fn.crap), 0);
  console.log(`CRAP max=${max.toFixed(2)} functions=${evaluated.length}`);
  if (failures.length) {
    for (const fn of failures) console.error(`${fn.file}:${fn.line} ${fn.name} complexity=${fn.complexity} crap=${fn.crap.toFixed(2)}`);
    process.exit(1);
  }
}
