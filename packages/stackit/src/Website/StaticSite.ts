import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Command from "alchemy/Command";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import { ProviderModePolicy } from "alchemy/ProviderMode";
import { initialCwd } from "alchemy/Util/Node";
import { loadFrontendCore } from "alchemy/Website/FrontendCore";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import type * as Redacted from "effect/Redacted";
import { deployAssets, type WebsiteHostingProps } from "./FrameworkSite.ts";

/** Configuration of a command-built static site. */
export type StaticSiteProps = Command.BuildProps &
  WebsiteHostingProps & {
    /**
     * `drop-trailing-slash` also serves `about.html` at `/about`. `about/index.html`
     * is always served at `/about` and `/about/`.
     * @default "none"
     */
    htmlHandling?: "none" | "drop-trailing-slash";
    /**
     * Base path the site is served under. Uploads go under it.
     * @default "/"
     */
    basePath?: string;
    /**
     * Local command for `alchemy dev`. Without one, a local static server serves the
     * built output.
     */
    dev?: {
      /** Shell command that starts the dev server. */
      command: string;
      /** Directory of the command; defaults to `cwd`. */
      cwd?: string;
      /** More environment variables for the command. */
      env?: Record<string, string | Redacted.Redacted<string>>;
      /** Dev URL, when the command doesn't print one. */
      url?: string;
    };
  };

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * Build a static site with a shell command and serve it from a private
 * `Stackit.ObjectStorage.Bucket` behind a `Stackit.CDN.Distribution`. No compute
 * runs. Files with a content hash in their name are cached for good, HTML is not
 * cached, and a deploy purges the unhashed files that changed.
 *
 * The CDN has no rewrite and no error pages, so there is no client-side routing
 * fallback and no 404 page. For those, deploy a `Stackit.Website.Vite` with
 * `origin: "function"`.
 *
 * :::caution[`/` is unconfirmed]
 * A bucket has no object for `/`, and STACKIT documents no default document for a
 * bucket origin. Pages under a path are stored at their own URLs. Check `/` on your
 * first deploy.
 * :::
 *
 * During `alchemy dev`, `dev.command` runs if set; otherwise a local server serves
 * the build. No cloud resources are declared. `Alchemy.remote()` opts back into the
 * live deployment.
 *
 * ### Creating a Static Site
 * **Example:** Hugo site
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const site = yield* Stackit.Website.StaticSite("Blog", {
 *   command: "hugo --minify",
 *   outdir: "public",
 * });
 * // site.url is the CDN's URL.
 * ```
 *
 * **Example:** A subdirectory with a dev server
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const site = yield* Stackit.Website.StaticSite("Web", {
 *   cwd: "apps/web",
 *   command: "npm run build",
 *   outdir: "dist",
 *   dev: { command: "npm run dev" },
 * });
 * ```
 *
 * ### Custom Domains
 * **Example:** Publish the record with a DNS adapter
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const site = yield* Stackit.Website.StaticSite("Web", {
 *   command: "npm run build",
 *   outdir: "dist",
 *   domain: { name: "www.example.com", dns: Cloudflare.DNS.Adapter() },
 * });
 * ```
 *
 * **Example:** Publish the record in a STACKIT zone
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Output from "alchemy/Output";
 *
 * const site = yield* Stackit.Website.StaticSite("Web", {
 *   command: "npm run build",
 *   outdir: "dist",
 *   domain: "www.example.com",
 * });
 * yield* Stackit.DNS.RecordSet("Www", {
 *   zoneId: zone.zoneId,
 *   name: "www",
 *   type: "CNAME",
 *   records: [Output.interpolate`${site.distribution!.hostname}.`],
 * });
 * ```
 *
 * ### Caching
 * **Example:** Purge everything on each new build
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const site = yield* Stackit.Website.StaticSite("Web", {
 *   command: "npm run build",
 *   outdir: "dist",
 *   invalidation: { paths: "all" },
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const StaticSite = (id: string, props: StaticSiteProps) =>
  Effect.gen(function* () {
    const context = yield* AlchemyContext;
    const remote = yield* ProviderModePolicy;
    const local = context.dev && remote !== true;
    const none = {
      distribution: undefined,
      domain: undefined,
      bucket: undefined,
      files: undefined,
      purge: undefined,
      server: undefined,
      serverUrl: undefined,
      image: undefined,
    };
    if (local && props.dev !== undefined) {
      const dev = yield* Command.Dev("Dev", {
        command: props.dev.command,
        cwd: props.dev.cwd ?? props.cwd,
        env: { ...props.env, ...props.dev.env },
      });
      return { ...none, url: props.dev.url ?? dev.url };
    }
    const build = yield* Command.Build("Build", {
      command: props.command,
      cwd: props.cwd,
      env: props.env,
      outdir: props.outdir,
      memo: props.memo,
      shell: props.shell,
      timeout: props.timeout,
    });
    if (local) {
      const { makeNodeServeEntrySource } = yield* loadFrontendCore;
      const path = yield* Path.Path;
      const runtime = yield* Effect.sync(() => process.execPath);
      const command = Output.map(
        build.outdir,
        (outdir) =>
          `${quote(runtime)} --eval ${quote(
            makeNodeServeEntrySource({
              htmlHandling: props.htmlHandling,
              clientDirExpression: JSON.stringify(path.resolve(initialCwd, outdir)),
              printUrl: true,
            }),
          )}`,
      );
      const dev = yield* Command.Dev("Dev", {
        command,
        cwd: props.cwd,
        shell: true,
        env: { ...props.env, HOST: "127.0.0.1", PORT: "0" },
      });
      return { ...none, url: dev.url };
    }
    return yield* deployAssets(props, {
      sourcePath: build.outdir,
      buildHash: build.hash.output,
      prefix: props.basePath,
      htmlHandling: props.htmlHandling,
    });
  }).pipe(Namespace.push(id));
