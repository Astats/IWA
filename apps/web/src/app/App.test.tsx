import { screen } from '@testing-library/react';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { createFakeServices } from '@/test/fake-services';

import { App } from './App';

describe('App', () => {
  it('boots the router over the given services', async () => {
    render(<App services={createFakeServices({ hasVault: false, unlocked: false })} />);

    expect(await screen.findByRole('heading', { name: 'Welcome to Budget' })).toBeInTheDocument();
  });
});
