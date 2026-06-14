# CI & preview environments

How LOOM gets tested on GitHub and how each PR gets a phone-openable preview with
inline scene screenshots. Workflow: `.github/workflows/ci.yml`.

## What runs on every PR

Two jobs:

| Job | Does | Blocks merge? | Needs secrets? |
|---|---|---|---|
| **checks** | `pnpm typecheck` → `pnpm test` → production `vite build` | **yes** | no |
| **preview** | builds the static app, renders scene stills, deploys to Cloudflare Pages, upserts a sticky PR comment with the link + screenshots | no | yes (deploy step skips without them) |

`checks` is the required gate — fast and deterministic.

The screenshot **acceptance validators** (all 17 suites in `package.json`'s
`validate` chain: `m0`–`m9`, `m11`, `layers`, `projects`, `fixtures`,
`modulators`, `panic`, `stdlib`) are **not run in CI**. They were built for a
**real GPU + manual WebGPU verification** (see `DECISIONS.md`) and are flaky on
headless **software** GL — and their never-go-black tests intentionally log
Vite `PARSE_ERROR`s (they write an invalid scene to prove a broken edit can't
blank the output), which reads as scary noise in CI logs. Run them locally on
real hardware instead:

```sh
pnpm exec playwright install chromium   # once
pnpm validate            # the full suite (~10 min), or any pnpm validate:<x> alone
# reproduce the CI render path: LOOM_GL=swiftshader LOOM_RES=640x360 pnpm validate:m0
```

The infra that made them CI-capable still exists (force WebGL2 by hiding
`navigator.gpu`, `LOOM_RES` to downscale for software GL — `scripts/_browser.mjs`),
so they can be wired back into a workflow later if desired. The **preview** job
still renders scene stills with the same machinery for the PR screenshots.

## The preview environment

A **static** `vite build` of `packages/engine-app` (Output `/`, Console
`/console.html`, Staged `/staged.html`) deployed to Cloudflare Pages. It is
"view + tweak": watch the Output window and use the Console to spawn library
scenes and drag params live in the browser. It is **not** a live-editing server —
agent/MCP editing and HMR happen in your dev session here, not on the preview
(the preview just retries the absent sidecar WebSocket harmlessly).

Cloudflare gives each PR branch its own preview URL and the sticky comment keeps
the latest one at the top of the PR.

### Contextual screenshots

The screenshots in the comment reflect **what the PR changed**, not a fixed
scene. `scripts/affected-shots.mjs` diffs `HEAD` against the PR base (hence the
preview job checks out with `fetch-depth: 0`) and maps the changed files to
shoot targets:

- a changed `content/scenes/<x>.scene.ts` → shoot `<x>`;
- a changed `content/modules/**` file → shoot every scene that **transitively
  imports it** (a forward import graph over `content/`, built from the source);
- a change under `packages/engine-app/src/ui/**` → shoot the **Console** cockpit
  (`shoot.mjs --console`, which self-boots an embedded engine so the shot needs
  no separate Output window);
- broad/global content (`content/inputs.ts`, the `live.scene.ts` pointer,
  `content/test/**`) or anything else (e.g. `packages/runtime`) → **boot-scene
  fallback**, the prior behavior.

The resolver prints ready-to-use `shoot.mjs` args on stdout (scene names + maybe
`--console`) and a human summary on stderr (visible in the Actions log). Scene
output is **capped at 6** (directly-changed scenes first) so a popular shared
module can't fan out to dozens of slow software-GL renders; truncation is noted.
The decision logic is pure and unit-tested (`scripts/affected-shots.test.mjs`,
run by `pnpm test:scripts`).

### Teardown

Cloudflare never deletes preview deployments on its own, so
`.github/workflows/preview-cleanup.yml` deletes a branch's preview
deployments (via the Cloudflare API — wrangler can't) when its PR closes. For
previews that predate the workflow, run it manually: **Actions → LOOM preview
cleanup → Run workflow** with the branch name.

### One-time Cloudflare setup

1. **Create the Pages project** (once). With [wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/):
   ```sh
   npx wrangler pages project create loom --production-branch main
   ```
   (Or in the dashboard: **Workers & Pages → Create → Pages → Direct Upload**,
   name it `loom`.) The name must match `--project-name=loom` in the workflow.

2. **Create an API token.** Cloudflare dashboard → **My Profile → API Tokens →
   Create Token → Create Custom Token**:
   - Permission: **Account → Cloudflare Pages → Edit** (the only one needed)
   - Account Resources: **Include → your account**

3. **Add two GitHub repo secrets** (repo **Settings → Secrets and variables →
   Actions → New repository secret**):
   - `CLOUDFLARE_API_TOKEN` — the token from step 2
   - `CLOUDFLARE_ACCOUNT_ID` — from the Cloudflare dashboard sidebar (or
     **Workers & Pages → Account details**)

Until both secrets exist the preview job still builds the bundle (so the static
build stays tested) and just logs a notice instead of deploying.

## Screenshots in the PR

Two complementary paths:

- **Automated (every PR):** the preview job runs `scripts/shoot.mjs` into the
  deploy's `shots/` folder, so `scripts/preview-comment.mjs` can embed
  `![scene](<preview-url>/shots/<scene>.png)` inline in the sticky comment. No
  binaries enter git; the images render straight from the preview deploy.

- **Durable / in-diff (when authoring a visual):** render a still and commit it.
  ```sh
  node scripts/shoot.mjs pho-nebula          # boot scene if no args
  node scripts/shoot.mjs pulse lava          # specific scenes
  ```
  This writes `preview/screenshots/<scene>.png` (a tracked dir). Commit it and
  reference it in the PR body via a raw URL, which renders on a phone:
  ```md
  ![pulse](https://raw.githubusercontent.com/<owner>/<repo>/<branch>/preview/screenshots/pulse.png)
  ```

`shoot.mjs` mirrors the validators: it spawns the dev server on an isolated port,
drives headless Chromium against the WebGL2 fallback, points `live.scene.ts` at
each target, and **always restores** the original boot scene afterward. Env knobs:
`SHOOT_OUT`, `SHOOT_W`/`SHOOT_H` (default 1280×720), `SHOOT_SETTLE` (warm-up ms).

## Running CI checks locally

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install --with-deps chromium   # once
LOOM_GL=swiftshader pnpm validate:m0                # reproduce the CI render
pnpm --filter @loom/engine-app exec vite build      # the static preview bundle
```
