import type { Assets } from "./assets";
import type { Bindings } from "./bindings";
import { Website, type WebsiteProps } from "./website";
import type { Worker } from "./worker";

export interface TanStackStartProps<B extends Bindings>
  extends WebsiteProps<B> {}

// don't allow the ASSETS to be overriden
export type TanStackStart<B extends Bindings> = B extends { ASSETS: any }
  ? never
  : Worker<B & { ASSETS: Assets }>;

export async function TanStackStart<B extends Bindings>(
  id: string,
  props?: Partial<TanStackStartProps<B>>
): Promise<TanStackStart<B>> {
  return Website(id, {
    ...props,
    command: props?.command ?? "bun run build",
    wrangler: props?.wrangler ?? false,
    main: props?.main ?? ".output/server/index.mjs",
    compatibilityFlags: ["nodejs_compat", ...(props?.compatibilityFlags ?? [])],
    assets: props?.assets ?? ".output/public",
  });
}
