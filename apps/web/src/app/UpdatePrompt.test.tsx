import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { UpdatePrompt } from './UpdatePrompt';

describe('UpdatePrompt', () => {
  it('is hidden until a new version is waiting', () => {
    render(<UpdatePrompt visible={false} onReload={vi.fn()} onDismiss={vi.fn()} />);

    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('offers reload and dismiss', async () => {
    const onReload = vi.fn();
    const onDismiss = vi.fn();
    render(<UpdatePrompt visible onReload={onReload} onDismiss={onDismiss} />);

    expect(screen.getByRole('alert')).toHaveTextContent('A new version is available.');
    await userEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(onReload).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
