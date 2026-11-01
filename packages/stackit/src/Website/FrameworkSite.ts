import { AlchemyContext } from "alchemy/AlchemyContext";
import type { MemoOptions } from "alchemy/Command/Memo";
import * as DNS from "alchemy/DNS/Adapter";
import type { Input, InputProps } from "alchemy/Input";
import * as Output from "alchemy/Output";
import { ProviderModePolicy } from "alchemy/ProviderMode";
import type { WebsiteAssetsProps } from "alchemy/Website/assets";
import { Server, type ServerDevProps } from "alchemy/Website/Server";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { CustomDomain, type CustomDomainProps } from "../CDN/CustomDomain.ts";
import { Distribution, type DistributionProps } from "../CDN/Distribution.ts";
import {
  Function as StackitFunction,
  type FunctionProps,
  type FunctionRegistry,
} from "../Functions/Function.ts";
import { AccessKey } from "../ObjectStorage/AccessKey.ts";
import { Bucket } from "../ObjectStorage/Bucket.ts";
import { CredentialsGroup } from "../ObjectStorage/CredentialsGroup.ts";
import { AssetDeployment } from "./AssetDeployment.ts";
import { CachePurge } from "./CachePurge.ts";
import { ServerImage } from "./ServerImage.ts";

/** Custom hostname of a site: the hostname, or `{ name, dns, certificate }`. */
export type WebsiteDomain =
  | string
  | {
      /** Hostname, e.g. `www.example.com`. */
      name: string;
      /**
       * DNS host that publishes the CNAME to the distribution's hostname (see
       * [DNS Adapters](/infrastructure-as-code/dns-adapters)). Omit it and create
       * the record yourself, for instance with `Stackit.DNS.RecordSet`: the domain
       * retries for about 5 minutes until the record is visible.
       */
      dns?: DNS.DnsConfig;
      /**
       * Certificate of the domain.
       * @default { type: "managed" }
       */
      certificate?: CustomDomainProps["certificate"];
    };

/** What a site can configure on its CDN distribution. */
export type WebsiteCdnProps = Omit<DistributionProps, "backend" | "labels" | "projectId">;

/** What a server-rendered site can configure on its function. */
export type WebsiteFunctionProps = Pick<
  FunctionProps,
  "name" | "plan" | "concurrency" | "maxScale" | "keepRevisions"
>;

/** What a deploy purges from the CDN. */
export interface WebsiteInvalidationProps {
  /**
   * `changed` purges the unhashed files that changed, one call per URL path. `all`
   * purges the whole distribution on every new build: use it if your framework
   * caches rendered routes at the CDN, and mind that STACKIT's docs warn this can
   * stampede the origin.
   * @default "changed"
   */
  paths: "changed" | "all";
}

/** Props of every STACKIT website, whatever serves it. */
export interface WebsiteHostingProps {
  /**
   * Custom hostname, served by a `Stackit.CDN.CustomDomain` on the site's
   * distribution. A string is shorthand for `{ name }`.
   *
   * On a server-rendered site this also pins the request's host. Without it, the host
   * comes from `X-Forwarded-Host`, and any hostname of the CDN passes, so a client can
   * make it another customer's. If your app builds links from the request's host, such
   * as in a password-reset email, set this, or set `env.ALCHEMY_SITE_HOST` to the
   * distribution's hostname after the first deploy.
   */
  domain?: WebsiteDomain;
  /**
   * User labels on the distribution, and on the function when there is one. An
   * Object Storage bucket has no labels. Updated in place.
   */
  tags?: Record<string, string>;
  /** Settings of the CDN distribution. Updated in place. */
  cdn?: WebsiteCdnProps;
  /**
   * What a deploy purges from the CDN. `false` purges nothing.
   * @default { paths: "changed" }
   */
  invalidation?: false | WebsiteInvalidationProps;
  /**
   * Name of the bucket behind an assets-only site. Generated from the stack, stage
   * and logical id if omitted, and then the bucket holds only the site's build.
   * A bucket you name can hold more: a deploy only deletes the objects it wrote, and a
   * destroy fails if anything else is left in it. Changing it replaces the bucket.
   */
  bucketName?: string;
  /** Project of the site's resources. Defaults to the profile's project. */
  projectId?: string;
}

/** Props of a framework site. */
export interface FrameworkSiteProps extends WebsiteHostingProps {
  /**
   * Project root directory (the directory containing `package.json`).
   * @default "."
   */
  rootDir?: string;
  /**
   * Controls which files are hashed to decide whether the build re-runs.
   * @default true
   */
  memo?: MemoOptions | boolean;
  /**
   * Environment variables of the server and the build. Values accept `Output`s.
   *
   * A `Redacted` value reaches only the running server, and the dev server under
   * `alchemy dev`, because a build may embed what it reads. On the server it is a
   * plain revision variable, which anyone who can call `GetRevision` can read: see
   * `Stackit.Functions.Function`.
   */
  env?: Record<string, any>;
  /**
   * Static-file routing. `htmlHandling` applies everywhere. `notFoundHandling` needs
   * a server, because the CDN has no rewrite and no error pages: on an assets-only
   * site it requires `origin: "function"`.
   */
  assets?: WebsiteAssetsProps;
  /** Options for the local dev server that runs this site under `alchemy dev`. */
  dev?: ServerDevProps;
  /**
   * Where the image of a server-rendered site is pushed, such as a
   * `Stackit.ContainerRegistry.Project`. A server-rendered site requires it. A
   * registry login is not something STACKIT credentials provide.
   */
  registry?: FunctionRegistry;
  /** Id of a `Stackit.Functions.PullCredential`, for an image in a private registry. */
  pullCredential?: string;
  /** Settings of the function a server-rendered site runs on. */
  function?: WebsiteFunctionProps;
}

/**
 * Where an assets-only build is served from.
 *
 * - `bucket` runs no compute. The CDN has no rewrite, so there is no client-side
 *   routing fallback and no 404 page, and whether it serves `index.html` at `/` is
 *   unconfirmed.
 * - `function` serves the same files from a Function, which is the way to get
 *   `assets.notFoundHandling`. It needs `registry`.
 */
export type WebsiteOrigin = "bucket" | "function";

/** Per-framework wiring for {@link makeFrameworkSite}. */
export interface FrameworkSiteConfig {
  /** Display name used in error messages (e.g. `"SvelteKit"`). */
  name: string;
  /** Framework integration module. */
  framework: string;
  /** STACKIT deploy-target module. */
  target: string;
  /** Serializable framework options. */
  options?: Record<string, unknown> | undefined;
  /** The build is assets-only, so serve it from a bucket and create no function. */
  assetsOnly?: boolean;
  /** Base path of the site, which assets-only uploads go under. */
  basePath?: string | undefined;
  /** Next.js keeps its output and configuration beside its entrypoint. */
  layout?: "client" | "next";
  /** Packages installed in the image instead of shipped (Next.js needs `next`). */
  install?: string[];
  /** Default unmatched-path behavior of the server. */
  notFoundHandling?: "none" | "spa" | "404-page";
  /** Default extensionless HTML behavior. */
  htmlHandling?: "none" | "drop-trailing-slash";
}

/** A server-rendered site has nowhere to push its image. */
export class WebsiteRegistryRequired extends Data.TaggedError(
  "Stackit.Website.WebsiteRegistryRequired",
)<{ readonly site: string; readonly message: string }> {}

/** An assets-only site asked for routing only a server can do. */
export class WebsiteFallbackRequiresFunction extends Data.TaggedError(
  "Stackit.Website.WebsiteFallbackRequiresFunction",
)<{ readonly site: string; readonly message: string }> {}

/** A function can't be the CDN's origin, as the CDN ignores the path of its origin URL. */
export class WebsiteOriginUnusable extends Data.TaggedError(
  "Stackit.Website.WebsiteOriginUnusable",
)<{
  readonly site: string;
  readonly message: string;
}> {}

/** The hostname of a {@link WebsiteDomain}. */
export const websiteDomainName = (domain: WebsiteDomain | undefined): string | undefined =>
  domain === undefined || typeof domain === "string" ? domain : domain.name;

/**
 * Environment of a framework build. A `Redacted` value stays out of a production
 * build and out of its state. Under `alchemy dev`, the dev server gets it unwrapped.
 * An `Output` or `Effect` is checked once it resolves, and an `undefined` is left out
 * when the build reads its environment.
 */
export const websiteBuildEnv = (env: Record<string, any> | undefined, local: boolean) => {
  if (env === undefined) return undefined;
  const forBuild = (value: any): any =>
    !Redacted.isRedacted(value) ? value : local ? Redacted.value(value) : undefined;
  return Object.fromEntries(
    Object.entries(env).flatMap(([key, value]): Array<[string, any]> => {
      if (Output.isOutput(value)) return [[key, Output.map(value, forBuild)]];
      if (Effect.isEffect(value)) return [[key, Effect.map(value, forBuild)]];
      return forBuild(value) === undefined ? [] : [[key, forBuild(value)]];
    }),
  );
};

/** The custom domain of a site, on an existing distribution. */
const deployDomain = Effect.fn(function* (distribution: Distribution, props: WebsiteHostingProps) {
  const name = websiteDomainName(props.domain);
  if (name === undefined) return undefined;
  const config = typeof props.domain === "object" ? props.domain : undefined;
  if (config?.dns !== undefined) {
    const dns = yield* DNS.resolve(config.dns);
    yield* dns.alias("DomainAlias", {
      name,
      target: { hostname: distribution.hostname },
    });
  }
  return yield* CustomDomain("Domain", {
    distributionId: distribution.distributionId,
    projectId: distribution.projectId,
    domain: name,
    certificate: config?.certificate,
  });
});

/** Purge a deploy's changes, unless the site opted out. */
const deployPurge = Effect.fn(function* (
  distribution: Distribution,
  props: WebsiteHostingProps,
  deployed: { version: Input<string>; files: Input<Record<string, string>> },
) {
  if (props.invalidation === false) return undefined;
  return yield* CachePurge("Purge", {
    distributionId: distribution.distributionId,
    projectId: distribution.projectId,
    version: deployed.version,
    files: deployed.files,
    all: props.invalidation?.paths === "all",
  });
});

/**
 * Serve a directory from a private bucket behind the CDN: no compute. The CDN reads
 * with its own key, whose group the bucket's policy limits to `s3:GetObject`.
 */
export const deployAssets = Effect.fn(function* (
  props: WebsiteHostingProps,
  source: {
    sourcePath: Input<string>;
    buildHash: Input<string | undefined>;
    prefix?: string | undefined;
    htmlHandling?: "none" | "drop-trailing-slash" | undefined;
  },
) {
  const location = { projectId: props.projectId };
  const dedicatedBucket = props.bucketName === undefined;
  const group = yield* CredentialsGroup("CdnReaders", location);
  const key = yield* AccessKey("CdnKey", {
    ...location,
    credentialsGroupId: group.credentialsGroupId,
  });
  const bucket = yield* Bucket("Assets", {
    ...location,
    bucketName: props.bucketName,
    // A generated bucket holds only this site's build, which the next deploy can restore.
    // A named one can hold what isn't the site's: `--adopt` can hand it over.
    forceDestroy: dedicatedBucket,
    policy: {
      Statement: [
        {
          Sid: "CdnRead",
          Effect: "Allow",
          Principal: { AWS: group.urn },
          Action: "s3:GetObject",
        },
        {
          Sid: "CdnReadOnly",
          Effect: "Deny",
          Principal: { AWS: group.urn },
          NotAction: "s3:GetObject",
        },
      ],
    },
  });
  const files = yield* AssetDeployment("Files", {
    bucketName: bucket.bucketName,
    urlPathStyle: bucket.urlPathStyle,
    projectId: bucket.projectId,
    region: bucket.region,
    sourcePath: source.sourcePath,
    buildHash: source.buildHash,
    prefix: source.prefix,
    htmlHandling: source.htmlHandling,
    purge: dedicatedBucket,
  });
  const distribution = yield* Distribution("Cdn", {
    ...props.cdn,
    ...location,
    labels: props.tags,
    backend: {
      type: "bucket",
      // The virtual-hosted URL is the form STACKIT's Terraform acceptance test uses.
      bucketUrl: bucket.urlVirtualHostedStyle,
      region: bucket.region,
      credentials: {
        accessKeyId: key.accessKeyId,
        secretAccessKey: key.secretAccessKey,
      },
    },
  });
  const purge = yield* deployPurge(distribution, props, {
    version: files.version,
    files: files.purgeable,
  });
  const domain = yield* deployDomain(distribution, props);
  const name = websiteDomainName(props.domain);
  return {
    url: name !== undefined ? `https://${name}` : distribution.url,
    distribution,
    domain,
    bucket,
    files,
    purge,
    server: undefined,
    serverUrl: undefined,
    image: undefined,
  };
});

/**
 * The shared implementation behind the framework websites. It builds through the
 * framework's STACKIT target, then deploys one of two shapes, both with the CDN in
 * front:
 *
 * - **Assets only**: a private `Stackit.ObjectStorage.Bucket` as the origin. No
 *   compute runs.
 * - **Server rendered**: a `Stackit.Functions.Function` as the origin. A distribution
 *   has exactly one origin and nothing routes by path, so the function also serves
 *   the hashed assets, with a long `Cache-Control` so the CDN can answer them after
 *   the first request. STACKIT Functions runs only OCI images, so the build goes into a
 *   Node image, built with Docker on the deploying machine.
 *
 * During `alchemy dev` the site is the framework's own dev server, and no cloud
 * resources are declared. `Alchemy.remote()` opts back into the live deployment.
 */
export const makeFrameworkSite = Effect.fn("Stackit.Website.FrameworkSite")(function* (
  id: string,
  propsIn: InputProps<FrameworkSiteProps>,
  config: FrameworkSiteConfig,
) {
  // Values flow into the resources below, which resolve them when they reconcile.
  // The reads here (the domain's shape, the build's rootDir and memo) need concrete
  // values, as on the other providers' composites.
  const props = propsIn as FrameworkSiteProps;
  const site = `Stackit.Website.${config.name} "${id}"`;
  const context = yield* AlchemyContext;
  const remote = yield* ProviderModePolicy;
  const local = context.dev && remote !== true;
  const handling = props.assets?.notFoundHandling;
  const htmlHandling = props.assets?.htmlHandling ?? config.htmlHandling;
  const targetConfig = {
    notFoundHandling:
      handling === "single-page-application"
        ? ("spa" as const)
        : (handling ?? config.notFoundHandling),
    htmlHandling,
  };

  const build = yield* Server("Build", {
    framework: config.framework,
    target: config.target,
    root: props.rootDir,
    env: websiteBuildEnv(props.env, local),
    options: { ...config.options, ...targetConfig, targetConfig },
    memo: props.memo,
    dev: props.dev,
  });

  if (local) {
    return {
      url: build.url,
      distribution: undefined,
      domain: undefined,
      bucket: undefined,
      files: undefined,
      purge: undefined,
      server: undefined,
      serverUrl: undefined,
      image: undefined,
      build,
    };
  }

  const buildHash = build.hash.output;

  if (config.assetsOnly === true) {
    if (handling !== undefined && handling !== "none") {
      return yield* Effect.die(
        new WebsiteFallbackRequiresFunction({
          site,
          message: `${site}: assets.notFoundHandling "${handling}" needs a server, because the CDN has no rewrite and no error pages. Set origin: "function", or remove it.`,
        }),
      );
    }
    const sourcePath = Output.mapEffect((clientDir: string | undefined) =>
      clientDir === undefined
        ? Effect.die(new Error(`The ${config.name} build produced no client directory.`))
        : Effect.succeed(clientDir),
    )(build.clientDir);
    const deployed = yield* deployAssets(props, {
      sourcePath,
      buildHash,
      // A relative or absolute-URL base keeps the files at the bucket's root.
      prefix: config.basePath?.startsWith("/") ? config.basePath : undefined,
      htmlHandling,
    });
    return { ...deployed, build };
  }

  if (props.registry === undefined) {
    return yield* Effect.die(
      new WebsiteRegistryRequired({
        site,
        message: `${site}: a server-rendered site runs on a Stackit.Functions.Function, which runs an OCI image. Set registry to where the image is pushed.`,
      }),
    );
  }

  const image = yield* ServerImage("Image", {
    serverEntry: build.serverEntry,
    distDir: build.distDir,
    clientDir: build.clientDir,
    layout: config.layout,
    install: config.install,
    buildHash,
    repository: props.registry.repository,
    username: props.registry.username,
    password: props.registry.password,
    htmlHandling,
  });

  const name = websiteDomainName(props.domain);
  const server = yield* StackitFunction("Server", {
    ...props.function,
    projectId: props.projectId,
    image: image.image,
    pullCredential: props.pullCredential,
    labels: props.tags,
    env: {
      ...props.env,
      // A distribution's own hostname can't be passed here: the distribution
      // depends on this function. It is read from X-Forwarded-Host instead.
      ...(name !== undefined ? { ALCHEMY_SITE_HOST: name } : {}),
    },
  });

  // The CDN ignores the path of its origin URL, so one with a path would silently
  // serve the wrong thing. Whether a Function's URL has one is unconfirmed.
  const originUrl = Output.mapEffect((url: string | undefined) =>
    url === undefined
      ? Effect.die(
          new WebsiteOriginUnusable({
            site,
            message: `${site}: the function reports no URL for the CDN to use as its origin.`,
          }),
        )
      : new URL(url).pathname !== "/"
        ? Effect.die(
            new WebsiteOriginUnusable({
              site,
              message: `${site}: the function's URL ${url} has a path, which the CDN would ignore.`,
            }),
          )
        : Effect.succeed(url),
  )(server.url);

  const distribution = yield* Distribution("Cdn", {
    // A server sets cookies; the API's default for stripping them is undocumented.
    stripResponseCookies: false,
    ...props.cdn,
    projectId: props.projectId,
    labels: props.tags,
    backend: { type: "http", originUrl },
  });
  const purge = yield* deployPurge(distribution, props, {
    version: image.codeHash,
    files: image.purgeable,
  });
  const domain = yield* deployDomain(distribution, props);

  return {
    url: name !== undefined ? `https://${name}` : distribution.url,
    distribution,
    domain,
    bucket: undefined,
    files: undefined,
    purge,
    server,
    serverUrl: server.url,
    image,
    build,
  };
});
