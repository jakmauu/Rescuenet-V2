const { withAndroidManifest, withDangerousMod } = require('expo/config-plugins');
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = function withLocalNetwork(config) {
  config = withAndroidManifest(config, (mod) => {
    const application = mod.modResults.manifest.application[0];
    application.$['android:networkSecurityConfig'] = '@xml/rescuenet_network_security';
    application.$['android:usesCleartextTraffic'] = 'false';
    return mod;
  });
  return withDangerousMod(config, ['android', async (mod) => {
    const directory = path.join(mod.modRequest.platformProjectRoot, 'app/src/main/res/xml');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'rescuenet_network_security.xml'), `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="false" />
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">192.168.4.1</domain>
  </domain-config>
</network-security-config>
`);
    // Debug-only resource overlay lets Metro work on a developer's LAN.
    // Release/preview APK still uses the single-IP allowlist above.
    const debugDirectory = path.join(mod.modRequest.platformProjectRoot, 'app/src/debug/res/xml');
    await fs.mkdir(debugDirectory, { recursive: true });
    await fs.writeFile(path.join(debugDirectory, 'rescuenet_network_security.xml'), `<?xml version="1.0" encoding="utf-8"?>
<network-security-config><base-config cleartextTrafficPermitted="true" /></network-security-config>
`);
    return mod;
  }]);
};
