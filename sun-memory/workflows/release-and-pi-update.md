---
description: Certification, npm release, and managed Pi package update workflow.
---
# Release and Pi update workflow

1. Keep unrelated working-tree changes intact; use one MCP transaction for the change.
2. `npm test` is the single complete suite: unit/integration tests, source/package metadata certification, and real-Pi E2E all run automatically. `npm run test:e2e` is only a focused debugging alias.
3. Before release run `npm run certify` (typecheck + complete `npm test`) and `git diff --check HEAD`; do not rely on a separately remembered E2E command.
4. Inspect Git status and the transaction diff; fix failures rather than masking them.
5. Behavioral fixes use a patch SemVer bump unless the change is explicitly breaking.
6. Publish only when explicitly requested. Use `npm publish` for the stable `latest` release and verify registry dist-tags/version.
7. Update the managed Pi package with:

```bash
pi update npm:pi-cache-compact-preserved-messages
```

8. Verify the installed package version/source when deployment correctness matters.

Do not expose npm credentials or OTP/auth URLs in logs or responses. MCP transaction commit is not a Git commit; do not Git commit/push unless explicitly requested.