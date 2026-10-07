import { describe, expect, it } from 'vitest';

import { PACKAGE_NAME } from './index';

describe('@budget/backup', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@budget/backup');
  });
});
