import { CategoriesPage } from '../pages/CategoriesPage';
import { expect, test } from '../fixtures/app.fixture';

test.describe('J6 categories', () => {
  test('@smoke default categories, create, rename, recolor, reorder and delete', async ({
    onboardedApp: app,
    page,
  }) => {
    const categories = new CategoriesPage(page);
    await app.shell.navigate('Categories');
    await categories.expectLoaded();
    await expect(categories.list('expense').getByRole('listitem')).toHaveCount(8);
    await expect(categories.list('income').getByRole('listitem')).toHaveCount(5);

    await categories.create({ name: 'Pets', color: '#336699', icon: 'Pets' });
    await expect(categories.list('expense').getByText('Pets')).toBeVisible();

    await categories.edit('Pets', { name: 'Animals', color: '#aa3300' });
    await expect(categories.list('expense').getByText('Animals')).toBeVisible();

    await page.getByRole('button', { name: 'Move Animals up' }).click();
    await expect(categories.list('expense').getByRole('listitem').nth(7)).toHaveText('Animals');

    const panel = await categories.startDelete('Animals');
    await panel.getByRole('button', { name: 'Delete' }).click();
    await expect(categories.notice).toHaveText('Category "Animals" deleted.');
    await expect(categories.list('expense').getByText('Animals')).toHaveCount(0);
  });

  test('rejects a duplicate name with a translated message', async ({
    onboardedApp: app,
    page,
  }) => {
    const categories = new CategoriesPage(page);
    await app.shell.navigate('Categories');

    await page.getByRole('button', { name: 'New expense category' }).click();
    const form = page.getByRole('form', { name: 'Create category' });
    await form.getByLabel('Name').fill('FOOD');
    await form.getByRole('button', { name: 'Create category' }).click();

    await expect(form.getByRole('alert')).toHaveText('A category with this name already exists.');
    await expect(categories.list('expense').getByRole('listitem')).toHaveCount(8);
  });
});
