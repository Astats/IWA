import { describe, expect, it } from 'vitest';

import { PACKAGE_NAME } from './index';

describe('@budget/core', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@budget/core');
  });
});
