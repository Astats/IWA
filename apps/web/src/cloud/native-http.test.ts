import { describe, expect, it, vi } from 'vitest';

const http = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('@capacitor/core', () => ({ CapacitorHttp: http }));

const { nativePostForm } = await import('./native-http');

describe('nativePostForm', () => {
  it('posts the form natively and returns parsed JSON', async () => {
    http.post.mockResolvedValueOnce({ status: 200, data: { access_token: 'a' }, headers: {} });

    const result = await nativePostForm('https://login.example/token', { code: 'c' });

    expect(http.post).toHaveBeenCalledWith({
      url: 'https://login.example/token',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      data: { code: 'c' },
    });
    expect(result).toEqual({ status: 200, data: { access_token: 'a' } });
  });

  it('parses JSON sent as text and keeps other text as is', async () => {
    http.post.mockResolvedValueOnce({ status: 400, data: '{"error":"invalid_grant"}' });
    expect(await nativePostForm('https://x.example', {})).toEqual({
      status: 400,
      data: { error: 'invalid_grant' },
    });

    http.post.mockResolvedValueOnce({ status: 502, data: '<html>' });
    expect((await nativePostForm('https://x.example', {})).data).toBe('<html>');
  });
});
