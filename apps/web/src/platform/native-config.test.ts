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
  // Biometric unlock (Step 4.3) keeps its own biometric-bound key; the plugin's gate stays off.
  it("turns SQLCipher on and leaves the plugin's own biometric gate off", () => {
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

    const schemes = [...(urlTypes?.[1] ?? '').matchAll(/<string>([^<]*)<\/string>/g)].map(
      (m) => m[1],
    );

    expect(schemes).toContain(APP_URL_SCHEME);
    // Besides the app's own scheme, only Google's reversed iOS client id (native sign-in).
    for (const scheme of schemes.filter((s) => s !== APP_URL_SCHEME)) {
      expect(scheme).toMatch(/^com\.googleusercontent\.apps\.[\w-]+$/);
    }
  });
});

describe('screen privacy (SEC-M04)', () => {
  it('sets FLAG_SECURE on the Android activity', () => {
    const activity = read('../../android/app/src/main/java/com/astats/budget/MainActivity.java');

    expect(activity).toMatch(
      /getWindow\(\)\.setFlags\(\s*WindowManager\.LayoutParams\.FLAG_SECURE,/,
    );
  });

  it('covers the iOS window before the app switcher snapshot', () => {
    const scene = read('../../ios/App/App/SceneDelegate.swift');

    expect(scene).toContain('func sceneWillResignActive');
    expect(scene).toContain('window.addSubview(cover)');
    expect(scene).toContain('func sceneDidBecomeActive');
  });
});

describe('Android FileProvider', () => {
  it('exposes only the cache export folder to the share sheet', () => {
    const paths = read('../../android/app/src/main/res/xml/file_paths.xml');
    const entries = [...paths.matchAll(/<([\w-]+-path)\b[^>]*>/g)].map((m) => m[0]);

    expect(entries).toEqual(['<cache-path name="exports" path="exports/" />']);
  });
});
