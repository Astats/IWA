import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { App } from './App';

describe('App', () => {
  it('greets the user', () => {
    render(<App />);

    expect(screen.getByRole('heading', { name: 'Hello Budget' })).toBeInTheDocument();
  });
});
