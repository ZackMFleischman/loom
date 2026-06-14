// preview-comment.mjs — build the sticky PR comment body for the Cloudflare
// Pages preview. Prints markdown to stdout.
//
//   node scripts/preview-comment.mjs <baseUrl> [shotsDir] [commitSha]
//
// <baseUrl>   the deployment URL from the Cloudflare deploy step
// [shotsDir]  dir of rendered *.png stills served under <baseUrl>/shots/
//             (default: packages/engine-app/dist/shots)
// [commitSha] the PR head commit this deploy was built from — shown in the
//             comment so a reader can tell whether the preview is current
//
// Screenshots are served from the same deploy (so the images render inline on a
// phone without committing binaries); the durable, in-diff screenshots live in
// preview/screenshots/ and are committed deliberately when authoring a visual.
import { existsSync, readdirSync } from "node:fs";

const baseUrl = (process.argv[2] ?? "").replace(/\/$/, "");
const shotsDir = process.argv[3] ?? "packages/engine-app/dist/shots";
const commitSha = process.argv[4] ?? "";
if (!baseUrl) {
  console.error("usage: preview-comment.mjs <baseUrl> [shotsDir] [commitSha]");
  process.exit(2);
}

// Link the sha when the GitHub Actions env is around; plain short sha otherwise.
const { GITHUB_SERVER_URL, GITHUB_REPOSITORY } = process.env;
const commitRef = !commitSha
  ? ""
  : GITHUB_SERVER_URL && GITHUB_REPOSITORY
    ? `[\`${commitSha.slice(0, 7)}\`](${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/commit/${commitSha})`
    : `\`${commitSha.slice(0, 7)}\``;

const shots = existsSync(shotsDir)
  ? readdirSync(shotsDir).filter((f) => f.endsWith(".png")).sort()
  : [];

const lines = [
  "### 🧵 LOOM preview",
  "",
  `**[▶ Open the live preview](${baseUrl}/)** — the Output window.`,
  `Tweak it live in the **[Console](${baseUrl}/console.html)** (spawn library scenes, drag params).`,
  "",
];

if (shots.length) {
  // Screenshots are contextual to the diff (scenes that changed / the modules
  // they use, and the Console when its UI changed) — see scripts/affected-shots.mjs.
  lines.push("<details open><summary>Screenshots of what changed</summary>", "");
  for (const f of shots) {
    const name = f.replace(/\.png$/, "");
    const title = name === "console" ? "Console (cockpit)" : name;
    lines.push(`**${title}**`, "", `![${title}](${baseUrl}/shots/${f})`, "");
  }
  lines.push("</details>");
}

lines.push(
  "",
  `<sub>${commitRef ? `Built from ${commitRef} · ` : ""}Static build — Output + Console only; live agent/MCP editing runs in the dev session, not the preview.</sub>`,
);

process.stdout.write(lines.join("\n") + "\n");
