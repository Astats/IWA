import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import config from '../../capacitor.config';

import { APP_URL_SCHEME } from './deep-link';

/** Through a constant: Vite rewrites `new URL('<literal>', import.meta.url)` into an asset URL. */
const IOS_PROJECT = '../../ios';

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

  it('targets Android only (iOS is out of scope)', () => {
    const sqlite = config.plugins?.CapacitorSQLite as Record<string, unknown> | undefined;

    expect(config.ios).toBeUndefined();
    expect(Object.keys(sqlite ?? {}).filter((k) => k.startsWith('ios'))).toEqual([]);
    expect(existsSync(new URL(IOS_PROJECT, import.meta.url))).toBe(false);
  });

  it('keeps WebView debugging and native logs out of release builds', () => {
    expect(config.android?.webContentsDebuggingEnabled).not.toBe(true);
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
      androidBiometric: { biometricAuth: false },
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
});

describe('screen privacy (SEC-M04)', () => {
  it('sets FLAG_SECURE on the Android activity', () => {
    const activity = read('../../android/app/src/main/java/com/astats/budget/MainActivity.java');

    expect(activity).toMatch(
      /getWindow\(\)\.setFlags\(\s*WindowManager\.LayoutParams\.FLAG_SECURE,/,
    );
  });
});

describe('Android FileProvider', () => {
  it('exposes only the cache export folder to the share sheet', () => {
    const paths = read('../../android/app/src/main/res/xml/file_paths.xml');
    const entries = [...paths.matchAll(/<([\w-]+-path)\b[^>]*>/g)].map((m) => m[0]);

    expect(entries).toEqual(['<cache-path name="exports" path="exports/" />']);
  });
});

describe('release builds (BUILD_PLAN 4.4, SEC-M08)', () => {
  it('minifies, shrinks and never makes the release debuggable', () => {
    const gradle = read('../../android/app/build.gradle');
    const release = /release \{([\s\S]*?)\n {8}\}/.exec(gradle)?.[1] ?? '';

    expect(release).toContain('minifyEnabled true');
    expect(release).toContain('shrinkResources true');
    expect(release).toContain('debuggable false');
  });

  it('signs with a keystore from outside the repository only', () => {
    const gradle = read('../../android/app/build.gradle');

    expect(gradle).toContain("System.getenv('BUDGET_KEYSTORE_PROPERTIES')");
    expect(gradle).not.toMatch(/storePassword\s+['"]/);
    expect(read('../../../../.gitignore')).toMatch(/^keystore\.properties$/m);
  });

  it('keeps the native versions in sync with package.json', () => {
    // Through a variable: Vite rewrites `new URL('<literal>', import.meta.url)` into an asset URL.
    const relative = '../../scripts/sync-native-version.mjs';
    const script = fileURLToPath(new URL(relative, import.meta.url));

    expect(() =>
      execFileSync(process.execPath, [script, '--check'], { stdio: 'pipe' }),
    ).not.toThrow();
  });
});
