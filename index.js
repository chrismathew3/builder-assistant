// index.js  ─  AI code-mod bot
// ------------------------------------------------------------
// Prereqs:  Node ≥ 18
//           npm i dotenv openai @octokit/rest simple-git globby
// .env must include:
//   GITHUB_OWNER, GITHUB_REPO, GITHUB_TOKEN   (token needs `repo` scope)
//   OPENAI_API_KEY
//   OPENAI_ASSISTANT_MODEL   (optional, defaults gpt-4o-mini)
// ------------------------------------------------------------

import dotenv            from "dotenv";
import OpenAI            from "openai";
import { Octokit }       from "@octokit/rest";
import simpleGit         from "simple-git";
import { globby }        from "globby";           // named export
import { promises as fs} from "node:fs";
import path              from "node:path";
import os                from "node:os";
import { spawnSync }     from "node:child_process";

dotenv.config();

/*──────────────── helper: run shell cmd ───────────────*/
function run(cmd, args, cwd, input) {
  const r = spawnSync(cmd, args, {
    cwd,
    stdio: ["pipe", "inherit", "inherit"],
    input,
  });
  if (r.status !== 0) throw new Error(`❌ ${cmd} ${args.join(" ")} failed`);
}

/*──────────────── sample a lightweight repo context ────*/
async function sampleRepoContext(repoDir, maxFiles = 25, maxBytes = 40_000) {
  const always = ["package.json", "pnpm-workspace.yaml", "tsconfig.json"];
  const candidates = await globby(
    ["**/*.{ts,tsx,js,jsx,py,go,rs,java}", ...always],
    { gitignore: true, cwd: repoDir }
  );

  const picked = [];
  let budget   = maxBytes;

  for (const f of candidates.sort((a, b) => a.length - b.length)) {
    if (picked.length >= maxFiles) break;
    const abs = path.join(repoDir, f);
    const { size } = await fs.stat(abs);
    if (size < 3_000 && budget - size > 0) {
      picked.push(f);
      budget -= size;
    }
  }

  const parts = await Promise.all(
    picked.map(async f => {
      const code = await fs.readFile(path.join(repoDir, f), "utf8");
      return `FILE: ${f}\n${code}`;
    })
  );
  return parts.join("\n\n<<<END FILE>>>\n\n");
}

/*──────────────── main ────────────────────────────────*/
async function main() {
  const task = process.argv.slice(2).join(" ");
  if (!task) {
    console.error("❌ Usage: node index.js \"Add /settings page …\"");
    process.exit(1);
  }

  const { GITHUB_OWNER: owner, GITHUB_REPO: repo, GITHUB_TOKEN: token } =
    process.env;
  const openai  = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const octokit = new Octokit({ auth: token });
  const git     = simpleGit();

  /* 1️⃣  shallow-clone */
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-"));
  const remote =
    `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
  await git.clone(remote, tmpDir, ["--depth", "1"]);

  const branch = `ai-task-${Date.now()}`;
  await git.cwd(tmpDir).checkoutLocalBranch(branch);

  /* 2️⃣  context */
  const contextBlob = await sampleRepoContext(tmpDir);

  /* 3️⃣  prompt builder */
  const SYSTEM_PROMPT = `
You are an expert software-engineering code-mod bot.
Return ONLY valid output produced by:
    git diff --no-prefix -U1000
(each file chunk MUST start with:
    diff --git a/<path> b/<path>
    --- a/<path>     or /dev/null
    +++ b/<path>)
If you create a new file, include:
    new file mode 100644
If no change is needed, output exactly __NO_CHANGES__ (no extra text).`;

  async function askForPatch(extraInstruction = "") {
    const messages = [
      { role: "system", content: SYSTEM_PROMPT.trim() },
      { role: "user",   content: `Repository context:\n${contextBlob}` },
      { role: "user",   content: `TASK:\n${task}\n${extraInstruction}` },
    ];
    const res = await openai.chat.completions.create({
      model: process.env.OPENAI_ASSISTANT_MODEL || "gpt-4o-mini",
      temperature: 0,
      messages,
    });
    return res.choices[0].message.content.trim();
  }

  /* 4️⃣  first attempt */
  let diff = await askForPatch();
  if (diff === "__NO_CHANGES__") {
    console.log("ℹ️ Model reports no edits needed – exiting.");
    return;
  }

  /* helper to attempt git apply & retry once */
  async function applyOrRetry(patch, isRetry = false) {
    try {
      run("git", ["apply", "-"], tmpDir, patch);
      return patch;              // success
    } catch {
      if (isRetry) throw new Error("patch failed twice");
      console.log("⚠️  Patch failed. Asking model to re-emit with full headers…");
      const fresh = await askForPatch(
        "The previous patch failed to apply. " +
        "Re-emit the ENTIRE diff (with headers) and ensure it applies."
      );
      return applyOrRetry(fresh, true);
    }
  }

  diff = await applyOrRetry(diff);

  /* 5️⃣  commit & push */
  await git.add(".").commit(`AI: ${task}`);
  await git.push("origin", branch);

  /* 6️⃣  PR */
  await octokit.pulls.create({
    owner,
    repo,
    title: `AI: ${task}`,
    head: branch,
    base: "main",
    body: `Automated patch generated by OpenAI\n\nTask:\n${task}`,
  });

  console.log(`✅ Pull Request opened: ${branch} → main`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
