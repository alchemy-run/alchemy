import * as fs from "node:fs/promises";
import { join } from "node:path";
import type { ProjectContext } from "../types.ts";
import { create } from "../utils.ts";
import { initWebsiteProjectWithContext } from "./index.ts";

export default async function initRedwoodProject(
  context: ProjectContext,
): Promise<void> {
  try {
    create(
      context,
      `cloudflare@2.49.3 ${context.name} --framework=redwood --no-git --no-deploy ${context.options.yes ? "--yes" : ""}`,
    );

    await initWebsiteProjectWithContext(context, {
      scripts: {
        build: "redwood build",
      },
    });

    try {
      await fs.writeFile(
        join(context.path, "redwood.toml"),
        `[web]
  title = "Redwood App on Cloudflare"
  port = 8910
  apiUrl = "/.redwood/functions"
  
[api]
  port = 8911
  
[browser]
  open = true
`,
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to create redwood.toml: ${errorMsg}`);
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    throw new Error(`Redwood template initialization failed: ${errorMsg}`);
  }
}
