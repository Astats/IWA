/**
 * The slice of Vitest's API that the repository contract suite uses, so the unchanged suite can
 * run inside the Android WebView against the real plugin (BUILD_PLAN 4.2 DoD). Semantics follow
 * Vitest: toEqual ignores undefined properties, toMatchObject matches subsets recursively.
 */

type Fn = () => unknown;
interface Suite {
  name: string;
  before: Fn[];
  after: Fn[];
  children: (Suite | Test)[];
}
interface Test {
  name: string;
  fn: Fn;
}

const root: Suite = { name: '', before: [], after: [], children: [] };
let current = root;

export function describe(name: string, body: () => void): void {
  const suite: Suite = { name, before: [], after: [], children: [] };
  current.children.push(suite);
  const parent = current;
  current = suite;
  try {
    body();
  } finally {
    current = parent;
  }
}

export function beforeEach(fn: Fn): void {
  current.before.push(fn);
}

export function afterEach(fn: Fn): void {
  current.after.push(fn);
}

const format = (template: string, args: unknown[]) => {
  let i = 0;
  return template.replace(/%[jisdo]/g, () => JSON.stringify(args[i++]));
};

export const it = Object.assign(
  (name: string, fn: Fn) => {
    current.children.push({ name, fn });
  },
  {
    each: (rows: unknown[][]) => (name: string, fn: (...args: never[]) => unknown) => {
      for (const row of rows) {
        current.children.push({ name: format(name, row), fn: () => fn(...(row as never[])) });
      }
    },
  },
);

// ---- expect ----

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !ArrayBuffer.isView(v);

function equals(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) || ArrayBuffer.isView(a)) {
    const x = a as ArrayLike<unknown>;
    const y = b as ArrayLike<unknown> | null;
    if (!y || typeof y !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
    return x.length === y.length && Array.from(x).every((v, i) => equals(v, y[i]));
  }
  if (isObject(a) && isObject(b)) {
    const keys = new Set(
      [...Object.keys(a), ...Object.keys(b)].filter(
        (k) => a[k] !== undefined || b[k] !== undefined,
      ),
    );
    return [...keys].every((k) => equals(a[k], b[k]));
  }
  return false;
}

function matches(actual: unknown, subset: unknown): boolean {
  if (Array.isArray(subset)) {
    return (
      Array.isArray(actual) &&
      actual.length === subset.length &&
      subset.every((v, i) => matches(actual[i], v))
    );
  }
  if (isObject(subset) && !(subset instanceof Date)) {
    return isObject(actual) && Object.keys(subset).every((k) => matches(actual[k], subset[k]));
  }
  return equals(actual, subset);
}

function show(v: unknown): string {
  const json = JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? `${x}n` : x)) as
    string | undefined;
  return json ?? String(v);
}

function check(pass: boolean, negate: boolean, message: string, label?: string): void {
  if (negate ? pass : !pass)
    throw new Error(`${label ? `${label}: ` : ''}expected ${negate ? 'not ' : ''}${message}`);
}

function matchers(actual: unknown, negate: boolean, label?: string) {
  const c = (pass: boolean, message: string) => {
    check(pass, negate, message, label);
  };
  return {
    toBe: (e: unknown) => {
      c(Object.is(actual, e), `${show(actual)} to be ${show(e)}`);
    },
    toEqual: (e: unknown) => {
      c(equals(actual, e), `${show(actual)} to equal ${show(e)}`);
    },
    toMatchObject: (e: unknown) => {
      c(matches(actual, e), `${show(actual)} to match ${show(e)}`);
    },
    toHaveLength: (n: number) => {
      c(
        (actual as { length?: number } | null)?.length === n,
        `${show(actual)} to have length ${n}`,
      );
    },
    toBeNull: () => {
      c(actual === null, `${show(actual)} to be null`);
    },
    toContain: (e: unknown) => {
      const pass =
        typeof actual === 'string' ? actual.includes(String(e)) : (actual as unknown[]).includes(e);
      c(pass, `${show(actual)} to contain ${show(e)}`);
    },
    toMatch: (e: RegExp | string) => {
      const s = String(actual);
      c(typeof e === 'string' ? s.includes(e) : e.test(s), `${show(actual)} to match ${String(e)}`);
    },
    toBeGreaterThanOrEqual: (n: number | bigint) => {
      c((actual as number) >= n, `${show(actual)} >= ${show(n)}`);
    },
  };
}

export function expect(actual: unknown, label?: string) {
  return {
    ...matchers(actual, false, label),
    not: matchers(actual, true, label),
    rejects: {
      async toThrow(expected?: RegExp | string | (new (...args: never[]) => Error)) {
        let error: unknown;
        try {
          await actual;
        } catch (err) {
          error = err ?? new Error('rejected');
        }
        if (error === undefined) throw new Error(`${label ?? ''} expected the promise to reject`);
        if (expected === undefined) return;
        const text = error instanceof Error ? error.message : show(error);
        const ok =
          typeof expected === 'string'
            ? text.includes(expected)
            : expected instanceof RegExp
              ? expected.test(text)
              : error instanceof expected;
        if (!ok)
          throw new Error(`expected the rejection to match ${String(expected)}, got ${text}`);
      },
    },
  };
}

// ---- runner ----

export interface TestResult {
  name: string;
  ok: boolean;
  error?: string | undefined;
  ms: number;
}

/** Runs every registered test in order: outer beforeEach first, inner afterEach first. */
export async function run(onResult: (r: TestResult) => void): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const walk = async (suite: Suite, path: string[], before: Fn[], after: Fn[]) => {
    const b = [...before, ...suite.before];
    const a = [...suite.after, ...after];
    for (const child of suite.children) {
      if ('children' in child) {
        await walk(child, [...path, child.name], b, a);
        continue;
      }
      const name = [...path, child.name].join(' › ');
      const start = performance.now();
      let error: string | undefined;
      try {
        for (const hook of b) await hook();
        await child.fn();
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      } finally {
        for (const hook of a) {
          try {
            await hook();
          } catch (err) {
            error ??= `afterEach: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
      }
      const result = {
        name,
        ok: error === undefined,
        error,
        ms: Math.round(performance.now() - start),
      };
      results.push(result);
      onResult(result);
    }
  };
  await walk(root, [], [], []);
  return results;
}
