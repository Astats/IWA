import { broadcastResponseToMainFrame } from '@azure/msal-browser/redirect-bridge';

/*
 * Runs in the sign-in popup after Microsoft redirects back (BUILD_PLAN 3.2). It hands the
 * authorization response to the app window over a BroadcastChannel and closes the popup. The app
 * itself is not loaded here. On failure the popup stays open; the app reports a cancelled sign-in.
 */
broadcastResponseToMainFrame().catch(() => undefined);
