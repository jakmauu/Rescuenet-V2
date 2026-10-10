# RescueNet V2 PWA — Deployment and Rollback

## Before publishing

1. Review the specific PWA, documentation, test and Pages-workflow diffs. Do not stage the whole dirty repository (see `RESCUENET_PWA_GITHUB_READINESS.md`).
2. Run the Node PWA suite and server API tests from `RESCUENET_PWA_FINAL_TEST_PLAN.md`.
3. Verify that the Pages source is configured for GitHub Actions. A successful push alone does not change a repository's Pages source setting.
4. Review the public-data implications: PWA local access is not authenticated, and public dashboard/API access must not expose real locations without an access-control/network decision.
5. The workflow requires GitHub Actions Pages deployment permissions (`pages: write`, `id-token: write`) and GitHub Pages configured to use GitHub Actions. It now copies `location-scheduler.mjs` as well as the other app shell modules.

## Deploy PWA source (user-controlled)

After review, commit/push only the intended files. The repository workflow deploys the static PWA under the repository's GitHub Pages path. Confirm the Actions run succeeds, open the workflow's deployment URL, then test in a normal browser before installing on iPhone. The workflow uses no server secrets and deploys only static PWA files.

The PWA cannot be considered field-ready just because GitHub Pages deployment succeeds. It still needs iPhone validation for secure-context GPS and HTTPS-to-private-HTTP Field Node access.

## Component boundaries

- GitHub Pages: static PWA shell only.
- ESP32 Field Node: its own firmware; no build/upload in this task.
- Gateway: its own firmware; no build/upload in this task.
- Raspberry Pi: server Python code, MQTT, serial bridge, database and dashboard; no deployment/restart in this task.
- PWA/browser storage is not synchronized to the Raspberry Pi until a Field Node/API request is actually accepted and later forwarded.

## Backup and rollback

- Preserve the current deployed Pages artifact/revision and current local working-tree edits before changing branches or staging.
- For rollback, redeploy a reviewed previous Git revision through the existing Actions workflow; do not force-push or erase user changes.
- PWA cache name is `rescuenet-pwa-v6`; activation removes older caches with the same prefix after the new app shell installs. A page already open during update may need a manual close/reopen. Local profile/consent are stored separately from the cache and are not erased by cache version changes.
- Do not clear Safari site storage as a routine update step; doing so erases local identity, consent, location and best-effort pending SOS state.
- Server map timestamp policy is a source-level read change only and requires a separate, backed-up Raspberry Pi code deployment/restart after approval. No database migration is introduced by that change.

## Field validation after approval

Follow the iPhone, Field Node, Gateway, Raspberry Pi, MQTT/database, and dashboard sequence in `RESCUENET_PWA_FINAL_TEST_PLAN.md`. Test with non-sensitive test identities/locations first. Do not treat a PWA ACK as server storage or a responder acknowledgment.
