import { spinner } from "@clack/prompts";
import * as fs from "fs-extra";
import path from "node:path";
import { throwWithContext } from "../errors.ts";
import type { ProjectContext } from "../types.ts";

export async function addGitHubWorkflowToAlchemy(
  context: ProjectContext,
): Promise<void> {
  const config = {
    owner: "username",
    repo: context.name,
    prodDomain: undefined,
  };

  const alchemyFilePath = path.join(context.path, "alchemy.run.ts");

  const s = spinner();
  s.start("Adding GitHub workflow setup...");

  try {
    let code = await fs.readFile(alchemyFilePath, "utf-8");

    const alchemyImportRegex = /(import alchemy from "alchemy";)/;
    const alchemyImportMatch = code.match(alchemyImportRegex);
    if (alchemyImportMatch) {
      const githubImport = '\nimport { GitHubComment } from "alchemy/github";';
      code = code.replace(alchemyImportRegex, `$1${githubImport}`);
    }

    const lastImportRegex = /import[^;]+from[^;]+;(\s*\n)*/g;
    let lastImportMatch;
    let lastImportEnd = 0;

    while ((lastImportMatch = lastImportRegex.exec(code)) !== null) {
      lastImportEnd = lastImportMatch.index + lastImportMatch[0].length;
    }

    if (lastImportEnd > 0) {
      const stageVariable = `
const stage = process.env.STAGE ?? process.env.PULL_REQUEST ?? "dev";
`;
      code =
        code.slice(0, lastImportEnd) +
        stageVariable +
        code.slice(lastImportEnd);
    }

    const appCallRegex = /const app = await alchemy\("([^"]+)"\);/;
    const appMatch = code.match(appCallRegex);
    if (appMatch) {
      const appName = appMatch[1];
      code = code.replace(
        appCallRegex,
        `const app = await alchemy("${appName}", {
  stage,
});`,
      );
    }

    const finalizeRegex = /(await app\.finalize\(\);)/;
    const finalizeMatch = code.match(finalizeRegex);
    if (finalizeMatch) {
      const githubWorkflowCode = `
const prodDomain = "${config.prodDomain}"
const domain = stage === "prod" ? prodDomain : stage === "dev" ? \`dev.\${prodDomain}\` : undefined;

if (process.env.PULL_REQUEST) {
  const previewUrl = domain ? \`https://\${domain}\` : worker.url;
  
  await GitHubComment("pr-preview-comment", {
    owner: "${config.owner}",
    repository: "${config.repo}",
    issueNumber: Number(process.env.PULL_REQUEST),
    body: \`
## 🚀 Preview Deployed

Your preview is ready! 

**Preview URL:** \${previewUrl}

This preview was built from commit \${process.env.GITHUB_SHA}

---
<sub>🤖 This comment will be updated automatically when you push new commits to this PR.</sub>\`,
  });
}

`;

      code = code.replace(finalizeRegex, `${githubWorkflowCode}$1`);
    }

    await fs.writeFile(alchemyFilePath, code, "utf-8");

    s.stop("GitHub workflow setup added successfully");
  } catch (error) {
    throwWithContext(error, "Failed to add GitHub workflow setup");
  }
}
