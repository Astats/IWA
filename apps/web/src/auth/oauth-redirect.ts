import { OAUTH_CHANNEL, type RedirectMessage } from '@/cloud/oauth-channel';

/*
 * Runs in the sign-in popup after the provider redirects back (Dropbox, BUILD_PLAN 3.4). Passes
 * `state` and `code` (or `error`) to the app window over a same-origin BroadcastChannel, removes
 * them from the URL and history, and closes the popup. The app itself is not loaded here.
 */
const params = new URLSearchParams(window.location.search);
const message: RedirectMessage = { state: params.get('state') ?? '' };
const code = params.get('code');
const error = params.get('error');
if (code) message.code = code;
if (error) message.error = error;
window.history.replaceState(null, '', window.location.pathname);

const channel = new BroadcastChannel(OAUTH_CHANNEL);
channel.postMessage(message);
channel.close();
window.close();
