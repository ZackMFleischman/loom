# preview/screenshots

Tracked images embedded in PR descriptions. Commit a PNG here, then reference it
from the PR body via a `raw.githubusercontent.com` URL (renders on GitHub and on
phones):

```md
![pulse](https://raw.githubusercontent.com/ZackMFleischman/loom/<sha-or-branch>/preview/screenshots/pulse.png)
```

Pin to the commit **SHA** for a stable link, or the **branch** to auto-update.

Render scene stills with `node scripts/shoot.mjs <scene...>` (writes here), or
drop in any PNG. PRs that change something visual SHOULD include a screenshot.

See the root `CLAUDE.md` ("Screenshots in PRs") and `docs/ci-and-preview.md`.
