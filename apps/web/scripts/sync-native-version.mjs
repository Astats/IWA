#!/usr/bin/env node
// Copies the web app's version (apps/web/package.json) into the native projects (BUILD_PLAN 4.4):
// Android versionName/versionCode in android/app/build.gradle, iOS MARKETING_VERSION and
// CURRENT_PROJECT_VERSION in the Xcode project. The build number is derived from the version
// (major·10000 + minor·100 + patch), so every release has a higher one.
// Usage: node scripts/sync-native-version.mjs [--check]   (--check: fail if out of sync)
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gradleFile = path.join(web, 'android/app/build.gradle');
const pbxprojFile = path.join(web, 'ios/App/App.xcodeproj/project.pbxproj');

const { version } = JSON.parse(readFileSync(path.join(web, 'package.json'), 'utf8'));
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
if (!match) throw new Error(`Version ${version} must be MAJOR.MINOR.PATCH (no pre-release tag)`);
const [major, minor, patch] = match.slice(1).map(Number);
if (minor > 99 || patch > 99) throw new Error(`Minor and patch must be below 100: ${version}`);
const build = major * 10_000 + minor * 100 + patch;
if (build < 1) throw new Error('Version 0.0.0 cannot be released: the build number must be ≥ 1');

/** Replaces every match of each global `pattern` (which must occur); reports whether it changed. */
function update(file, replacements) {
  const before = readFileSync(file, 'utf8');
  let after = before;
  for (const [pattern, value] of replacements) {
    if (!after.match(pattern)) throw new Error(`${String(pattern)} not found in ${file}`);
    after = after.replace(pattern, value);
  }
  return { file, before, after, changed: before !== after };
}

const results = [
  update(gradleFile, [
    [/versionCode \d+/g, `versionCode ${build}`],
    [/versionName "[^"]*"/g, `versionName "${version}"`],
  ]),
  update(pbxprojFile, [
    [/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${build};`],
    [/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`],
  ]),
];

if (process.argv.includes('--check')) {
  const stale = results.filter((r) => r.changed).map((r) => path.relative(web, r.file));
  if (stale.length > 0) {
    console.error(`Native versions differ from ${version}: ${stale.join(', ')}`);
    console.error('Run: node scripts/sync-native-version.mjs');
    process.exit(1);
  }
  console.log(`Native versions match ${version} (build ${String(build)})`);
} else {
  for (const r of results) if (r.changed) writeFileSync(r.file, r.after);
  console.log(`Native versions set to ${version} (build ${String(build)})`);
}
