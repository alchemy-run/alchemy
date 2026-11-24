import { AlchemyContext } from "alchemy/AlchemyContext";
import type { MemoOptions } from "alchemy/Command/Memo";
import * as DNS from "alchemy/DNS/Adapter";
import * as Output from "alchemy/Output";
import { ProviderModePolicy } from "alchemy/ProviderMode";
import type { WebsiteAssetsProps } from "alchemy/Website/assets";
import { Server, type ServerDevProps } from "alchemy/Website/Server";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Compute, type ComputeProps } from "../Compute.ts";
import type { DomainOwnership } from "../DomainOwnership.ts";
import { websiteDomain } from "../internal/WebsiteDomain.ts";
import { Project } from "../Project.ts";
import type { Providers } from "../Providers.ts";
import type { RoutingUrl } from "../RoutingUrl.ts";
import type { PrismaRegionId } from "../Types.ts";
import { WebsiteArtifact } from "./Artifact.ts";

/** A Prisma Project resource, ID, or lightweight ID reference. */
export type WebsiteProjectReference =
  | Project
  | string
  | {
      /** Existing Prisma project ID; no project is created or owned by the site. */
      readonly projectId: string | Output.Output<string>;
    };

/** Deployment controls that do not replace the framework build or artifact. */
export type WebsiteComputeOptions = Pick<
  ComputeProps,
  | "appName"
  | "port"
  | "envClass"
  | "start"
  | "skipPromote"
  | "destroyOldDeployment"
  | "timeoutSeconds"
  | "pollIntervalMs"
  | "verifyUrl"
  | "healthCheck"
  | "urlReadinessTimeoutSeconds"
>;

/** Custom hostname of a Prisma website: the hostname, or `{ name, dns, ownership }`. */
export type WebsiteDomain =
  | string
  | {
      /** Hostname, e.g. `www.example.com`. */
      name: string;
      /**
       * DNS host that publishes the hostname's `CNAME` to the app's regional
       * switchboard, and, unless `ownership` is passed, the `TXT` record of the
       * domain ownership the site declares, e.g. `Cloudflare.DNS.Adapter()`
       * (see [DNS Adapters](/infrastructure-as-code/dns-adapters)). Omitted:
       * publish `domain.records` yourself. Removing it removes the records it
       * published; to publish them with another tool, publish them there
       * first, copied from your DNS host.
       */
      dns?: DNS.DnsConfig;
      /**
       * A domain ownership that covers `name` and is managed outside this
       * site: one declared in this stack, or `Prisma.DomainOwnership.lookup`
       * for one made in the Console or by another stack. The site then declares
       * no domain ownership, and leaves this one when it is destroyed. It must
       * be for `name` or for the wildcard one label above it, or the deploy
       * stops before the site's hostname is saved. Omitted: the site declares a
       * domain ownership for `name`, and destroying the site deletes it.
       */
      ownership?: DomainOwnership;
    };

/** The hostname of a {@link WebsiteDomain}. */
export const websiteDomainName = (domain: WebsiteDomain | undefined): string | undefined =>
  domain === undefined || typeof domain === "string" ? domain : domain.name;

/** Shared contract for Prisma's framework website composites. */
export interface FrameworkSiteProps {
  /** Existing Project or ID reference, optionally produced by an Effect. Omission creates a project without a database, only on live deployments. */
  project?: WebsiteProjectReference | Effect.Effect<WebsiteProjectReference, never, Providers>;
  /** Application directory containing package.json and framework configuration. @default "." */
  rootDir?: string;
  /** Build input hashing options. Set false to rebuild on every deployment. @default true */
  memo?: MemoOptions | boolean;
  /** Build, development, and runtime environment. Wrap secrets in Redacted; public framework variables can be compiled into browser assets. */
  env?: Record<string, string | Redacted.Redacted<string> | Output.Output<string | undefined>>;
  /** Origin static-file routing, using the same vocabulary as Fly and Railway websites. */
  assets?: WebsiteAssetsProps;
  /** Native framework development server options, including external-server mode. */
  dev?: ServerDevProps;
  /**
   * Custom hostname, saved as a `Prisma.RoutingUrl`, with a
   * `Prisma.DomainOwnership` for it unless `ownership` is passed. The deploy
   * does not wait for it to serve. Without `dns`, `domain.status` is
   * `pending` and `domain.records` lists the `TXT` and `CNAME` to publish
   * until Prisma finds them. With `dns` (e.g.
   * `{ name: "www.example.com", dns: Cloudflare.DNS.Adapter() }`), they are
   * published through the DNS host, and the deploy waits up to about 7
   * minutes for them to reach the nameservers. A domain ownership that
   * already exists for `name`, such as one Prisma made for a site deployed
   * with an earlier release, refuses the deploy until it is passed as
   * `ownership: Prisma.DomainOwnership.lookup({ project, domain })`, or
   * adopted with `adopt(true)` on the site for one deploy. See
   * [DNS Adapters](/infrastructure-as-code/dns-adapters).
   */
  domain?: WebsiteDomain;
  /** Compute region. Defaults to the project's default region, then us-east-1. */
  regionId?: PrismaRegionId;
  /** Existing branch ID. Mutually exclusive with branchGitName. */
  branchId?: string;
  /** Existing branch git name. Defaults to the project's default branch. */
  branchGitName?: string;
  /** Compute deployment, readiness, and rollout options. The website owns its build, artifact, and runtime environment. */
  compute?: WebsiteComputeOptions;
  /** Accepted for website API parity; Prisma Compute does not persist resource tags. */
  tags?: Record<string, string>;
}

/** Outputs of a Prisma framework or static website. */
export interface Website {
  /** Native dev-server URL locally; Compute URL or configured custom-domain URL on live deployments. */
  url: string | Output.Output<string | undefined> | undefined;
  /** Compute app serving the artifact. Undefined during native development. */
  compute: Compute | undefined;
  /** Project resource or existing project reference. Undefined during native development. */
  project: WebsiteProjectReference | undefined;
  /** The custom hostname's RoutingUrl, with its `status` and the `records` still to publish. Undefined without domain or during native development. */
  domain: RoutingUrl | undefined;
  /** The domain ownership that covers the custom hostname: the one the site declared, or the one passed as `domain.ownership`. Undefined without domain or during native development. */
  domainOwnership: DomainOwnership | undefined;
}

/** Internal framework-to-Node-target wiring. */
export interface FrameworkSiteConfig {
  /** The framework's default JS runtime for its dev server; `dev.runtime` overrides it. @default the engine's runtime */
  runtime?: "node" | "bun";
  /** Framework integration module. */
  framework: string;
  /** Existing Node deploy-target module. */
  target: string;
  /** Serializable framework-specific overrides. */
  options?: Record<string, unknown>;
  /** Artifact layout; Next.js serves from the application root. */
  layout?: "output" | "next";
  /** Default not-found behavior, overridden by assets.notFoundHandling. */
  notFoundHandling?: "none" | "spa" | "404-page";
  /** Default extensionless HTML behavior, overridden by assets.htmlHandling. */
  htmlHandling?: "none" | "drop-trailing-slash";
}

/** Resolve build-time secrets without changing the redacted runtime env props. */
export const websiteBuildEnv = (env: FrameworkSiteProps["env"]) =>
  env === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(env).map(([key, value]) => [
          key,
          Redacted.isRedacted(value) ? Redacted.value(value) : value,
        ]),
      );

/** Shared live half, called only after a build resource has been declared. */
export const deployWebsite = Effect.fn(function* (
  props: Omit<FrameworkSiteProps, "dev">,
  artifact: WebsiteArtifact,
): Effect.fn.Return<Website, never, Providers> {
  const project = Effect.isEffect(props.project)
    ? yield* props.project
    : (props.project ??
      (yield* Project("Project", {
        createDatabase: false,
        region: props.regionId,
      })));
  const port = props.compute?.port ?? 3000;
  const compute = yield* Compute("Compute", {
    ...props.compute,
    project: typeof project === "string" ? project : project.projectId,
    artifactPath: artifact.artifactPath,
    isExternal: true,
    port,
    regionId: props.regionId,
    branchId: props.branchId,
    branchGitName: props.branchGitName,
    env: {
      ...props.env,
      PORT: String(port),
      HOST: "0.0.0.0",
      NODE_ENV: "production",
    },
  });
  const custom =
    props.domain === undefined ? undefined : yield* websiteDomain(props.domain, compute, project);
  return {
    url: custom
      ? Output.map(custom.url.hostname, (hostname) => `https://${hostname}`)
      : compute.url,
    compute,
    project,
    domain: custom?.url,
    domainOwnership: custom?.ownership,
  };
});

/** Compose a real framework build/dev server with a traced Prisma artifact. */
export const makeFrameworkSite = Effect.fn(function* (
  _id: string,
  props: FrameworkSiteProps,
  config: FrameworkSiteConfig,
) {
  const context = yield* AlchemyContext;
  const remote = yield* ProviderModePolicy;
  const handling = props.assets?.notFoundHandling;
  const targetConfig = {
    notFoundHandling:
      handling === "single-page-application" ? "spa" : (handling ?? config.notFoundHandling),
    htmlHandling: props.assets?.htmlHandling ?? config.htmlHandling,
  };
  const build = yield* Server("Build", {
    framework: config.framework,
    target: config.target,
    runtime: config.runtime,
    root: props.rootDir,
    env: websiteBuildEnv(props.env),
    options: { ...config.options, ...targetConfig, targetConfig },
    memo: props.memo,
    dev: props.dev,
  });
  if (context.dev && remote !== true) {
    return {
      url: build.url,
      compute: undefined,
      project: undefined,
      domain: undefined,
      domainOwnership: undefined,
    } satisfies Website;
  }
  const requiredPath = (value: string | undefined) =>
    value === undefined
      ? Effect.die(
          new Error(`The ${config.framework} Node build produced no deployable server output.`),
        )
      : Effect.succeed(value);
  const artifact = yield* WebsiteArtifact("Artifact", {
    root: props.rootDir ?? ".",
    distDir: Output.mapEffect(requiredPath)(build.distDir),
    serverEntry: Output.mapEffect(requiredPath)(build.serverEntry),
    layout: config.layout,
    buildHash: build.hash.output,
  });
  return yield* deployWebsite(props, artifact);
});
