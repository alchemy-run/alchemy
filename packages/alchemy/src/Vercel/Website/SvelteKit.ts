import * as Effect from "effect/Effect";
import type { MemoOptions } from "../../Command/Memo.ts";
import type { InputProps } from "../../Input.ts";
import { effectClass } from "../../Util/effect.ts";
import { Function, type FunctionProps } from "../Functions/Function.ts";
import type { Providers } from "../Providers.ts";
import { makeVercelOutputSite, resolveWebsiteProps } from "./internal.ts";

export interface SvelteKitProps extends Omit<
  FunctionProps,
  "main" | "script" | "prebuilt" | "source" | "build"
> {
  /**
   * SvelteKit project root (the directory containing `svelte.config.js`).
   * Defaults to the process working directory.
   */
  rootDir?: string;
  /**
   * Build command run in {@link rootDir}.
   * @default "bunx vite build"
   */
  command?: string;
  /**
   * Controls which files are content-hashed to decide whether a rebuild is
   * needed. By default every non-gitignored file under `rootDir` (plus the
   * nearest lockfile) is hashed — make sure `.svelte-kit` and `.vercel`
   * are gitignored so build output doesn't churn the hash.
   */
  memo?: MemoOptions | boolean;
}

/**
 * A [SvelteKit](https://svelte.dev/docs/kit) app deployed to Vercel.
 *
 * `SvelteKit` runs the project's own Vite build; the
 * [`@sveltejs/adapter-vercel`](https://svelte.dev/docs/kit/adapter-vercel)
 * adapter (which must be installed and declared in the project's
 * `svelte.config.js`) emits a complete `.vercel/output` (Build Output v3)
 * tree — server routes and SSR as serverless functions, client assets and
 * prerendered pages as static files. The tree is deployed by the same
 * engine as every `Vercel.Function`.
 *
 * Input files are content-hashed (respecting `.gitignore`) so unchanged
 * projects skip the build and deploy entirely.
 *
 * @resource
 * @product Website
 *
 * @section Deploying a SvelteKit App
 * @example Basic SvelteKit site
 * ```typescript
 * const site = yield* Vercel.Website.SvelteKit("Site", {
 *   rootDir: "./web",
 * });
 * ```
 *
 * @section Class Form
 * @example Declaring a site class
 * ```typescript
 * class Site extends Vercel.Website.SvelteKit<Site>()("Site", {
 *   rootDir: "./web",
 * }) {}
 *
 * const site = yield* Site;
 * ```
 */
export const SvelteKit: {
  <Self>(): <Req = never>(
    id: string,
    props?:
      | InputProps<SvelteKitProps>
      | Effect.Effect<InputProps<SvelteKitProps>, never, Req>,
  ) => Effect.Effect<Self, never, Req | Providers> & {
    new (_: never): Function;
  };
  <Req = never>(
    id: string,
    props?:
      | InputProps<SvelteKitProps>
      | Effect.Effect<InputProps<SvelteKitProps>, never, Req>,
  ): Effect.Effect<Function, never, Req | Providers>;
} = ((id?: any, propsEff?: any) =>
  id === undefined
    ? (id: string, propsEff: any) => effectClass(makeSvelteKit(id, propsEff))
    : makeSvelteKit(id, propsEff)) as any;

const makeSvelteKit = (id: string, propsEff: any) =>
  Effect.gen(function* () {
    const props = yield* resolveWebsiteProps(propsEff);
    return yield* makeVercelOutputSite({
      id,
      props,
      defaultCommand: "bunx vite build",
    });
  });
