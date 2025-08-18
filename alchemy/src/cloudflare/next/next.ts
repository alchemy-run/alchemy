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
  props: NextjsProps<B> = {},
): Promise<Nextjs<B>> {
  const runner = await getPackageManagerRunner();
  return await Website(id, {
    ...props,
    entrypoint: props.entrypoint ?? ".open-next/worker.js",
    build: normalizeCommand(props.build, {
      command: `${runner} opennextjs-cloudflare build`,
      env: {
        NEXTJS_ENV: "production",
        SKIP_WRANGLER_CONFIG_CHECK: "yes",
      },
    }),
    dev: normalizeCommand(props.dev, {
      command: `${runner} next dev`,
      env: {
        NEXTJS_ENV: "development",
      },
    }),

    // OpenNext generates the files, but relies on us to bundle them.
    noBundle: props.noBundle ?? false,

    spa: false,
    compatibilityFlags: [
      "nodejs_compat",
      "global_fetch_strictly_public",
      ...(props.compatibilityFlags ?? []),
    ],
    assets: props.assets ?? ".open-next/assets",
  });
}

const normalizeCommand = (
  input: WebsiteProps<any>["build"],
  defaults: {
    command: string;
    env: Record<string, string>;
  },
): WebsiteProps<any>["build"] => {
  return {
    command:
      typeof input === "string" ? input : (input?.command ?? defaults.command),
    env: {
      ...defaults.env,
      ...(typeof input === "object" ? (input?.env ?? {}) : {}),
    },
    memoize: typeof input === "object" ? input?.memoize : undefined,
  };
};
