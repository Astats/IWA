#!/usr/bin/env node
// Instrumented repository-contract run on an Android emulator/device (BUILD_PLAN 4.2 DoD).
//
//   node scripts/native-contract.mjs          (from apps/web, with one emulator/device attached)
//
// Builds native-test/ (the contract suite + a Vitest-compatible runner), installs it as the debug
// app, runs it, and prints the results read from the page over the WebView's DevTools socket
// (debug builds only; the app has no native logging). ⚠ It uninstalls the app first, deleting its
// data on the device: the plugin's secret store is shared by every database of the app (and
// `pm clear` crashes on API 37 emulators). Afterwards the test app is uninstalled again and the
// native project is synced back to the normal web build (dist/).
//
// Needs ANDROID_HOME (or ANDROID_SDK_ROOT) and a JDK 21–24 in JAVA_HOME for Gradle.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const APP_ID = 'com.astats.budget';
const TIMEOUT_MS = 10 * 60_000;
const DEVTOOLS_PORT = 9334;
const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
if (!sdk) throw new Error('Set ANDROID_HOME to the Android SDK');
const adb = path.join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
const isWin = process.platform === 'win32';

/** Runs a command and fails loudly; `shell` only for the .cmd/.bat wrappers on Windows. */
function sh(cmd, args, options = {}) {
  const res = spawnSync(cmd, args, { cwd: web, stdio: 'inherit', shell: isWin, ...options });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${String(res.status)})`);
}
const adbOut = (...args) => execFileSync(adb, args, { encoding: 'utf8' });

/** Evaluates `expression` in the app's WebView page (DevTools protocol over `adb forward`). */
async function evalInPage(expression) {
  const pid = adbOut('shell', 'pidof', APP_ID).trim();
  if (!pid) return null;
  adbOut('forward', `tcp:${String(DEVTOOLS_PORT)}`, `localabstract:webview_devtools_remote_${pid}`);
  const targets = await (await fetch(`http://127.0.0.1:${String(DEVTOOLS_PORT)}/json`)).json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) return null;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  try {
    return await new Promise((resolve, reject) => {
      ws.onerror = () => {
        reject(new Error('DevTools connection failed'));
      };
      ws.onopen = () => {
        const params = { expression, returnByValue: true };
        ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params }));
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(String(e.data));
        if (msg.id === 1) resolve(msg.result?.result?.value ?? null);
      };
    });
  } finally {
    ws.close();
  }
}

function uninstall() {
  try {
    adbOut('uninstall', APP_ID);
  } catch {
    // not installed, or no device
  }
}

function syncNormalBuild() {
  if (existsSync(path.join(web, 'dist'))) sh('npx', ['cap', 'sync', 'android']);
  else
    console.warn(
      'dist/ missing: run `pnpm --filter web build && npx cap sync` before using the app.',
    );
}

sh('npx', ['vite', 'build', '--config', 'native-test/vite.config.ts']);
sh('npx', ['cap', 'sync', 'android'], { env: { ...process.env, CAP_WEB_DIR: 'dist-native-test' } });
try {
  const gradlew = path.join(web, 'android', isWin ? 'gradlew.bat' : 'gradlew');
  sh(isWin ? `"${gradlew}"` : gradlew, ['assembleDebug', '-q'], { cwd: path.join(web, 'android') });
  const apk = path.join(web, 'android/app/build/outputs/apk/debug/app-debug.apk');
  uninstall();
  adbOut('install', apk);
  adbOut('shell', 'am', 'start', '-n', `${APP_ID}/.MainActivity`);

  const seen = new Set();
  const deadline = Date.now() + TIMEOUT_MS;
  let done = null;
  while (!done && Date.now() < deadline) {
    await sleep(2000);
    const text = await evalInPage("document.getElementById('out')?.textContent ?? ''").catch(
      () => null,
    );
    for (const line of (text ?? '').split('\n')) {
      if (!line || seen.has(line)) continue;
      seen.add(line);
      console.log(line);
      if (line.startsWith('DONE')) done = line;
    }
  }
  if (!done) throw new Error('Timed out waiting for the contract run');
  const failed = Number(/failed=(\d+)/.exec(done)?.[1] ?? 1);
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  try {
    adbOut('forward', '--remove', `tcp:${String(DEVTOOLS_PORT)}`);
  } catch {
    // no forward was set up
  }
  // Leave the device without the test app and the native project with the normal build.
  uninstall();
  syncNormalBuild();
}
