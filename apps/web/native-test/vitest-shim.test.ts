import { describe as vDescribe, expect as vExpect, it as vIt } from 'vitest';

import * as shim from './vitest-shim';

const fails = (fn: () => void) => {
  vExpect(fn).toThrow();
};

vDescribe('vitest shim (on-device contract runner)', () => {
  vIt('compares like Vitest: toEqual ignores undefined properties, toBe is identity', () => {
    shim.expect({ a: 1, b: undefined, c: [1, { d: 'x' }] }).toEqual({ a: 1, c: [1, { d: 'x' }] });
    shim.expect([new Date(5)]).toEqual([new Date(5)]);
    shim.expect(10n).toBe(10n);
    fails(() => {
      shim.expect({ a: 1 }).toEqual({ a: 2 });
    });
    fails(() => {
      shim.expect([1, 2]).toEqual([1, 2, 3]);
    });
    fails(() => {
      shim.expect({ a: 1 }).toBe({ a: 1 });
    });
    fails(() => {
      shim.expect(1).toEqual('1');
    });
  });

  vIt('matches subsets recursively and arrays by length', () => {
    shim.expect({ a: 1, b: { c: 2, d: 3 } }).toMatchObject({ b: { c: 2 } });
    fails(() => {
      shim.expect({ a: 1 }).toMatchObject({ a: 1, b: 2 });
    });
    fails(() => {
      shim.expect({ list: [1, 2] }).toMatchObject({ list: [1] });
    });
  });

  vIt('supports not, length, null, contain, match and >=', () => {
    shim.expect(null).toBeNull();
    shim.expect(1).not.toBeNull();
    shim.expect([1, 2]).toHaveLength(2);
    shim.expect('Hello').toContain('ell');
    shim.expect([1, 2]).toContain(2);
    shim.expect('abc-123').toMatch(/^[a-z]+-\d+$/);
    shim.expect(3).toBeGreaterThanOrEqual(3);
    fails(() => {
      shim.expect(null).not.toBeNull();
    });
    fails(() => {
      shim.expect([1]).toContain(2);
    });
  });

  vIt('rejects.toThrow fails when the promise resolves or the error does not match', async () => {
    await shim.expect(Promise.reject(new RangeError('too big'))).rejects.toThrow();
    await shim.expect(Promise.reject(new RangeError('too big'))).rejects.toThrow(/big/);
    await shim.expect(Promise.reject(new RangeError('too big'))).rejects.toThrow(RangeError);
    await vExpect(shim.expect(Promise.resolve(1)).rejects.toThrow()).rejects.toThrow();
    await vExpect(
      shim.expect(Promise.reject(new Error('x'))).rejects.toThrow(/y/),
    ).rejects.toThrow();
  });

  vIt('runs nested hooks in order, it.each rows, and reports failures', async () => {
    const order: string[] = [];
    shim.describe('outer', () => {
      shim.beforeEach(() => order.push('before outer'));
      shim.afterEach(() => order.push('after outer'));
      shim.describe('inner', () => {
        shim.beforeEach(() => order.push('before inner'));
        shim.afterEach(() => order.push('after inner'));
        shim.it('passes', () => order.push('test'));
        shim.it.each([[1, 'one']])('row %j is %j', (n: number, s: string) => {
          order.push(`${String(n)}=${s}`);
        });
        shim.it('fails', () => {
          shim.expect(1).toBe(2);
        });
      });
    });

    const results = await shim.run(() => undefined);

    vExpect(results.map((r) => [r.name, r.ok])).toEqual([
      ['outer › inner › passes', true],
      ['outer › inner › row 1 is "one"', true],
      ['outer › inner › fails', false],
    ]);
    vExpect(order.slice(0, 5)).toEqual([
      'before outer',
      'before inner',
      'test',
      'after inner',
      'after outer',
    ]);
    vExpect(order).toContain('1=one');
  });
});
