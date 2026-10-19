import { ProviderError } from '@budget/backup';
import { z } from 'zod';

import { OAUTH_CHANNEL } from './oauth-channel';

/*
 * Authorization-code popup flow for providers without an SDK (Dropbox). The popup returns to
 * /auth/callback/<provider>, a separate page (src/auth/oauth-redirect.ts) that posts the result
 * on a same-origin BroadcastChannel and closes itself; this module checks `state` and returns
 * the code. Nothing touches Web Storage.
 */

/** Messages arrive from another window: validated like any external input. */
const messageSchema = z.object({
  state: z.string().max(200),
  code: z.string().min(1).max(4096).optional(),
  error: z.string().max(200).optional(),
});

interface ChannelLike {
  onmessage: ((event: MessageEvent) => void) | null;
  close(): void;
}

export interface PopupDeps {
  /** Opens the (blank) popup. Must run synchronously inside the click handler. */
  open: () => Window | null;
  channel: () => ChannelLike;
  /** How often to check whether the user closed the popup. */
  pollMs?: number;
  /** After the popup closes, how long a late redirect message may still arrive. */
  closeGraceMs?: number;
  timeoutMs?: number;
}

export const browserPopupDeps: PopupDeps = {
  open: () => window.open('about:blank', 'budget-oauth', 'popup=yes,width=520,height=720'),
  channel: () => new BroadcastChannel(OAUTH_CHANNEL),
};

/**
 * Waits for the redirect carrying `state`. Resolves with the authorization code; rejects with
 * CANCELLED (closed, denied, timed out) or UNAVAILABLE (state mismatch, malformed response).
 */
export function waitForRedirect(state: string, popup: Window, deps: PopupDeps): Promise<string> {
  const { pollMs = 500, closeGraceMs = 1500, timeoutMs = 10 * 60_000 } = deps;
  return new Promise<string>((resolve, reject) => {
    const channel = deps.channel();
    let closedAt: number | null = null;
    const started = Date.now();
    const finish = (result: { code: string } | { error: ProviderError }) => {
      clearInterval(poll);
      channel.onmessage = null;
      channel.close();
      if ('code' in result) resolve(result.code);
      else reject(result.error);
    };
    channel.onmessage = (event) => {
      const parsed = messageSchema.safeParse(event.data);
      if (!parsed.success) {
        finish({ error: new ProviderError('UNAVAILABLE', 'Malformed redirect') });
        return;
      }
      const message = parsed.data;
      // A response for another sign-in (or a forged one) is rejected: CSRF protection.
      if (message.state !== state) {
        finish({ error: new ProviderError('UNAVAILABLE', 'OAuth state mismatch') });
      } else if (message.error || !message.code) {
        finish({ error: new ProviderError('CANCELLED') });
      } else {
        finish({ code: message.code });
      }
    };
    const poll = setInterval(() => {
      const now = Date.now();
      if (now - started > timeoutMs) {
        finish({ error: new ProviderError('CANCELLED', 'Sign-in timed out') });
        return;
      }
      if (!popup.closed) return;
      closedAt ??= now;
      if (now - closedAt >= closeGraceMs) finish({ error: new ProviderError('CANCELLED') });
    }, pollMs);
  });
}
