import type { InputProps } from "alchemy/Input";
import * as Namespace from "alchemy/Namespace";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** Configuration of a vinext site on STACKIT. */
export type VinextProps = FrameworkSiteProps;

/**
 * vinext on a `Stackit.Functions.Function` behind a `Stackit.CDN.Distribution`, on vinext's own production server. vinext and its React packages are installed in the image.
 *
 * In front of vinext, the request's host is set to the site's, because vinext answers a
 * Server Action with 403 unless the browser's `Origin` matches it. A response with no
 * `Cache-Control` gets `no-cache`, so the CDN's default duration doesn't apply to a
 * rendered page.
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
 * const images = yield* Stackit.ContainerRegistry.Project("Images", {});
 * const pusher = yield* Stackit.ContainerRegistry.RobotAccount("Pusher", {
 *   project: images.name,
 *   registryUrl: images.url,
 *   credentials: {
 *     username: Config.String("HARBOR_USERNAME"),
 *     secret: Config.Redacted("HARBOR_CLI_SECRET"),
 *   },
 * });
 * const puller = yield* Stackit.Functions.PullCredential("Puller", {
 *   address: images.registryHost,
 *   username: pusher.robotName,
 *   password: pusher.secret,
 * });
 * const site = yield* Stackit.Website.Vinext("Web", {
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
 * const site = yield* Stackit.Website.Vinext("Web", {
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
 * const site = yield* Stackit.Website.Vinext("Web", {
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
export const Vinext = (id: string, props: InputProps<VinextProps> = {}) =>
  makeFrameworkSite(id, props, {
    name: "Vinext",
    framework: "@alchemy.run/frontend-frameworks/vinext/stackit",
    target: "@alchemy.run/frontend-frameworks/vinext/stackit",
    install: ["vinext", "react", "react-dom", "react-server-dom-webpack"],
  }).pipe(Namespace.push(id));
