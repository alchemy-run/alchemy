import fs from "node:fs/promises";
import path from "node:path";
import { alchemy } from "../alchemy";
import { Exec } from "../os";
import { Assets } from "./assets";
import type { Bindings } from "./bindings";
import { Worker } from "./worker";
import { WranglerJson } from "./wrangler.json";

export interface ViteSiteProps<B extends Bindings> {
  /**
   * The command to run to build the site
   */
  command: string;
  /**
   * The name of the worker
   *
   * @default id
   */
  name?: string;
  /**
   * The entrypoint to your server
   *
   * @default - a simple server that serves static assets is generated
   */
  main?: string;
  /**
   * The directory containing your static assets
   *
   * @default "./dist"
   */
  assets?: string;
  /**
   * The bindings to pass to the worker
   */
  bindings?: B;
  /**
   * @default process.cwd()
   */
  cwd?: string;
}

export type ViteSite<B extends Bindings> = Promise<
  // don't allow the ASSETS to be overriden
  B extends { ASSETS: any } ? never : Worker<B & { ASSETS: Assets }>
>;

export async function ViteSite<B extends Bindings>(
  id: string,
  props: ViteSiteProps<B>
): ViteSite<B> {
  if (props.bindings?.ASSETS) {
    throw new Error("ASSETS binding is reserved for internal use");
  }

  // @ts-ignore - we know the types are correct
  return await alchemy.run(id, async () => {
    // Create minimal wrangler.jsonc if it doesn't exist

    // `building the site requires a wrangler.jsonc file to start - so initialize an empty one if it doesn't exist`
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
      command: props.command,
    });

    const staticAssets = await Assets("assets", {
      path:
        props.assets ??
        (await (async () => {
          try {
            await fs.access(path.join("dist", "client", "index.html"));
            return path.join(".", "dist", "client");
          } catch {
            return path.join(".", "dist");
          }
        })()),
    });
    const worker = await Worker("worker", {
      name: props.name ?? id,
      entrypoint: props.main,
      assets: {
        html_handling: "auto-trailing-slash",
        not_found_handling: "single-page-application",
        run_worker_first: false,
      },
      script: props.main
        ? undefined
        : `
export default {
  async fetch(request, env) {
    return new Response("Not Found", { status: 404 });
  },
};`,
      url: true,
      adopt: true,
      bindings: {
        ...props.bindings,
        ASSETS: staticAssets,
      },
    });

    await WranglerJson("wrangler.jsonc", {
      worker,
    });

    return worker;
  });
}
