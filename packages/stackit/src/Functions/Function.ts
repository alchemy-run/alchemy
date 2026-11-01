import { Docker } from "@alchemy.run/docker/Docker";
import {
  makeContainerImageSource,
  type ImageRegistryTarget,
} from "@alchemy.run/docker/ImageSource";
import { publishedRepoDigest } from "@alchemy.run/docker/Registry";
import * as functions from "@distilled.cloud/stackit/functions";
import { Unowned } from "alchemy/AdoptPolicy";
import type * as Bundle from "alchemy/Bundle/Bundle";
import { isResolved, stripEffects } from "alchemy/Diff";
import type { InputProps } from "alchemy/Input";
import { createPhysicalName } from "alchemy/PhysicalName";
import { Platform, type Main, type PlatformProps } from "alchemy/Platform";
import * as Provider from "alchemy/Provider";
import type { Resource, ResourceBinding } from "alchemy/Resource";
import {
  createContainerRuntimeContext,
  type HostRuntimeContext,
  type ServerHost,
} from "alchemy/Runtime/Process";
import { packEnvValue } from "alchemy/RuntimeContext";
import { Stack } from "alchemy/Stack";
import { recordsEqual } from "alchemy/Util/equal";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { StackitEnvironment } from "../Environment.ts";
import { findOwnedByName, readGeneration } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, rawProp } from "../internal/diff.ts";
import { ensureServiceEnabled } from "../internal/enable.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import {
  desiredGenerationLabels,
  hasAlchemyLabels,
  isAlchemyOwned,
  labelsChanged,
  stripInternalLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import type { HostBinding } from "../StackitBindings.ts";
import {
  DEFAULT_FUNCTION_CONCURRENCY,
  DEFAULT_FUNCTION_PLAN,
  DEFAULT_KEEP_REVISIONS,
  DELETE_TIMEOUT,
  FUNCTION_NAME_MAX_LENGTH,
  FUNCTION_PLATFORM,
  FUNCTION_PORT,
  FUNCTIONS_SERVICE_ID,
  getFunctionOrUndefined,
  getRevisionOrUndefined,
  isFunctionsEnabled,
  listAllFunctions,
  listAllRevisions,
  OCI_REFERENCE_PATTERN,
  PROMOTION_TIMEOUT,
  REVISION_TIMEOUT,
} from "./internal.ts";

export type { InferEnv } from "../InferEnv.ts";

/** Where the image built from `main` is pushed. */
export interface FunctionRegistry {
  /**
   * Repository the image is pushed to, including the registry host and without a
   * tag: `registry.onstackit.cloud/my-project/api`, or, with a
   * `Stackit.ContainerRegistry.Project`, `${project.imagePrefix}/api`.
   */
  repository: string;
  /**
   * Login for the push. Omit `username` and `password` to push with the deploying
   * machine's own `docker login`.
   */
  username?: string;
  /** Password or token for the push. */
  password?: string | Redacted.Redacted<string>;
}

export interface FunctionProps<
  Env extends Record<string, any> = Record<string, any>,
> extends PlatformProps {
  /**
   * Name of the function. Updates in place. If omitted, a unique name is
   * generated from the stack, stage and logical ID.
   */
  name?: string;
  /**
   * Module to run. On an effectful Function this is `import.meta.url`: the file
   * is both the bundle entry and the program. On an async Function it is a file
   * exporting `{ fetch(request, env) }`, which is bundled with no Effect runtime.
   *
   * Either way, Alchemy builds a bun image with Docker on the deploying machine
   * and pushes it to {@link registry}, which `main` requires.
   */
  main?: string;
  /**
   * Named export to load from {@link main}.
   *
   * @default "default"
   */
  handler?: string;
  /**
   * Without {@link main}, the image to run. The API takes a semver tag
   * (`repo:v1.2.3` or `repo:1.2.3`, optionally with `@sha256:...`) or a digest
   * (`repo@sha256:...`), and a deploy rejects anything else before calling it.
   *
   * With `main`, the base image the program is layered on. It must be able to
   * run bun.
   *
   * @default "oven/bun:1" with `main`
   */
  image?: string;
  /** Where the image built from {@link main} is pushed. */
  registry?: FunctionRegistry;
  /** Bundler configuration for {@link main}. */
  build?: Bundle.BundleConfig;
  /**
   * Id of a `Stackit.Functions.PullCredential`, for an image in a private
   * registry. A new value rolls out a new revision.
   */
  pullCredential?: string;
  /**
   * Plan of the function (`limits.plan`), 2-4 characters. The API has no list of
   * plans, so check the valid values in the STACKIT portal. A new value rolls out
   * a new revision.
   *
   * @default "f2"
   */
  plan?: string;
  /**
   * Largest number of in-flight requests per instance (`limits.concurrency`). A
   * new value rolls out a new revision.
   *
   * @default 100
   */
  concurrency?: number;
  /**
   * Largest number of running instances (`limits.max_scale`). A new value rolls
   * out a new revision, and so does removing it. Omit it to use the API's default.
   */
  maxScale?: number;
  /**
   * Environment variables, each sent as a revision variable. A new value rolls out
   * a new revision.
   *
   * Variables are stored in the revision as plain `value`s, including `Redacted`
   * ones, so a secret here is readable by anyone who can call `GetRevision`. The
   * API's `vault_reference` is the intended alternative, but its format is
   * undocumented, so Alchemy doesn't use it yet.
   *
   * On an async Function, {@link InferEnv} types the handler's second argument
   * from these keys, and each value arrives as a `string`.
   */
  env?: Env;
  /**
   * User labels. Alchemy's ownership labels are always merged in. Set on the
   * function and on its revisions. Updates in place.
   */
  labels?: Record<string, string>;
  /**
   * How many older revisions to keep next to the active one. Older ones are
   * deleted after each rollout. Images stay in their registry.
   *
   * @default 1
   */
  keepRevisions?: number;
  /**
   * Project that owns the function. Defaults to the profile's project. Changing
   * it replaces the function.
   */
  projectId?: string;
}

export interface FunctionAttributes {
  /** STACKIT id of the function. Stable across updates. */
  functionId: string;
  /** Project that owns the function. */
  projectId: string;
  /** Region of the function. */
  region: string;
  /** Name of the function. */
  name: string;
  /** User labels (Alchemy ownership labels stripped). */
  labels: Record<string, string>;
  /** State of the function's latest revision: `CREATING`, `ACTIVE` or `FAILED`. */
  state: string | undefined;
  /** Error message of that state, if any. */
  stateError: string | undefined;
  /** First URL that resolves to the function, if the API reports one. */
  url: string | undefined;
  /** Every URL that resolves to the function. */
  urls: string[];
  /** Id of the revision the API reports as currently deployed. */
  currentRevision: string | undefined;
  /** Id of the revision Alchemy rolled out. */
  revisionId: string | undefined;
  /** Version number of that revision. */
  revisionVersion: number | undefined;
  /** Fingerprint the API reports for that revision's artifact. */
  digest: string | undefined;
  /** OCI reference the revision runs. */
  image: string | undefined;
  /** Content hash of the program built from `main`; undefined for an `image`. */
  codeHash: string | undefined;
}

export type Function<Env extends Record<string, any> = Record<string, any>> = Resource<
  "Stackit.Functions.Function",
  FunctionProps<Env>,
  FunctionAttributes,
  HostBinding,
  Providers
>;

export type FunctionServices = ServerHost;
export type FunctionShape = Main<FunctionServices>;
export type FunctionRuntimeContext = HostRuntimeContext;

/**
 * Keep values as they are until `reconcile` turns them into revision variables,
 * so a `Redacted` stays `Redacted` in the host's props and state. The stock
 * context packs them into plain strings here, which would put a service account
 * key in state as plain text. `get` still reads what `packEnvValue` writes.
 */
const createFunctionRuntimeContext =
  (type: string) =>
  (id: string): FunctionRuntimeContext => {
    const base = createContainerRuntimeContext(type)(id);
    return Object.assign(base, {
      set: (bindingId: string, output: unknown) =>
        Effect.sync(() => {
          const key = bindingId.replaceAll(/[^a-zA-Z0-9]/g, "_");
          base.env[key] = output;
          return key;
        }),
    });
  };

/**
 * A STACKIT Function: an OCI image STACKIT runs and serves at its own URL. Each
 * change of the image, limits or variables rolls out a new immutable revision.
 *
 * It ships in two forms, both built from `main` into a bun image with Docker on
 * the deploying machine and pushed to `registry`. Or pass a pre-built `image`
 * instead of `main`.
 *
 * Changing `projectId` replaces the function; everything else updates in place.
 * The first deploy also enables the Functions service
 * (`cloud.stackit.functions`) for the project. Deploys wait until the new revision
 * is active and current, and destroys wait until the function is gone.
 *
 * :::caution[Alpha API]
 * STACKIT Functions is an alpha API, available in `eu01` only. STACKIT documents
 * no container contract, so the listening port (`8080`, through `PORT`) is an
 * assumption Alchemy makes until it can be checked against a live account.
 * :::
 *
 * :::caution[Variables are readable]
 * Revision variables are plain `value`s, because the format of the API's
 * `vault_reference` is undocumented. Anyone who can call `GetRevision` can read
 * them, including the service account key a binding adds to the function.
 * :::
 *
 * Ownership is tracked with labels (`alchemy.stack`, `alchemy.stage`,
 * `alchemy.id`, `alchemy.instance`). A function with the same explicit `name` that
 * lacks them is reported as unowned and only taken over with `--adopt`.
 *
 * ### Async Functions
 * You don't have to use Effect. Pass `main` pointing at a file and no
 * implementation. Alchemy bundles that file as-is, serves its `fetch` from a small
 * server in the image, and passes the environment as the second argument.
 * `InferEnv` types it.
 *
 * **Example:** Defining an async Function in your stack
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Output from "alchemy/Output";
 * import * as Config from "effect/Config";
 * import * as Effect from "effect/Effect";
 *
 * export const Images = Stackit.ContainerRegistry.Project("Images", {});
 *
 * export const Pusher = Effect.gen(function* () {
 *   const images = yield* Images;
 *   return yield* Stackit.ContainerRegistry.RobotAccount("Pusher", {
 *     project: images.name,
 *     registryUrl: images.url,
 *     credentials: {
 *       username: Config.String("HARBOR_USERNAME"),
 *       secret: Config.Redacted("HARBOR_CLI_SECRET"),
 *     },
 *   });
 * });
 *
 * export const Ping = Effect.gen(function* () {
 *   const images = yield* Images;
 *   const pusher = yield* Pusher;
 *   const puller = yield* Stackit.Functions.PullCredential("Puller", {
 *     address: images.registryHost,
 *     username: pusher.robotName,
 *     password: pusher.secret,
 *   });
 *   return yield* Stackit.Functions.Function("Ping", {
 *     main: "./src/ping.ts",
 *     registry: {
 *       repository: Output.interpolate`${images.imagePrefix}/ping`,
 *       username: pusher.robotName,
 *       password: pusher.secret,
 *     },
 *     pullCredential: puller.pullCredentialId,
 *     env: { GREETING: "hello" },
 *   });
 * });
 *
 * export type PingEnv = Stackit.InferEnv<typeof Ping>;
 * ```
 *
 * **Example:** Writing the async handler
 * ```typescript
 * import type { PingEnv } from "../alchemy.run.ts";
 *
 * export default {
 *   async fetch(_request: Request, env: PingEnv) {
 *     return new Response(env.GREETING);
 *   },
 * };
 * ```
 *
 * ### Effect-native Functions
 * A Function is a class. Props describe the function, and the Effect is the
 * program that runs in it. `main: import.meta.url` makes the file the bundle
 * entry. Construction binds resources, and the returned handlers run per request.
 *
 * **Example:** A class with a `fetch` handler
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export default class Api extends Stackit.Functions.Function<Api>()(
 *   "Api",
 *   {
 *     main: import.meta.url,
 *     registry: { repository: "registry.onstackit.cloud/my-project/api" },
 *   },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("hello")),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * **Example:** Resource-valued props, from an Effect
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Output from "alchemy/Output";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import { Images, Pusher } from "./registry.ts";
 *
 * export default class Api extends Stackit.Functions.Function<Api>()(
 *   "Api",
 *   Effect.gen(function* () {
 *     const images = yield* Images;
 *     const pusher = yield* Pusher;
 *     return {
 *       main: import.meta.url,
 *       registry: {
 *         repository: Output.interpolate`${images.imagePrefix}/api`,
 *         username: pusher.robotName,
 *         password: pusher.secret,
 *       },
 *     };
 *   }),
 *   Effect.succeed({ fetch: Effect.succeed(HttpServerResponse.text("hello")) }),
 * ) {}
 * ```
 *
 * ### Choosing the image
 * `oci_reference` must be a semver tag or a digest. When Alchemy builds the image
 * it pins the revision to the digest the push reported.
 *
 * **Example:** Push to a STACKIT Container Registry project
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
 * const api = yield* Stackit.Functions.Function("Api", {
 *   main: "./src/api.ts",
 *   registry: {
 *     repository: Output.interpolate`${images.imagePrefix}/api`,
 *     username: pusher.robotName,
 *     password: pusher.secret,
 *   },
 *   pullCredential: puller.pullCredentialId,
 * });
 * ```
 *
 * **Example:** Push to your own registry with the machine's `docker login`
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const api = yield* Stackit.Functions.Function("Api", {
 *   main: "./src/api.ts",
 *   registry: { repository: "ghcr.io/my-org/api" },
 * });
 * ```
 *
 * **Example:** Run a pre-built image
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const api = yield* Stackit.Functions.Function("Api", {
 *   image: "ghcr.io/my-org/api:v1.2.3",
 * });
 * ```
 *
 * **Example:** A custom base image for the program
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const api = yield* Stackit.Functions.Function("Api", {
 *   main: "./src/api.ts",
 *   image: "oven/bun:1-slim",
 *   registry: { repository: "ghcr.io/my-org/api" },
 * });
 * ```
 *
 * ### Configuration
 * **Example:** Plan, scaling, variables and labels
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const api = yield* Stackit.Functions.Function("Api", {
 *   name: "orders-api",
 *   image: "ghcr.io/my-org/api:v1.2.3",
 *   plan: "f2",
 *   concurrency: 50,
 *   maxScale: 10,
 *   keepRevisions: 3,
 *   env: { LOG_LEVEL: "info" },
 *   labels: { team: "orders" },
 * });
 * ```
 *
 * ### Using STACKIT bindings
 * A Function runs as no STACKIT identity, so a binding gets a service account and
 * key, and the key reaches the function as a revision variable. See the caution
 * above. Grants are project-scoped, because STACKIT binds roles only on
 * organizations, folders and projects.
 *
 * **Example:** Read a DNS zone from the function
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Domain = Stackit.DNS.Zone("Domain", { dnsName: "example.com" });
 *
 * export default class Api extends Stackit.Functions.Function<Api>()(
 *   "Api",
 *   {
 *     main: import.meta.url,
 *     registry: { repository: "ghcr.io/my-org/api" },
 *   },
 *   Effect.gen(function* () {
 *     const getZone = yield* Stackit.DNS.GetZone(yield* Domain);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { zone } = yield* getZone({});
 *         return yield* HttpServerResponse.json({ state: zone.state });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.DNS.GetZoneHttp)),
 * ) {}
 * ```
 *
 * ### Reading a Function at runtime
 * **Example:** Read another function's state and call it
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Backend = Stackit.Functions.Function("Backend", {
 *   image: "ghcr.io/my-org/backend:v1.0.0",
 * });
 *
 * export default class Front extends Stackit.Functions.Function<Front>()(
 *   "Front",
 *   {
 *     main: import.meta.url,
 *     registry: { repository: "ghcr.io/my-org/front" },
 *   },
 *   Effect.gen(function* () {
 *     const backend = yield* Backend;
 *     const getFunction = yield* Stackit.Functions.GetFunction(backend);
 *     const invoke = yield* Stackit.Functions.Invoke(backend);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* getFunction();
 *         const response = yield* invoke({ path: "/health" });
 *         return yield* HttpServerResponse.json({
 *           state: live.state,
 *           status: response.status,
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(
 *     Effect.provide([Stackit.Functions.GetFunctionHttp, Stackit.Functions.InvokeHttp]),
 *   ),
 * ) {}
 * ```
 *
 * ### Event sources
 * The Functions API has no trigger, schedule or subscription object: a function
 * is reached over its `url`, so anything that can call a URL can invoke it.
 *
 * :::caution[Changing `projectId` replaces the Function]
 * The function is created in the new project and gets a new URL. The old one is
 * deleted.
 * :::
 *
 * @resource
 * @product STACKIT Functions
 * @category Functions
 */
export const Function: Platform<
  Function,
  FunctionServices,
  FunctionShape,
  FunctionRuntimeContext
> & {
  /**
   * Async (no-impl) constructor: captures the `env` literal so `InferEnv` types
   * the handler's second argument.
   */
  <const Env extends Record<string, any>, PropsReq = never>(
    id: string,
    props:
      | InputProps<FunctionProps<Env>>
      | Effect.Effect<InputProps<FunctionProps<Env>>, never, PropsReq>,
  ): Effect.Effect<Function<Env>, never, Providers | PropsReq>;
} = Platform("Stackit.Functions.Function", {
  createRuntimeContext: createFunctionRuntimeContext("Stackit.Functions.Function"),
});

/** The function declares neither `main` nor `image`. */
export class FunctionSourceRequired extends Data.TaggedError(
  "Stackit.Functions.FunctionSourceRequired",
)<{
  readonly resourceName: string;
  readonly message: string;
}> {}

/** The function builds from `main` but has nowhere to push the image. */
export class FunctionRegistryRequired extends Data.TaggedError(
  "Stackit.Functions.FunctionRegistryRequired",
)<{
  readonly resourceName: string;
  readonly message: string;
}> {}

/** `image` is neither a semver tag nor a digest, so the API would refuse it. */
export class FunctionImageNotPinned extends Data.TaggedError(
  "Stackit.Functions.FunctionImageNotPinned",
)<{
  readonly resourceName: string;
  readonly image: string;
  readonly message: string;
}> {}

/** The image was pushed, but neither the push nor the engine reported its digest. */
export class FunctionImageDigestMissing extends Data.TaggedError(
  "Stackit.Functions.FunctionImageDigestMissing",
)<{
  readonly resourceName: string;
  readonly image: string;
  readonly message: string;
}> {}

/** The API returned a function or revision with no id; the spec marks it optional. */
export class FunctionIdMissing extends Data.TaggedError("Stackit.Functions.FunctionIdMissing")<{
  readonly resourceName: string;
  readonly message: string;
}> {}

/**
 * Generated entry of an effectful Function: only `@alchemy.run/stackit/Bootstrap`
 * and the user's `main`. The runtime flag is raised before `main` evaluates, hence
 * the dynamic import.
 */
const effectEntry =
  (handler: string) =>
  (importPath: string): string =>
    `
import { bootstrap } from "@alchemy.run/stackit/Bootstrap";

globalThis.__ALCHEMY_RUNTIME__ = true;
const { ${handler}: entrypoint } = await import(${JSON.stringify(importPath)});

await bootstrap(entrypoint);
`;

/**
 * Generated entry of an async Function: a thin server with no Effect in it, which
 * hands each request to the handler with `process.env` as its second argument.
 */
const asyncEntry =
  (handler: string) =>
  (importPath: string): string =>
    `
const { ${handler}: entrypoint } = await import(${JSON.stringify(importPath)});
const handler = typeof entrypoint === "function" ? entrypoint : entrypoint?.fetch;
if (typeof handler !== "function") {
  throw new Error(${JSON.stringify(`The ${handler} export of a Stackit.Functions.Function must be a function or have a fetch method`)});
}
Bun.serve({
  hostname: "0.0.0.0",
  port: Number(process.env.PORT ?? ${String(FUNCTION_PORT)}),
  fetch: (request) => handler(request, process.env),
});
`;

const toName = (id: string, name: string | undefined) =>
  name !== undefined
    ? Effect.succeed(name)
    : createPhysicalName({ id, lowercase: true, maxLength: FUNCTION_NAME_MAX_LENGTH });

const imageSourceOf = (news: FunctionProps, main: string) => ({
  source: { main, handler: news.handler, image: news.image, build: news.build },
  port: FUNCTION_PORT,
  platform: FUNCTION_PLATFORM,
  // Both forms get a generated entry: the async one is the thin server above,
  // so the image source must not treat `main` as already serving requests.
  isExternal: false,
  bootstrap:
    news.isExternal === true
      ? asyncEntry(news.handler ?? "default")
      : effectEntry(news.handler ?? "default"),
});

/** The digest-pinned reference of an image pushed from this machine. */
const pushedDigestReference = Effect.fn(function* (args: {
  id: string;
  imageUri: string;
  registry: FunctionRegistry;
}) {
  const docker = yield* Docker;
  const { imageUri, registry } = args;
  // Pushing an image the build just pushed uploads nothing. It's here for its
  // output: the only place the engine reports the digest it published. Without
  // credentials, the push uses the machine's own registry login.
  const pushed = yield* docker.image.push(
    imageUri,
    registry.username !== undefined && registry.password !== undefined
      ? {
          // Docker keys credentials by host.
          server: registry.repository.split("/")[0]!,
          username: registry.username,
          password: registry.password,
        }
      : undefined,
    FUNCTION_PLATFORM,
  );
  const inspected = yield* docker.image.inspect(imageUri);
  const reference = publishedRepoDigest(imageUri, pushed, inspected.RepoDigests);
  if (reference === undefined) {
    return yield* new FunctionImageDigestMissing({
      resourceName: args.id,
      image: imageUri,
      message: `${args.id}: pushed ${imageUri}, but the container engine reported no digest for it`,
    });
  }
  return reference;
});

/**
 * Resolve the reference the revision runs. Built images are pushed and pinned by
 * digest, unless the deployed revision already runs this exact program.
 */
const resolveImage = Effect.fn(function* (args: {
  id: string;
  news: FunctionProps;
  output: FunctionAttributes | undefined;
  session: { note: (message: string) => Effect.Effect<void> };
}) {
  const { id, news, output, session } = args;
  if (news.main === undefined) {
    if (news.image === undefined) {
      return yield* new FunctionSourceRequired({
        resourceName: id,
        message: `${id}: a Stackit.Functions.Function needs \`main\` or \`image\``,
      });
    }
    if (!OCI_REFERENCE_PATTERN.test(news.image)) {
      return yield* new FunctionImageNotPinned({
        resourceName: id,
        image: news.image,
        message: `${id}: \`image\` must end in a semver tag (:v1.2.3) or a digest (@sha256:...), got ${news.image}`,
      });
    }
    return { image: news.image, codeHash: undefined };
  }
  const registry = news.registry;
  if (registry === undefined) {
    return yield* new FunctionRegistryRequired({
      resourceName: id,
      message: `${id}: \`main\` builds an image, so it needs \`registry\` to push it to`,
    });
  }
  const images = yield* makeContainerImageSource;
  const source = imageSourceOf(news, news.main);
  const codeHash = yield* images.hash(source);
  if (output?.codeHash === codeHash && output?.image?.startsWith(`${registry.repository}@`)) {
    return { image: output.image, codeHash };
  }
  const target: ImageRegistryTarget = {
    repositoryUri: Effect.succeed(registry.repository),
    // The digest comes from the push output, so the push always runs.
    hasTag: () => Effect.succeed(false),
    credentials: Effect.succeed(
      registry.username !== undefined && registry.password !== undefined
        ? {
            server: registry.repository.split("/")[0]!,
            username: registry.username,
            password: registry.password,
          }
        : undefined,
    ),
  };
  const resolved = yield* images.resolve({ id, session, ...source }, target);
  const image = yield* pushedDigestReference({ id, imageUri: resolved.imageUri, registry });
  return { image, codeHash: resolved.codeHash };
});

/** A value as a revision variable: raw for a plain process, packed for `Config`. */
const variableValue = (value: unknown, external: boolean): string => {
  if (!external) return packEnvValue(value);
  const raw = Redacted.isRedacted(value) ? Redacted.value(value) : value;
  return typeof raw === "string" ? raw : JSON.stringify(raw);
};

/**
 * The desired variables: binding env, Alchemy's runtime env, then the user's.
 * Only the `env` of a binding applies: a host with no STACKIT identity can't take
 * grants, and `StackitBindings.Bind` puts them on a created service account.
 */
const desiredVariables = Effect.fn(function* (
  news: FunctionProps,
  bindings: ReadonlyArray<ResourceBinding<HostBinding>>,
) {
  const external = news.isExternal === true || news.main === undefined;
  const stack = yield* Stack;
  const env: Record<string, unknown> = {
    ...Object.assign(
      {},
      ...bindings
        // A binding being removed no longer contributes.
        .filter(
          (binding: ResourceBinding<HostBinding> & { action?: string }) =>
            binding.action !== "delete",
        )
        .map((binding) => binding.data?.env),
    ),
    ...(external
      ? {}
      : {
          ALCHEMY_STACK_NAME: stack.name,
          ALCHEMY_STAGE: stack.stage,
          ALCHEMY_PHASE: "runtime",
        }),
    ...news.env,
  };
  const variables = Object.entries(env).flatMap(([name, value]) =>
    value === undefined ? [] : [{ name, value: variableValue(value, external) }],
  );
  return variables.sort((left, right) => left.name.localeCompare(right.name));
});

/** Variables by name, as plain text. The SDK keeps a read variable's value `Redacted`. */
const variableRecord = (
  variables: ReadonlyArray<functions.RevisionVariable> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    (variables ?? []).map(({ name, value }) => [
      name,
      (Redacted.isRedacted(value) ? Redacted.value(value) : value) ?? "",
    ]),
  );

interface DesiredRevision {
  readonly oci_reference: string;
  readonly oci_pull_credential_id: string | undefined;
  readonly limits: functions.ResourceLimits;
  readonly variables: functions.RevisionVariable[];
}

/**
 * Whether a revision already runs what is desired. Revisions are immutable.
 *
 * An omitted `maxScale` takes the API's default, whatever value that is, so it
 * matches any revision except one still holding the value `removedMaxScale` the
 * props just dropped.
 */
const revisionMatches = (
  revision: functions.Revision,
  desired: DesiredRevision,
  removedMaxScale: number | undefined,
) =>
  revision.oci_reference === desired.oci_reference &&
  (revision.oci_pull_credential_id || undefined) === desired.oci_pull_credential_id &&
  revision.limits.plan === desired.limits.plan &&
  revision.limits.concurrency === desired.limits.concurrency &&
  (desired.limits.max_scale === undefined
    ? removedMaxScale === undefined || revision.limits.max_scale !== removedMaxScale
    : revision.limits.max_scale === desired.limits.max_scale) &&
  recordsEqual(variableRecord(revision.variables), variableRecord(desired.variables));

const newestRevision = (revisions: ReadonlyArray<functions.Revision>) =>
  [...revisions].sort((left, right) => (right.version ?? 0) - (left.version ?? 0))[0];

/** Delete revisions beyond the newest `keep`, never the active or an in-flight one. */
const pruneRevisions = Effect.fn(function* (
  projectId: string,
  functionId: string,
  activeId: string,
  keep: number,
) {
  const revisions = yield* listAllRevisions(projectId, functionId);
  const older = revisions
    .filter((revision) => revision.id !== activeId && revision.state !== "CREATING")
    .sort((left, right) => (right.version ?? 0) - (left.version ?? 0));
  yield* Effect.forEach(
    older.slice(Math.max(keep, 0)),
    (revision) =>
      revision.id === undefined
        ? Effect.void
        : functions
            .deleteRevision({ projectId, functionId, revisionId: revision.id })
            .pipe(Effect.catchTag("NotFound", () => Effect.void)),
    { concurrency: 4, discard: true },
  );
});

const toAttrs = (args: {
  fn: functions.Function;
  functionId: string;
  projectId: string;
  region: string;
  revision: functions.Revision | undefined;
  codeHash: string | undefined;
}): FunctionAttributes => {
  const { fn, revision } = args;
  const urls = [...(fn.url ?? [])];
  return {
    functionId: args.functionId,
    projectId: args.projectId,
    region: args.region,
    name: fn.name,
    labels: stripInternalLabels(fn.labels),
    state: fn.state,
    stateError: fn.state_error === "" ? undefined : fn.state_error,
    url: urls[0],
    urls,
    currentRevision: fn.current_revision,
    revisionId: revision?.id,
    revisionVersion: revision?.version,
    digest: revision?.digest,
    image: revision?.oci_reference,
    codeHash: args.codeHash,
  };
};

export const FunctionProvider = () =>
  Provider.succeed(Function, {
    stables: ["functionId", "projectId", "region"],
    nuke: { dependsOn: ["Stackit.Functions.PullCredential"] },

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      if (!(yield* isFunctionsEnabled(env.projectId, env.region))) return [];
      const found = yield* listAllFunctions(env.projectId);
      return found.flatMap((fn) =>
        fn.id !== undefined && isAlchemyOwned(fn.labels)
          ? [
              toAttrs({
                fn,
                functionId: fn.id,
                projectId: env.projectId,
                region: env.region,
                revision: undefined,
                codeHash: undefined,
              }),
            ]
          : [],
      );
    }),

    diff: Effect.fn(function* ({ news: desired, output }) {
      if (output === undefined) return undefined;
      // An unresolved project can resolve to the one the function is already in,
      // and an explicit name may not exist twice there: delete first. A generated
      // name carries the generation, so it never collides.
      if (hasUnresolvedTrigger<FunctionProps>(desired, ["projectId"])) {
        return {
          action: "replace",
          deleteFirst: rawProp<FunctionProps>(desired, "name") !== undefined,
        } as const;
      }
      // Runtime exports are covered by the bundle hash, not infrastructure inputs.
      const news = stripEffects(desired);
      if (news === undefined || !isResolved(news)) return undefined;
      const env = yield* StackitEnvironment.current;
      if ((news.projectId ?? env.projectId) !== output.projectId) {
        return { action: "replace" } as const;
      }
      // A code-only change leaves the props untouched: hash the program so it
      // still surfaces as an update.
      if (news.main !== undefined) {
        const images = yield* makeContainerImageSource;
        const hash = yield* images.hash(imageSourceOf(news, news.main));
        if (hash !== output.codeHash) return { action: "update" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output, previous }) {
      const env = yield* StackitEnvironment.current;
      const projectId = output?.projectId ?? olds?.projectId ?? env.projectId;
      const name = output?.name ?? (yield* toName(id, olds?.name));
      if (output === undefined && !(yield* isFunctionsEnabled(projectId, env.region))) {
        return undefined;
      }
      let fn: functions.Function | undefined =
        output?.functionId !== undefined
          ? yield* getFunctionOrUndefined(projectId, output.functionId)
          : undefined;
      if (fn === undefined) {
        const found = yield* listAllFunctions(projectId);
        fn = yield* findOwnedByName(id, name, found, {
          instanceId: readGeneration({ instanceId, output, previous }),
        });
        // A foreign function at the explicit name this resource would create.
        if (fn === undefined && output === undefined && previous === undefined) {
          fn = found.find((candidate) => candidate.name === name);
        }
      }
      if (fn?.id === undefined) return undefined;
      const revision =
        fn.current_revision === undefined || fn.current_revision === ""
          ? undefined
          : yield* getRevisionOrUndefined(projectId, fn.id, fn.current_revision);
      const attrs = toAttrs({
        fn,
        functionId: fn.id,
        projectId,
        region: env.region,
        revision,
        codeHash: output?.codeHash,
      });
      return (yield* hasAlchemyLabels(id, fn.labels)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, olds, output, bindings, session }) {
      const env = yield* StackitEnvironment.current;
      const projectId = news.projectId ?? output?.projectId ?? env.projectId;
      const name = yield* toName(id, news.name);
      const labels = yield* desiredGenerationLabels(id, instanceId, news.labels);

      // Build first, so a bad image or a failed build creates nothing.
      const { image, codeHash } = yield* resolveImage({ id, news, output, session });

      yield* ensureServiceEnabled({
        projectId,
        region: env.region,
        serviceId: FUNCTIONS_SERVICE_ID,
      });

      const desired: DesiredRevision = {
        oci_reference: image,
        oci_pull_credential_id: news.pullCredential,
        limits: {
          plan: news.plan ?? DEFAULT_FUNCTION_PLAN,
          concurrency: news.concurrency ?? DEFAULT_FUNCTION_CONCURRENCY,
          ...(news.maxScale !== undefined ? { max_scale: news.maxScale } : {}),
        },
        variables: yield* desiredVariables(
          news,
          bindings as ReadonlyArray<ResourceBinding<HostBinding>>,
        ),
      };

      // Observe: `output` is a cache, and its id only counts in this project.
      let fn: functions.Function | undefined =
        output?.projectId === projectId
          ? yield* getFunctionOrUndefined(projectId, output.functionId)
          : undefined;
      // Crash recovery: this generation's labels and name.
      if (fn === undefined) {
        const found = yield* listAllFunctions(projectId);
        fn = yield* findOwnedByName(id, name, found, { instanceId });
      }

      // Ensure
      if (fn === undefined) {
        fn = yield* functions.createFunction({ projectId, name, labels });
      }
      const functionId = fn.id;
      if (functionId === undefined) {
        return yield* new FunctionIdMissing({
          resourceName: name,
          message: `STACKIT returned function ${name} without an id`,
        });
      }

      // Sync the mutable function: name and labels against the observed function.
      const nameDrifted = fn.name !== name;
      const labelsDrifted = labelsChanged(fn.labels, labels);
      if (nameDrifted || labelsDrifted) {
        fn = yield* functions.updateFunction({
          projectId,
          functionId,
          ...(nameDrifted ? { name } : {}),
          ...(labelsDrifted ? { labels } : {}),
        });
      }

      // Sync the revision: a new one only when the observed one differs. A newer
      // revision already matching is an earlier deploy's, so wait for it.
      const removedMaxScale = news.maxScale === undefined ? olds?.maxScale : undefined;
      const current =
        fn.current_revision === undefined || fn.current_revision === ""
          ? undefined
          : yield* getRevisionOrUndefined(projectId, functionId, fn.current_revision);
      let revision: functions.Revision | undefined =
        current !== undefined &&
        current.state === "ACTIVE" &&
        revisionMatches(current, desired, removedMaxScale)
          ? current
          : undefined;
      if (revision === undefined) {
        const latest = newestRevision(yield* listAllRevisions(projectId, functionId));
        if (
          latest !== undefined &&
          (latest.state === "CREATING" || latest.state === "ACTIVE") &&
          revisionMatches(latest, desired, removedMaxScale)
        ) {
          revision = latest;
        }
      }
      if (revision === undefined) {
        revision = yield* functions.createRevision({
          projectId,
          functionId,
          oci_reference: desired.oci_reference,
          limits: desired.limits,
          variables: desired.variables,
          labels,
          ...(desired.oci_pull_credential_id !== undefined
            ? { oci_pull_credential_id: desired.oci_pull_credential_id }
            : {}),
        });
      }
      const revisionId = revision.id;
      if (revisionId === undefined) {
        return yield* new FunctionIdMissing({
          resourceName: name,
          message: `STACKIT returned a revision of function ${name} without an id`,
        });
      }

      // A failure names `state_error`, as STACKIT's Go SDK waiter does.
      if (revision.state !== "ACTIVE") {
        revision = yield* waitFor({
          resource: `STACKIT function ${name} revision ${revisionId}`,
          read: functions.getRevision({ projectId, functionId, revisionId }),
          ready: (observed) => observed.state === "ACTIVE",
          failed: (observed) =>
            observed.state === "FAILED" || observed.state === "CANCELLED"
              ? (observed.state_error ?? observed.state)
              : undefined,
          state: (observed) => observed.state,
          timeout: REVISION_TIMEOUT,
        });
      }

      // The API has no setter for `current_revision`, so wait for it to follow.
      fn = yield* waitFor({
        resource: `STACKIT function ${name} serving revision ${revisionId}`,
        read: functions.getFunction({ projectId, functionId }),
        ready: (observed) => observed.current_revision === revisionId,
        failed: (observed) =>
          observed.current_revision === revisionId && observed.state === "FAILED"
            ? (observed.state_error ?? observed.state)
            : undefined,
        state: (observed) => observed.current_revision,
        timeout: PROMOTION_TIMEOUT,
      });

      // Sync the active revision's labels: the part of a revision that can change.
      if (labelsChanged(revision.labels, labels)) {
        revision = yield* functions.updateRevision({
          projectId,
          functionId,
          revisionId,
          labels,
        });
      }

      yield* pruneRevisions(
        projectId,
        functionId,
        revisionId,
        news.keepRevisions ?? DEFAULT_KEEP_REVISIONS,
      );

      return toAttrs({ fn, functionId, projectId, region: env.region, revision, codeHash });
    }),

    delete: Effect.fn(function* ({ output }) {
      const { projectId, functionId } = output;
      yield* functions
        .deleteFunction({ projectId, functionId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone({
        resource: `STACKIT function ${output.name}`,
        read: getFunctionOrUndefined(projectId, functionId),
        state: (fn) => fn.state,
        timeout: DELETE_TIMEOUT,
      });
    }),
  });
