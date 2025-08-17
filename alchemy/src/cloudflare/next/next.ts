import { getPackageManagerRunner } from "../../util/detect-package-manager.ts";
import type { Assets } from "../assets.ts";
import type { Bindings } from "../bindings.ts";
import { Website, type WebsiteProps } from "../website.ts";
import type { Worker } from "../worker.ts";

export interface NextjsProps<B extends Bindings> extends WebsiteProps<B> {}

export type Nextjs<B extends Bindings> = B extends { ASSETS: any }
  ? never
  : Worker<B & { ASSETS: Assets }>;

export async function Nextjs<const B extends Bindings>(
  id: string,
  {
    entrypoint,
    build,
    dev,
    noBundle,
    compatibilityFlags,
    assets,
    ...props
  }: NextjsProps<B> = {},
): Promise<Nextjs<B>> {
  const runner = await getPackageManagerRunner();
  return await Website(id, {
    entrypoint: entrypoint ?? ".open-next/worker.js",
    build:
      build ??
      `${runner} opennextjs-cloudflare build --config=.alchemy/local/wrangler.jsonc`,
    dev: dev ?? `${runner} next dev`,
    noBundle: noBundle ?? false,
    compatibilityFlags: [
      "nodejs_compat",
      "global_fetch_strictly_public",
      ...(compatibilityFlags ?? []),
    ],
    assets: assets ?? ".open-next/assets",
    ...props,
  });
}
