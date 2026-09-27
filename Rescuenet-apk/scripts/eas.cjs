// Restrict EAS's archive root to this app, not the parent firmware/server repository.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const result = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--yes', 'eas-cli@24.7.0', ...process.argv.slice(2)], {
  cwd: root, stdio: 'inherit', shell: process.platform === 'win32',
  env: { ...process.env, EAS_NO_VCS: '1', EAS_PROJECT_ROOT: root },
});
if (result.error) { console.error(result.error.message); process.exit(1); }
process.exit(result.status ?? 1);
