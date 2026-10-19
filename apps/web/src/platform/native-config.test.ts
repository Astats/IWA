import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import config from '../../capacitor.config';

import { APP_URL_SCHEME } from './deep-link';

const read = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), { encoding: 'utf8' });

/** The native shells' security-relevant settings (BUILD_PLAN 4.1, TEST_PLAN SEC-M06/M08). */
describe('Capacitor config', () => {
  it('serves the bundled build over https://localhost', () => {
    expect(config.appId).toBe('com.astats.budget');
    expect(config.webDir).toBe('dist');
    expect(config.server?.androidScheme).toBe('https');
  });

  it('has no live-reload or cleartext settings that must never ship', () => {
    expect(config.server?.url).toBeUndefined();
    expect(config.server?.cleartext).not.toBe(true);
    expect(config.android?.allowMixedContent).not.toBe(true);
  });

  it('keeps WebView debugging and native logs out of release builds', () => {
    expect(config.android?.webContentsDebuggingEnabled).not.toBe(true);
    expect(config.ios?.webContentsDebuggingEnabled).not.toBe(true);
    // 'debug' would log plugin-call arguments (the SQLCipher secret) to logcat.
    expect(config.loggingBehavior).toBe('none');
  });
});

describe('native storage (BUILD_PLAN 4.2)', () => {
  it('turns SQLCipher on and keeps biometrics off until Step 4.3', () => {
    const sqlite = config.plugins?.CapacitorSQLite as Record<string, unknown> | undefined;

    expect(sqlite).toMatchObject({
      androidIsEncryption: true,
      iosIsEncryption: true,
      androidBiometric: { biometricAuth: false },
      iosBiometric: { biometricAuth: false },
    });
  });

  it('keeps app data out of Android backup and device transfer', () => {
    const manifest = read('../../android/app/src/main/AndroidManifest.xml');
    const rules = read('../../android/app/src/main/res/xml/data_extraction_rules.xml');

    expect(manifest).toContain('android:allowBackup="false"');
    expect(manifest).toContain('android:fullBackupContent="false"');
    expect(manifest).toContain('android:dataExtractionRules="@xml/data_extraction_rules"');
    for (const section of ['cloud-backup', 'device-transfer']) {
      const body = new RegExp(`<${section}>([\\s\\S]*?)</${section}>`).exec(rules)?.[1] ?? '';
      for (const domain of ['root', 'file', 'database', 'sharedpref', 'external']) {
        expect(body, `${section} ${domain}`).toContain(`<exclude domain="${domain}" />`);
      }
    }
  });
});

describe('Android manifest', () => {
  it('exports only the launcher activity (SEC-M06)', () => {
    const manifest = read('../../android/app/src/main/AndroidManifest.xml');
    const exported = [...manifest.matchAll(/<(\w+)\b[^>]*android:exported="true"[^>]*>/g)];

    expect(exported.map((m) => m[1])).toEqual(['activity']);
    expect(exported[0]?.[0]).toContain('android:name=".MainActivity"');
  });
});

describe('app link registration', () => {
  it('is the scheme of the appId', () => {
    expect(APP_URL_SCHEME).toBe(config.appId);
  });

  it('is in the Android manifest as a browsable VIEW filter of the main activity', () => {
    const manifest = read('../../android/app/src/main/AndroidManifest.xml');
    const filter = /<intent-filter>(?:(?!<\/intent-filter>)[\s\S])*<\/intent-filter>/g;
    const viewFilters = (manifest.match(filter) ?? []).filter((f) =>
      f.includes('android.intent.action.VIEW'),
    );

    expect(viewFilters).toHaveLength(1);
    expect(viewFilters[0]).toContain('android.intent.category.BROWSABLE');
    expect(viewFilters[0]).toContain(`android:scheme="${APP_URL_SCHEME}"`);
    expect(viewFilters[0]).not.toContain('android:host');
  });

  it('is in the iOS Info.plist URL types', () => {
    const plist = read('../../ios/App/App/Info.plist');
    const urlTypes = /<key>CFBundleURLSchemes<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist);

    expect(urlTypes?.[1]?.trim()).toBe(`<string>${APP_URL_SCHEME}</string>`);
  });
});
