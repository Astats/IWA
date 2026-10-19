import { ProviderError, type OAuthSession } from '../../src';

/** OAuthSession double: sign-in always succeeds and yields `token`. */
export class FakeSession implements OAuthSession {
  signedIn = false;
  signIns = 0;

  constructor(public token = 'test-access-token') {}

  isSignedIn(): boolean {
    return this.signedIn;
  }

  signIn(): Promise<void> {
    this.signIns++;
    this.signedIn = true;
    return Promise.resolve();
  }

  getAccessToken(): Promise<string> {
    if (!this.signedIn) return Promise.reject(new ProviderError('AUTH_REQUIRED'));
    return Promise.resolve(this.token);
  }

  signOut(): Promise<void> {
    this.signedIn = false;
    return Promise.resolve();
  }
}
