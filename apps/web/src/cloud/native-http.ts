import { CapacitorHttp } from '@capacitor/core';

import type { PostForm } from './native-oauth';

/**
 * Form POST through Capacitor's native HTTP stack (outside the WebView, so no CORS and no
 * `Origin` header). Used only for OAuth code redemption on Android/iOS; global fetch patching
 * (`CapacitorHttp.enabled`) stays off.
 */
export const nativePostForm: PostForm = async (url, form) => {
  const response = await CapacitorHttp.post({
    url,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    data: form,
  });
  let data: unknown = response.data;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      // not JSON: the caller rejects it as a malformed response
    }
  }
  return { status: response.status, data };
};
