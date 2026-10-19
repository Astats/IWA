import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { parseJson, readBytes, statusToCode, withSession } from '../src';
import { expectProviderError } from './contract/provider.contract';
import { FakeSession } from './mocks/fake-session';

function stream(chunks: Uint8Array[], fail = false): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      if (fail) controller.error(new Error('connection reset'));
      else controller.close();
    },
  });
}

describe('statusToCode', () => {
  it.each([
    [401, 'AUTH_REQUIRED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [409, 'CONFLICT'],
    [412, 'CONFLICT'],
    [429, 'RATE_LIMITED'],
    [400, 'UNAVAILABLE'],
    [503, 'UNAVAILABLE'],
  ])('%i → %s', (status, code) => {
    expect(statusToCode(status)).toBe(code);
  });
});

describe('readBytes', () => {
  it('rejects a declared Content-Length over the limit without reading', async () => {
    const response = new Response(stream([new Uint8Array(4)]), {
      headers: { 'content-length': '11' },
    });
    await expectProviderError(readBytes(response, 10), 'INVALID_RESPONSE');
  });

  it('stops reading as soon as a stream exceeds the limit', async () => {
    const response = new Response(stream([new Uint8Array(6), new Uint8Array(6)]));
    await expectProviderError(readBytes(response, 10), 'INVALID_RESPONSE');
  });

  it('joins the chunks of a stream within the limit', async () => {
    const response = new Response(stream([Uint8Array.of(1, 2), Uint8Array.of(3)]));
    expect(await readBytes(response, 10)).toEqual(Uint8Array.of(1, 2, 3));
  });

  it('handles a response without a body', async () => {
    expect(await readBytes(new Response(null), 10)).toEqual(new Uint8Array(0));
  });

  it('maps a dropped connection to NETWORK', async () => {
    const response = new Response(stream([Uint8Array.of(1)], true));
    await expectProviderError(readBytes(response, 10), 'NETWORK');
  });
});

describe('parseJson', () => {
  it('rejects non-JSON and wrongly shaped bodies', async () => {
    await expectProviderError(parseJson(new Response('<html>'), z.object({})), 'INVALID_RESPONSE');
    await expectProviderError(
      parseJson(Response.json({ a: 1 }), z.object({ b: z.string() })),
      'INVALID_RESPONSE',
    );
  });
});

describe('withSession', () => {
  it('requires a signed-in session and keeps it on non-auth errors', async () => {
    const session = new FakeSession();
    await expectProviderError(
      withSession(session, () => Promise.resolve(1)),
      'AUTH_REQUIRED',
    );
    session.signedIn = true;
    await expect(withSession(session, () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    expect(session.isSignedIn()).toBe(true);
  });
});
