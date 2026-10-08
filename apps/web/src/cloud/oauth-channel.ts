/** Same-origin channel between an OAuth redirect page and the app window (no imports: the
 * redirect page bundles only this). */
export const OAUTH_CHANNEL = 'budget-oauth';

export interface RedirectMessage {
  state: string;
  code?: string;
  error?: string;
}
