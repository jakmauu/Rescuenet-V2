# RescueNet V2 PWA — GitHub Readiness

## Staging scope

This task did not commit or push. The workspace was already dirty before this task with Field Node, Gateway, server reliability edits, tests, documentation, a PWA ZIP, and a gateway backup file. Preserve those changes; review and stage intentionally.

PWA work from this task includes:

```text
Rescuenet-apk/pwa/README.md
Rescuenet-apk/pwa/app.mjs
Rescuenet-apk/pwa/core.mjs
Rescuenet-apk/pwa/index.html
Rescuenet-apk/pwa/location-scheduler.mjs
Rescuenet-apk/pwa/manifest.webmanifest
Rescuenet-apk/pwa/service-worker.js
Rescuenet-apk/pwa/styles.css
Rescuenet-apk/pwa/tests/core.test.mjs
Rescuenet-apk/pwa/tests/location-scheduler.test.mjs
Rescuenet-apk/pwa/tests/ui-contract.test.mjs
.github/workflows/deploy-rescuenet-pwa.yml
Resquenet-server/services/map_service.py
Resquenet-server/tests/test_api.py
docs/RESCUENET_PWA_FINAL_CHANGES.md
docs/RESCUENET_PWA_FINAL_ARCHITECTURE.md
docs/RESCUENET_PWA_FINAL_TEST_PLAN.md
docs/RESCUENET_PWA_FINAL_DEPLOYMENT.md
docs/RESCUENET_PWA_GITHUB_READINESS.md
```

`Rescuenet-apk/pwa.zip` was already untracked before this work. Inspect it separately; do not add it as a build artifact unless deliberately intended. Likewise, review unrelated firmware, `routes/api.py`, database, server, and legacy documentation changes before deciding whether they belong in a separate commit.

## Safety checks

- `.gitignore` excludes `.env` (while allowing `.env.example`), virtual environments, Python caches, databases, firmware build binaries, `node_modules`, logs, and local editor/OS artifacts.
- No runtime dependency/package was added by this PWA work.
- No credentials, keys, certificates, real user location, production database, or deployment secret was intentionally added.
- Static Pages workflow has read-only content permission plus the GitHub Pages OIDC deployment permissions it needs. It deploys only `Rescuenet-apk/pwa` files and now includes the new scheduler module.
- Run `git diff --check`, inspect `git status --short`, and review `git diff --stat` plus every staged file. Avoid `git add .` while the pre-existing unrelated changes remain.

## Known platform/deployment blockers

- The repository must have GitHub Pages set to “GitHub Actions”; otherwise pushing the workflow/source may leave the old README/Jekyll page visible.
- iPhone Safari must verify PWA HTTPS → Field Node private HTTP. Source cannot guarantee this browser security path.
- Background location and real radio/Gateway/server delivery are unverified without iPhone and hardware.
- Review network access controls before exposing Flask/dashboard reports and exact user location on a public host.
