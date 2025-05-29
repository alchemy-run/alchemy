import path from "node:path";
import type { Assets } from "./assets.ts";
import type { Bindings } from "./bindings.ts";
import { Website, type WebsiteProps } from "./website.ts";
import type { Worker } from "./worker.ts";

export interface ViteProps<B extends Bindings> extends WebsiteProps<B> {}

// don't allow the ASSETS to be overriden
export type Vite<B extends Bindings> = B extends { ASSETS: any }
  ? never
  : Worker<B & { ASSETS: Assets }>;

export async function Vite<B extends Bindings>(
  id: string,
  props: ViteProps<B>,
): Promise<Vite<B>> {
  const defaultAssets = path.join("dist", "client");
  return Website(id, {
    ...props,
    // Alchemy should bundle the result of `vite built`, not the user's main
    // TODO: we probably need bundling to properly handle WASM/rules
    main: path.join(props.cwd ?? process.cwd(), "build", "server", "index.js"),
    wrangler: {
      // wrangler should point to the user's main (e.g. `worker.ts`), unless overridden
      main:
        typeof props.wrangler === "object"
          ? (props.wrangler.main ?? props.main)
          : props.main,
      // write to wrangler.json by default but respect overrides
      path:
        typeof props.wrangler === "string"
          ? props.wrangler
          : typeof props.wrangler === "object"
            ? props.wrangler.path
            : undefined,
    },
    assets:
      typeof props.assets === "object"
        ? {
            dist: props.assets.dist ?? defaultAssets,
          }
        : (props.assets ?? defaultAssets),
  });
}
