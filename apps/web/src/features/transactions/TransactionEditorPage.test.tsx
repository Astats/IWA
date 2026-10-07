import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { axe } from '@/test/axe';
import { createFakeServices } from '@/test/fake-services';
import { renderApp } from '@/test/render';

async function servicesWithCategories() {
  const services = createFakeServices();
  await services.vault.repos.categories.seedDefaults();
  await services.vault.repos.settings.set('baseCurrency', 'EUR');
  return services;
}

const categoryId = async (services: ReturnType<typeof createFakeServices>, name: string) =>
  (await services.vault.repos.categories.list()).find((c) => c.name === name)!.id;

describe('transaction form', () => {
  it('validates on submit, shows translated messages and focuses the first invalid field', async () => {
    const app = renderApp({ services: await servicesWithCategories(), route: '/transactions/new' });
    const amount = await screen.findByLabelText('Amount');

    await app.user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Enter an amount.')).toBeInTheDocument();
    expect(screen.getByText('Choose a category.')).toBeInTheDocument();
    expect(amount).toHaveFocus();
    expect(amount).toHaveAttribute('aria-invalid', 'true');
  });

  it('validates the amount on blur', async () => {
    const app = renderApp({ services: await servicesWithCategories(), route: '/transactions/new' });
    const amount = await screen.findByLabelText('Amount');

    await app.user.type(amount, '-5');
    await app.user.tab();

    expect(await screen.findByText(/Enter a positive amount/)).toBeInTheDocument();
  });

  it('defaults currency to the base currency and the date to today', async () => {
    const services = await servicesWithCategories();
    await services.vault.repos.settings.set('baseCurrency', 'USD');
    renderApp({ services, route: '/transactions/new' });

    expect(await screen.findByLabelText('Currency')).toHaveValue('USD');
    expect(screen.getByLabelText('Date')).toHaveValue('2026-03-15');
  });

  it('filters categories by kind and clears an incompatible choice', async () => {
    const app = renderApp({ services: await servicesWithCategories(), route: '/transactions/new' });
    const category = await screen.findByLabelText('Category');
    await within(category).findByRole('option', { name: 'Food' });

    expect(within(category).queryByRole('option', { name: 'Salary' })).toBeNull();
    await app.user.selectOptions(category, 'Food');
    await app.user.click(screen.getByRole('radio', { name: 'Income' }));

    expect(category).toHaveValue('');
    expect(within(category).getByRole('option', { name: 'Salary' })).toBeInTheDocument();
    expect(within(category).queryByRole('option', { name: 'Food' })).toBeNull();
  });

  it('creates an expense with a locale-parsed amount and returns to the list', async () => {
    const services = await servicesWithCategories();
    const app = renderApp({ services, route: '/transactions/new' });

    await app.user.type(await screen.findByLabelText('Amount'), '1,234.56');
    await app.user.selectOptions(await screen.findByLabelText('Category'), 'Food');
    await app.user.clear(screen.getByLabelText('Date'));
    await app.user.type(screen.getByLabelText('Date'), '2026-03-10');
    await app.user.type(screen.getByLabelText('Note'), '  Weekly groceries  ');
    await app.user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Transaction saved.')).toBeInTheDocument();
    expect(app.router.state.location.pathname).toBe('/transactions');
    const { items } = await services.vault.repos.transactions.list({});
    expect(items[0]).toMatchObject({
      kind: 'expense',
      amountMinor: 123456,
      currency: 'EUR',
      categoryId: await categoryId(services, 'Food'),
      date: '2026-03-10',
      note: 'Weekly groceries',
    });
    expect(services.vault.flush).toHaveBeenCalled();
  });

  it('edits an existing transaction', async () => {
    const services = await servicesWithCategories();
    const tx = await services.vault.repos.transactions.create({
      kind: 'income',
      amountMinor: 250000,
      currency: 'EUR',
      categoryId: await categoryId(services, 'Salary'),
      date: '2026-03-01',
      note: 'March salary',
    });
    const app = renderApp({ services, route: `/transactions/${tx.id}` });

    const amount = await screen.findByLabelText('Amount');
    expect(amount).toHaveValue('2,500.00');
    await app.user.clear(amount);
    await app.user.type(amount, '2600');
    await app.user.selectOptions(screen.getByLabelText('Category'), 'Freelance');
    await app.user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Transaction saved.')).toBeInTheDocument();
    expect(await services.vault.repos.transactions.get(tx.id)).toMatchObject({
      amountMinor: 260000,
      categoryId: await categoryId(services, 'Freelance'),
      note: 'March salary',
    });
  });

  it('deletes with an Undo toast that restores the transaction', async () => {
    const services = await servicesWithCategories();
    const tx = await services.vault.repos.transactions.create({
      kind: 'expense',
      amountMinor: 999,
      currency: 'EUR',
      categoryId: await categoryId(services, 'Food'),
      date: '2026-03-02',
      note: 'Coffee',
    });
    const app = renderApp({ services, route: `/transactions/${tx.id}` });

    await app.user.click(await screen.findByRole('button', { name: 'Delete' }));

    expect(await screen.findByText('Transaction deleted.')).toBeInTheDocument();
    expect(await services.vault.repos.transactions.get(tx.id)).toBeNull();
    await app.user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByText('Transaction restored.')).toBeInTheDocument();
    expect(await services.vault.repos.transactions.get(tx.id)).toMatchObject({ note: 'Coffee' });
    expect(await screen.findByRole('link', { name: /Coffee/ })).toBeInTheDocument();
  });

  it('shows a not-found message for an unknown id', async () => {
    renderApp({
      services: await servicesWithCategories(),
      route: '/transactions/0192f0c1-7a3b-7c3d-8e4f-000000000000',
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('This item no longer exists.');
  });

  it('shows repository errors generically', async () => {
    const services = await servicesWithCategories();
    services.vault.repos.transactions.create = () =>
      Promise.reject(new Error('SQLITE_IOERR: disk I/O error at 0x1f'));
    const app = renderApp({ services, route: '/transactions/new' });

    await app.user.type(await screen.findByLabelText('Amount'), '5');
    await app.user.selectOptions(await screen.findByLabelText('Category'), 'Food');
    await app.user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong. Please try again.',
    );
    expect(document.body).not.toHaveTextContent('SQLITE');
  });

  it('renders XSS payloads in notes as literal text (SEC-W01)', async () => {
    const services = await servicesWithCategories();
    const payload = '<script>alert(1)</script><img src=x onerror=alert(1)>';
    await services.vault.repos.transactions.create({
      kind: 'expense',
      amountMinor: 100,
      currency: 'EUR',
      categoryId: await categoryId(services, 'Food'),
      date: '2026-03-02',
      note: payload,
    });
    const { container } = renderApp({ services, route: '/transactions' });

    expect(await screen.findByText((text) => text.includes(payload))).toBeInTheDocument();
    expect(container.querySelector('script, img')).toBeNull();
  });

  it('has no axe violations', async () => {
    const app = renderApp({ services: await servicesWithCategories(), route: '/transactions/new' });
    await screen.findByLabelText('Amount');
    await app.user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Enter an amount.');

    expect(await axe(app.container)).toHaveNoViolations();
  });
});
