import * as Effect from "effect/Effect";
import type { MemoOptions } from "../../Command/Memo.ts";
import type { InputProps } from "../../Input.ts";
import { effectClass } from "../../Util/effect.ts";
import { Function, type FunctionProps } from "../Functions/Function.ts";
import type { Providers } from "../Providers.ts";
import { makeVercelOutputSite, resolveWebsiteProps } from "./internal.ts";

export interface NuxtProps extends Omit<
  FunctionProps,
  "main" | "script" | "prebuilt" | "source" | "build"
> {
  /**
   * Nuxt project root (the directory containing `nuxt.config.ts`).
   * Defaults to the process working directory.
   */
  rootDir?: string;
  /**
   * Build command run in {@link rootDir} with `NITRO_PRESET=vercel` set.
   * @default "bunx nuxi build"
   */
  command?: string;
  /**
   * Controls which files are content-hashed to decide whether a rebuild is
   * needed. By default every non-gitignored file under `rootDir` (plus the
   * nearest lockfile) is hashed — make sure `.nuxt`, `.output`, and
   * `.vercel` are gitignored so build output doesn't churn the hash.
   */
  memo?: MemoOptions | boolean;
}

/**
 * A [Nuxt](https://nuxt.com) app deployed to Vercel.
 *
 * `Nuxt` runs the project's own build with Nitro's built-in `vercel`
 * preset (`NITRO_PRESET=vercel` — no adapter package or config changes
 * needed), which emits a complete `.vercel/output` (Build Output v3) tree:
 * server routes and SSR as serverless functions, client assets and
 * prerendered pages as static files. The tree is deployed by the same
 * engine as every `Vercel.Function` — same `env`, same skip-on-hash, same
 * immutable-deployment semantics.
 *
 * Input files are content-hashed (respecting `.gitignore`) so unchanged
 * projects skip the build and deploy entirely.
 *
 * @resource
 * @product Website
 *
 * @section Deploying a Nuxt App
 * @example Basic Nuxt site
 * ```typescript
 * const site = yield* Vercel.Website.Nuxt("Site", {
 *   rootDir: "./web",
 * });
 * ```
 *
 * @example Passing environment to the build and runtime
 * `env` reaches both the build subprocess (baked into client code via
 * `NUXT_PUBLIC_*`) and the deployed functions (as project env vars).
 * ```typescript
 * const site = yield* Vercel.Website.Nuxt("Site", {
 *   rootDir: "./web",
 *   env: { NUXT_PUBLIC_API_URL: api.url },
 * });
 * ```
 *
 * @section Class Form
 * @example Declaring a site class
 * ```typescript
 * class Site extends Vercel.Website.Nuxt<Site>()("Site", {
 *   rootDir: "./web",
 * }) {}
 *
 * const site = yield* Site;
 * ```
 */
export const Nuxt: {
  <Self>(): <Req = never>(
    id: string,
    props?:
      | InputProps<NuxtProps>
      | Effect.Effect<InputProps<NuxtProps>, never, Req>,
  ) => Effect.Effect<Self, never, Req | Providers> & {
    new (_: never): Function;
  };
  <Req = never>(
    id: string,
    props?:
      | InputProps<NuxtProps>
      | Effect.Effect<InputProps<NuxtProps>, never, Req>,
  ): Effect.Effect<Function, never, Req | Providers>;
} = ((id?: any, propsEff?: any) =>
  id === undefined
    ? (id: string, propsEff: any) => effectClass(makeNuxt(id, propsEff))
    : makeNuxt(id, propsEff)) as any;

const makeNuxt = (id: string, propsEff: any) =>
  Effect.gen(function* () {
    const props = yield* resolveWebsiteProps(propsEff);
    return yield* makeVercelOutputSite({
      id,
      props,
      defaultCommand: "bunx nuxi build",
      buildEnv: { NITRO_PRESET: "vercel" },
    });
  });
