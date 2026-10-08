import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { downloadFile, timestampedName } from '@/lib/download';
import { createFakeServices } from '@/test/fake-services';
import { renderApp } from '@/test/render';

/** Captures what downloadFile hands to the browser (jsdom has no Blob URLs or downloads). */
function captureDownloads() {
  const blobs = new Map<string, Blob>();
  const downloads: Array<{ name: string; blob: Blob }> = [];
  let n = 0;
  vi.stubGlobal(
    'URL',
    Object.assign(URL, {
      createObjectURL: vi.fn((blob: Blob) => {
        const url = `blob:test/${++n}`;
        blobs.set(url, blob);
        return url;
      }),
      revokeObjectURL: vi.fn((url: string) => {
        blobs.delete(url);
      }),
    }),
  );
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    const blob = blobs.get(this.href);
    if (blob) downloads.push({ name: this.download, blob });
  });
  return { downloads, blobs };
}

let capture: ReturnType<typeof captureDownloads>;

beforeEach(() => {
  capture = captureDownloads();
});

afterEach(() => {
  vi.useRealTimers();
});

async function seeded() {
  const services = createFakeServices();
  const repos = services.vault.repos;
  await repos.categories.seedDefaults();
  const cats = await repos.categories.list();
  const id = (name: string) => cats.find((c) => c.name === name)!.id;
  await repos.transactions.bulkInsert([
    {
      kind: 'expense',
      amountMinor: 1250,
      currency: 'EUR',
      categoryId: id('Food'),
      date: '2026-03-01',
      note: '=cmd|calc',
    },
    {
      kind: 'income',
      amountMinor: 300000,
      currency: 'EUR',
      categoryId: id('Salary'),
      date: '2026-03-02',
      note: 'Salary, March',
    },
    ...Array.from({ length: 600 }, (_, i) => ({
      kind: 'expense' as const,
      amountMinor: 100 + i,
      currency: 'EUR',
      categoryId: id('Other'),
      date: '2025-06-01',
      note: `Old ${i}`,
    })),
  ]);
  return services;
}

describe('downloadFile', () => {
  it('downloads through a Blob URL that is revoked afterwards', async () => {
    vi.useFakeTimers();

    downloadFile('x.csv', 'a,b', 'text/csv');

    expect(capture.downloads[0]?.name).toBe('x.csv');
    expect(await capture.downloads[0]?.blob.text()).toBe('a,b');
    vi.runAllTimers();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test/1');
    expect(capture.blobs.size).toBe(0);
  });

  it('builds timestamped file names', () => {
    expect(timestampedName('budget-transactions', 'csv', new Date(2026, 2, 5, 7, 8, 9))).toBe(
      'budget-transactions-20260305-070809.csv',
    );
  });
});

describe('CSV export', () => {
  it('exports all transactions with formula escaping', async () => {
    const app = renderApp({ services: await seeded(), route: '/import-export' });

    await app.user.click(await screen.findByRole('button', { name: 'Export all transactions' }));

    expect(await screen.findByText('Exported 602 transaction(s).')).toBeInTheDocument();
    const file = capture.downloads[0]!;
    expect(file.name).toMatch(/^budget-transactions-\d{8}-\d{6}\.csv$/);
    // Blob.text() strips a BOM while decoding, so check the raw bytes for it.
    const bytes = new Uint8Array(await file.blob.arrayBuffer());
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = await file.blob.text();
    expect(text.startsWith('date,kind,amount,currency,category,note,id\r\n')).toBe(true);
    expect(text).toContain(",'=cmd|calc,");
    expect(text).toContain('"Salary, March"');
    expect(text.trim().split('\r\n')).toHaveLength(603);
  });

  it('exports the current filtered view across all pages from the transactions list', async () => {
    const app = renderApp({ services: await seeded(), route: '/transactions?kind=expense' });
    await screen.findByText(/of 601/);

    await app.user.click(screen.getByRole('button', { name: 'Export this view' }));

    await waitFor(() => {
      expect(capture.downloads).toHaveLength(1);
    });
    const lines = (await capture.downloads[0]!.blob.text()).trim().split('\r\n');
    expect(lines).toHaveLength(602); // header + 601 expenses on 2 pages
    expect(lines.some((l) => l.includes('Salary'))).toBe(false);
  });
});
