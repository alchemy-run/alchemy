import * as fs from "node:fs/promises";
import { join } from "node:path";
import type { ProjectContext } from "../types.ts";
import { create } from "../utils.ts";
import { initWebsiteProjectWithContext } from "./index.ts";

export default async function initTanstackStartProject(
  context: ProjectContext,
): Promise<void> {
  try {
    create(
      context,
      `cloudflare@2.49.3 ${context.name} --framework=tanstack-start --no-git --no-deploy ${context.options.yes ? "--yes" : ""}`,
    );

    await initWebsiteProjectWithContext(context, {
      scripts: {
        build: "vinxi build",
      },
    });

    try {
      await fs.writeFile(
        join(context.path, "app", "routes", "index.tsx"),
        `import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  component: Home,
})

function Home() {
  return (
    <div className="p-2">
      <h3>Welcome to TanStack Start on Cloudflare!</h3>
      <p>Your TanStack Start app is running on Cloudflare Workers with Alchemy.</p>
    </div>
  )
}
`,
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to update TanStack Start page: ${errorMsg}`);
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    throw new Error(
      `TanStack Start template initialization failed: ${errorMsg}`,
    );
  }
}
