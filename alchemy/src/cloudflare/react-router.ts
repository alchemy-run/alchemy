import path from "node:path";
import type { Assets } from "./assets.js";
import type { Bindings } from "./bindings.js";
import { Website, type WebsiteProps } from "./website.js";
import type { Worker } from "./worker.js";

export interface ReactRouterProps<B extends Bindings> extends WebsiteProps<B> {
  /**
   * @default workers/app.ts
   */
  main?: string;
}

// don't allow the ASSETS to be overriden
export type ReactRouter<B extends Bindings> = B extends { ASSETS: any }
  ? never
  : Worker<B & { ASSETS: Assets }>;

export async function ReactRouter<B extends Bindings>(
  id: string,
  props: ReactRouterProps<B>,
): Promise<ReactRouter<B>> {
  const defaultAssets = path.join("build", "client");
  const main = props.main ?? path.join("workers", "app.ts");
  function normalizeWrangler():
    | {
        path?: string;
        main?: string;
        secrets?: boolean;
      }
    | false {
    if (props.wrangler === false) return false;
    if (typeof props.wrangler === "undefined" || props.wrangler === true) {
      return { main, secrets: true };
    }
    if (typeof props.wrangler === "string") {
      // respect overrides for wrangler.json path
      return { main, path: props.wrangler };
    }
    return {
      // wrangler should point to the user's main (e.g. `worker.ts`), unless overridden
      path: props.wrangler.path,
      main: props.wrangler.main ?? main,
      secrets: props.wrangler.secrets ?? true,
    };
  }
  return Website(id, {
    ...props,
    command: props.command ?? "react-router typegen && react-router build",
    dev: props.dev ?? {
      command: "react-router typegen && react-router dev",
    },
    compatibility: "node",
    // Alchemy should bundle the result of `vite build`, not the user's main
    // TODO: we probably need bundling to properly handle WASM/rules
    main: path.join(props.cwd ?? process.cwd(), "build", "server", "index.js"),
    wrangler: normalizeWrangler(),
    assets:
      typeof props.assets === "object"
        ? {
            dist: props.assets.dist ?? defaultAssets,
          }
        : (props.assets ?? defaultAssets),
  });
}
