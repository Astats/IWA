import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { axe } from '@/test/axe';
import { createFakeServices } from '@/test/fake-services';
import { renderApp } from '@/test/render';

async function setup() {
  const services = createFakeServices();
  await services.vault.repos.categories.seedDefaults();
  const app = renderApp({ services, route: '/categories' });
  await within(await screen.findByRole('list', { name: 'Expense categories' })).findByText(
    'Housing',
  );
  return app;
}

const expenseList = () => screen.getByRole('list', { name: 'Expense categories' });
const incomeList = () => screen.getByRole('list', { name: 'Income categories' });

describe('CategoriesPage', () => {
  it('lists default categories grouped by kind', async () => {
    await setup();

    expect(
      within(expenseList())
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      'Housing',
      'Food',
      'Transport',
      'Utilities',
      'Health',
      'Entertainment',
      'Shopping',
      'Other',
    ]);
    expect(within(incomeList()).getAllByRole('listitem')).toHaveLength(5);
  });

  it('creates a category with name, color and icon', async () => {
    const app = await setup();

    await app.user.click(screen.getByRole('button', { name: 'New expense category' }));
    const form = screen.getByRole('form', { name: 'Create category' });
    await app.user.type(within(form).getByLabelText('Name'), '  Pets  ');
    fireEvent.input(within(form).getByLabelText('Color'), { target: { value: '#123abc' } });
    await app.user.click(within(form).getByRole('radio', { name: 'Pets' }));
    await app.user.click(within(form).getByRole('button', { name: 'Create category' }));

    expect(await screen.findByText('Category "Pets" created.')).toBeInTheDocument();
    const created = (await app.services.vault.repos.categories.list()).find(
      (c) => c.name === 'Pets',
    );
    expect(created).toMatchObject({
      kind: 'expense',
      color: '#123abc',
      icon: 'paw-print',
      sortOrder: 8,
    });
    expect(app.services.vault.flush).toHaveBeenCalled();
  });

  it('shows validation and duplicate-name errors', async () => {
    const app = await setup();
    await app.user.click(screen.getByRole('button', { name: 'New expense category' }));
    const form = screen.getByRole('form', { name: 'Create category' });

    await app.user.click(within(form).getByRole('button', { name: 'Create category' }));
    expect(
      await within(form).findByText('Enter a name of 1 to 50 characters.'),
    ).toBeInTheDocument();

    await app.user.type(within(form).getByLabelText('Name'), 'food');
    await app.user.click(within(form).getByRole('button', { name: 'Create category' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent(
      'A category with this name already exists.',
    );
  });

  it('renames and recolors a category', async () => {
    const app = await setup();

    await app.user.click(screen.getByRole('button', { name: 'Edit Food' }));
    const form = screen.getByRole('form', { name: 'Save' });
    await app.user.clear(within(form).getByLabelText('Name'));
    await app.user.type(within(form).getByLabelText('Name'), 'Groceries');
    fireEvent.input(within(form).getByLabelText('Color'), { target: { value: '#ff00aa' } });
    await app.user.click(within(form).getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Category "Groceries" saved.')).toBeInTheDocument();
    expect(within(expenseList()).getByText('Groceries')).toBeInTheDocument();
    const food = (await app.services.vault.repos.categories.list()).find(
      (c) => c.name === 'Groceries',
    );
    expect(food?.color).toBe('#ff00aa');
  });

  it('deletes an unused category after confirmation', async () => {
    const app = await setup();

    await app.user.click(screen.getByRole('button', { name: 'Delete Shopping' }));
    const panel = screen.getByRole('group', { name: 'Delete Shopping' });
    expect(within(panel).getByText('Delete the category "Shopping"?')).toBeInTheDocument();
    await app.user.click(within(panel).getByRole('button', { name: 'Delete' }));

    expect(await screen.findByText('Category "Shopping" deleted.')).toBeInTheDocument();
    expect(within(expenseList()).queryByText('Shopping')).toBeNull();
  });

  it('blocks deleting a category in use, then reassigns its transactions and deletes it', async () => {
    const services = createFakeServices();
    const repos = services.vault.repos;
    await repos.categories.seedDefaults();
    const food = (await repos.categories.list()).find((c) => c.name === 'Food')!;
    const transport = (await repos.categories.list()).find((c) => c.name === 'Transport')!;
    for (const note of ['a', 'b']) {
      await repos.transactions.create({
        kind: 'expense',
        amountMinor: 100,
        currency: 'EUR',
        categoryId: food.id,
        date: '2026-03-01',
        note,
      });
    }
    const app = renderApp({ services, route: '/categories' });

    await app.user.click(await screen.findByRole('button', { name: 'Delete Food' }));
    const panel = screen.getByRole('group', { name: 'Delete Food' });
    expect(await within(panel).findByText(/is used by 2 transaction/)).toBeInTheDocument();
    await app.user.selectOptions(within(panel).getByLabelText('Move transactions to'), 'Transport');
    await app.user.click(
      within(panel).getByRole('button', { name: 'Move transactions and delete' }),
    );

    expect(await screen.findByText('Category "Food" deleted.')).toBeInTheDocument();
    expect((await repos.transactions.list({ categoryIds: [transport.id] })).total).toBe(2);
    expect(await repos.categories.get(food.id)).toBeNull();
  });

  it('reorders with move up / move down buttons', async () => {
    const app = await setup();

    await app.user.click(screen.getByRole('button', { name: 'Move Food up' }));

    expect(await within(expenseList()).findAllByRole('listitem')).toSatisfy(
      (items: HTMLElement[]) => items[0]?.textContent === 'Food',
    );
    expect(screen.getByRole('button', { name: 'Move Food up' })).toBeDisabled();
    await app.user.click(screen.getByRole('button', { name: 'Move Food down' }));
    expect((await app.services.vault.repos.categories.list({ kind: 'expense' }))[1]?.name).toBe(
      'Food',
    );
  });

  it('renders category names as literal text (SEC-W01)', async () => {
    const services = createFakeServices();
    const payload = '<img src=x onerror=alert(1)>';
    await services.vault.repos.categories.create({
      name: payload,
      kind: 'income',
      color: '#000000',
      icon: 'tag',
    });
    const { container } = renderApp({ services, route: '/categories' });

    expect(await screen.findByText(payload)).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });

  it('has no axe violations, including with an open form', async () => {
    const app = await setup();
    expect(await axe(app.container)).toHaveNoViolations();

    await app.user.click(screen.getByRole('button', { name: 'New income category' }));

    expect(await axe(app.container)).toHaveNoViolations();
  });
});
