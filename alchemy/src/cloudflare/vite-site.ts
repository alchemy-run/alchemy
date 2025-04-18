import fs from "node:fs/promises";
import path from "node:path";
import { alchemy } from "../alchemy";
import { Exec } from "../os";
import { Assets } from "./assets";
import type { Bindings } from "./bindings";
import { Worker } from "./worker";
import { WranglerJson } from "./wrangler.json";

export type ViteSite<B extends Bindings> = ReturnType<typeof ViteSite<B>>;

export async function ViteSite<B extends Bindings>(
  id: string,
  props: {
    command: string;
    main: string;
    assets: string;
    bindings?: B;
    /**
     * @default process.cwd()
     */
    cwd?: string;
  }
): Promise<B extends { ASSETS: any } ? never : Worker<B & { ASSETS: Assets }>> {
  if (props.bindings?.ASSETS) {
    throw new Error("ASSETS binding is reserved for internal use");
  }

  // @ts-ignore
  return await alchemy.run(id, async () => {
    // Create minimal wrangler.jsonc if it doesn't exist

    const cwd = props.cwd || process.cwd();
    const wranglerPath = path.join(cwd, "wrangler.jsonc");
    try {
      await fs.access(wranglerPath);
    } catch {
      await fs.writeFile(
        wranglerPath,
        JSON.stringify(
          {
            name: id,
            main: props.main,
            compatibility_date: new Date().toISOString().split("T")[0],
          },
          null,
          2
        )
      );
    }

    await Exec("build", {
      command: "bun run build",
    });

    const staticAssets = await Assets("assets", {
      path: "./dist",
    });

    const worker = await Worker("worker", {
      name: "alchemy-example-vite-api",
      entrypoint: "./src/index.ts",
      url: true,
      adopt: true,
      bindings: {
        ...props.bindings,
        ASSETS: staticAssets,
      },
    });

    await WranglerJson("wrangler.json", {
      worker,
    });

    return worker;
  });
}
