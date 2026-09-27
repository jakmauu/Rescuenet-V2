import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('native config requests background capability explicitly without global release ATS bypass', () => {
  const config = JSON.parse(readFileSync(resolve('app.json'), 'utf8')).expo;
  assert.equal(config.android.allowBackup, false);
  assert.equal(config.ios.infoPlist.NSAppTransportSecurity.NSAllowsArbitraryLoads, undefined);
  assert.equal(config.ios.infoPlist.NSAppTransportSecurity.NSExceptionDomains['192.168.4.1'].NSExceptionAllowsInsecureHTTPLoads, true);
  const location = config.plugins.find((plugin: unknown) => Array.isArray(plugin) && plugin[0] === 'expo-location');
  assert.equal(location[1].isAndroidForegroundServiceEnabled, true);
  assert.equal(location[1].isIosBackgroundLocationEnabled, true);
});
test('preview is an APK; development client is not required for preview runtime', () => {
  const config = JSON.parse(readFileSync(resolve('eas.json'), 'utf8'));
  assert.equal(config.build.preview.android.buildType, 'apk');
  assert.equal(config.build.preview.developmentClient, undefined);
  assert.equal(config.build.development.developmentClient, true);
});
