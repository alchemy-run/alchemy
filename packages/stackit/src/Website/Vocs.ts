import type { InputProps } from "alchemy/Input";
import * as Namespace from "alchemy/Namespace";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** Configuration of a Vocs site on STACKIT. */
export type VocsProps = FrameworkSiteProps & {
  /** Output directory relative to `rootDir`, matching `vocs.config.*`. @default "dist" */
  outDir?: string;
};

/**
 * Vocs on a `Stackit.Functions.Function` behind a `Stackit.CDN.Distribution`. Vocs renders dynamically by default, and dropping its server would deploy an empty HTML shell, so this site always runs on a function.
 *
 * :::caution[STACKIT Functions is an alpha API]
 * It is available in `eu01` only, and STACKIT documents no container contract, so
 * this site rests on the assumptions listed on `Stackit.Functions.Function`. The
 * image is built with Docker on the deploying machine.
 * :::
 *
 * During `alchemy dev` the site is the framework's own dev server, and no cloud
 * resources are declared. `Alchemy.remote()` opts back into the live deployment.
 *
 * ### Creating a Website
 * **Example:** With a STACKIT registry
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Output from "alchemy/Output";
 * import * as Config from "effect/Config";
 *
 * const harbor = {
 *   username: Config.String("HARBOR_USERNAME"),
 *   secret: Config.Redacted("HARBOR_CLI_SECRET"),
 * };
 * const images = yield* Stackit.ContainerRegistry.Project("Images", {
 *   forceDestroy: true,
 *   harborCredentials: harbor,
 * });
 * const pusher = yield* Stackit.ContainerRegistry.RobotAccount("Pusher", {
 *   project: images.name,
 *   registryUrl: images.url,
 *   credentials: harbor,
 * });
 * const puller = yield* Stackit.Functions.PullCredential("Puller", {
 *   address: images.registryHost,
 *   username: pusher.robotName,
 *   password: pusher.secret,
 * });
 * const site = yield* Stackit.Website.Vocs("Web", {
 *   rootDir: "./app",
 *   registry: {
 *     repository: Output.interpolate`${images.imagePrefix}/web`,
 *     username: pusher.robotName,
 *     password: pusher.secret,
 *   },
 *   pullCredential: puller.pullCredentialId,
 * });
 * // site.url is the CDN's URL; site.server is the function behind it.
 * ```
 *
 * **Example:** With another registry and the machine's `docker login`
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const site = yield* Stackit.Website.Vocs("Web", {
 *   rootDir: "./app",
 *   registry: { repository: "ghcr.io/my-org/web" },
 * });
 * ```
 *
 * ### Deployment Configuration
 * **Example:** Function limits, CDN settings and a custom domain
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const site = yield* Stackit.Website.Vocs("Web", {
 *   registry: { repository: "ghcr.io/my-org/web" },
 *   env: { API_BASE: "https://api.example.com" },
 *   function: { concurrency: 50, maxScale: 10 },
 *   cdn: { regions: ["EU", "US"] },
 *   domain: "www.example.com",
 *   tags: { team: "web" },
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const Vocs = (id: string, props: InputProps<VocsProps> = {}) =>
  makeFrameworkSite(id, props, {
    name: "Vocs",
    framework: "@alchemy.run/frontend-frameworks/vocs/stackit",
    target: "@alchemy.run/frontend-frameworks/vocs/stackit",
    options: { outDir: (props as VocsProps).outDir },
    htmlHandling: "drop-trailing-slash",
  }).pipe(Namespace.push(id));
