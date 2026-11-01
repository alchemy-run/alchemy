import { makeContainerImageSource } from "@alchemy.run/docker/ImageSource";
import * as functions from "@distilled.cloud/stackit/functions";
import { Unowned } from "alchemy/AdoptPolicy";
import type * as Bundle from "alchemy/Bundle/Bundle";
import { isResolved, stripEffects } from "alchemy/Diff";
import type { InputProps } from "alchemy/Input";
import { createPhysicalName } from "alchemy/PhysicalName";
import { Platform, type Main, type PlatformProps } from "alchemy/Platform";
import * as Provider from "alchemy/Provider";
import type { Resource, ResourceBinding } from "alchemy/Resource";
import type { HostRuntimeContext, ServerHost } from "alchemy/Runtime/Process";
import { recordsEqual } from "alchemy/Util/equal";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { StackitEnvironment } from "../Environment.ts";
import { findOwnedByName, readGeneration } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import { ensureServiceEnabled } from "../internal/enable.ts";
import {
  createRawEnvRuntimeContext,
  hostEnv,
  hostEnvVariable,
  hostImageSource,
  pushHostImage,
} from "../internal/serverHost.ts";
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
export { FunctionImageDigestMissing } from "../internal/pushImage.ts";

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
 * Ownership is tracked with labels (`alchemy.stack`, `alchemy.stage`,
 * `alchemy.id`, `alchemy.instance`). A function with the same explicit `name` that
 * lacks them is reported as unowned and only taken over with `--adopt`.
 *
 * Alchemy creates the function and its revisions, and for a binding a service account and
 * key. It enables the Functions service for the project. It doesn't create a registry:
 * pass `registry` to push to one you own, or pass a pre-built `image`. See [Functions on
 * STACKIT](/stackit/compute/functions) for the full guide.
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
 * :::caution[Changing `projectId` replaces the Function]
 * The function is created in the new project and gets a new URL. The old one is
 * deleted.
 * :::
 *
 * :::caution[Background work]
 * A function is reached over its URL. STACKIT doesn't document whether its instances keep
 * running between requests, so don't rely on a loop or a queue consumer staying alive in
 * one: do the work inside the request. See [Functions on
 * STACKIT](/stackit/compute/functions).
 * :::
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
 * const harbor = {
 *   username: Config.String("HARBOR_USERNAME"),
 *   secret: Config.Redacted("HARBOR_CLI_SECRET"),
 * };
 *
 * export const Images = Stackit.ContainerRegistry.Project("Images", {
 *   forceDestroy: true,
 *   harborCredentials: harbor,
 * });
 *
 * export const Pusher = Effect.gen(function* () {
 *   const images = yield* Images;
 *   return yield* Stackit.ContainerRegistry.RobotAccount("Pusher", {
 *     project: images.name,
 *     registryUrl: images.url,
 *     credentials: harbor,
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
 * The Functions API has no trigger, schedule or subscription object: a function is
 * reached over its `url`, so anything that can call a URL can invoke it. To take
 * messages from a queue, pull them inside a request, as the Pub/Sub section below
 * shows.
 *
 * ### Packaging
 * `main` is bundled into one file on your machine, with Docker building the image around
 * it. `build` takes the bundler's options. A package you keep out of the bundle has to be
 * in the base image you pass as `image`.
 *
 * **Example:** Minify, and keep a package out of the bundle
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const api = yield* Stackit.Functions.Function("Api", {
 *   main: "./src/api.ts",
 *   image: "ghcr.io/my-org/bun-with-sharp:1",
 *   registry: { repository: "ghcr.io/my-org/api" },
 *   build: {
 *     input: { external: ["sharp"] },
 *     output: { minify: true },
 *   },
 * });
 * ```
 *
 * ### Object Storage Bindings
 * `ReadBucket`, `WriteBucket` and `ReadWriteBucket` give the function an S3 client on one
 * bucket. Alchemy creates a credentials group and an access key for this host and bucket,
 * and adds statements to the bucket's policy limiting the group to those actions there.
 * Give other buckets their own `policy` to deny such groups, because a bucket policy only
 * speaks for its own bucket.
 *
 * **Example:** Write an object and read it back
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import * as Stream from "effect/Stream";
 *
 * export const Uploads = Stackit.ObjectStorage.Bucket("Uploads", {});
 *
 * export default class Api extends Stackit.Functions.Function<Api>()(
 *   "Api",
 *   {
 *     main: import.meta.url,
 *     registry: { repository: "ghcr.io/my-org/api" },
 *   },
 *   Effect.gen(function* () {
 *     // init
 *     const uploads = yield* Stackit.ObjectStorage.ReadWriteBucket(yield* Uploads);
 *     return {
 *       // runtime
 *       fetch: Effect.gen(function* () {
 *         yield* uploads.putObject({ Key: "hello.txt", Body: "hello" });
 *         const object = yield* uploads.getObject({ Key: "hello.txt" });
 *         const text = yield* Stream.mkString(Stream.decodeText(object.Body!));
 *         return HttpServerResponse.text(text);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ObjectStorage.ReadWriteBucketHttp)),
 * ) {}
 * ```
 *
 * ### PostgreSQL Flex Bindings
 * `Connect` passes a database's host, port, names and password into the function's
 * environment, with the password kept `Redacted`. It grants no STACKIT role, because
 * PostgreSQL connections authenticate with the database user. The function's egress
 * address has to be in the instance's `acl`, or connections time out.
 *
 * **Example:** Resolve the connection settings for your driver
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Db = Stackit.PostgresFlex.Instance("Db", {
 *   flavorId: "2.4",
 *   version: "17",
 *   storage: { class: "premium-perf2-stackit", size: 5 },
 *   backupSchedule: "0 2 * * *",
 *   retentionDays: 32,
 *   acl: ["203.0.113.7/32"],
 * });
 * export const AppUser = Db.pipe(
 *   Effect.flatMap((db) => Stackit.PostgresFlex.User("AppUser", { instanceId: db.instanceId })),
 * );
 * export const AppDatabase = Effect.gen(function* () {
 *   const db = yield* Db;
 *   const user = yield* AppUser;
 *   return yield* Stackit.PostgresFlex.Database("AppDatabase", {
 *     instanceId: db.instanceId,
 *     owner: user.userName,
 *   });
 * });
 *
 * export default class Api extends Stackit.Functions.Function<Api>()(
 *   "Api",
 *   {
 *     main: import.meta.url,
 *     registry: { repository: "ghcr.io/my-org/api" },
 *   },
 *   Effect.gen(function* () {
 *     // init
 *     const database = yield* AppDatabase;
 *     const user = yield* AppUser;
 *     const connect = yield* Stackit.PostgresFlex.Connect(database, user);
 *     return {
 *       // runtime
 *       fetch: Effect.gen(function* () {
 *         const info = yield* connect;
 *         return yield* HttpServerResponse.json({ database: info.database });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.PostgresFlex.ConnectHttp)),
 * ) {}
 * ```
 *
 * ### Valkey Bindings
 * `ReadValkey` and `ReadWriteValkey` run commands over a credential. They grant no STACKIT
 * role, and STACKIT has no Valkey ACLs, so the credential can do everything on the server:
 * the limit is the client's surface. The function's egress address has to be in the
 * instance's `acl`.
 *
 * **Example:** Set and read a key
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Cache = Stackit.Valkey.Instance("Cache", {
 *   version: "x",
 *   planName: "stackit-keyvalue-1.2.10-replica",
 *   acl: ["203.0.113.7/32"],
 * });
 * export const Login = Cache.pipe(
 *   Effect.flatMap((cache) =>
 *     Stackit.Valkey.Credential("Login", { instanceId: cache.instanceId }),
 *   ),
 * );
 *
 * export default class Api extends Stackit.Functions.Function<Api>()(
 *   "Api",
 *   {
 *     main: import.meta.url,
 *     registry: { repository: "ghcr.io/my-org/api" },
 *   },
 *   Effect.gen(function* () {
 *     // init
 *     const cache = yield* Stackit.Valkey.ReadWriteValkey(yield* Login);
 *     return {
 *       // runtime
 *       fetch: Effect.gen(function* () {
 *         yield* cache.set("marker", "hello");
 *         const value = yield* cache.get("marker");
 *         return yield* HttpServerResponse.json({ value });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Valkey.ReadWriteValkeyHttp)),
 * ) {}
 * ```
 *
 * ### Pub/Sub Bindings
 * `Publish` and `Pull` grant no role. Alchemy adds the function's service account to this
 * topic's publishers or this subscription's subscribers, so the grant covers that one
 * topic or subscription. The topic's `acl` has to include the function's egress address,
 * and it allows every address by default.
 *
 * **Example:** Publish a message
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Orders = Stackit.PubSub.Topic("Orders", {});
 *
 * export default class Api extends Stackit.Functions.Function<Api>()(
 *   "Api",
 *   {
 *     main: import.meta.url,
 *     registry: { repository: "ghcr.io/my-org/api" },
 *   },
 *   Effect.gen(function* () {
 *     // init
 *     const publish = yield* Stackit.PubSub.Publish(yield* Orders);
 *     return {
 *       // runtime
 *       fetch: Effect.gen(function* () {
 *         yield* publish({ messages: [{ data: JSON.stringify({ orderId: "1234" }) }] });
 *         return HttpServerResponse.text("published");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.PubSub.PublishHttp)),
 * ) {}
 * ```
 *
 * **Example:** Pull a batch on each request, and acknowledge it
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Orders = Stackit.PubSub.Topic("Orders", {});
 * export const Billing = Orders.pipe(
 *   Effect.flatMap((topic) => Stackit.PubSub.Subscription("Billing", { topicId: topic.topicId })),
 * );
 *
 * export default class Api extends Stackit.Functions.Function<Api>()(
 *   "Api",
 *   {
 *     main: import.meta.url,
 *     registry: { repository: "ghcr.io/my-org/api" },
 *   },
 *   Effect.gen(function* () {
 *     // init
 *     const billing = yield* Billing;
 *     const pull = yield* Stackit.PubSub.Pull(billing);
 *     const acknowledge = yield* Stackit.PubSub.Acknowledge(billing);
 *     return {
 *       // runtime
 *       fetch: Effect.gen(function* () {
 *         const { messages } = yield* pull({ maxMessages: 10, longPullDuration: 1000 });
 *         yield* acknowledge({ ackIds: messages.map((message) => message.ackId) });
 *         return yield* HttpServerResponse.json({ pulled: messages.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(
 *     Effect.provide([Stackit.PubSub.PullHttp, Stackit.PubSub.AcknowledgeHttp]),
 *   ),
 * ) {}
 * ```
 *
 * ### RabbitMQ Bindings
 * `Publish` publishes one message through the broker's management API over HTTPS, as the
 * credential's user, so it grants no STACKIT role. The function's egress address has to be
 * in the instance's `acl`.
 *
 * **Example:** Publish to a queue
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Broker = Stackit.RabbitMQ.Instance("Broker", {
 *   version: "4.1",
 *   planName: "stackit-rabbitmq-2.4.10-single",
 *   acl: ["203.0.113.7/32"],
 * });
 * export const Login = Broker.pipe(
 *   Effect.flatMap((broker) =>
 *     Stackit.RabbitMQ.Credential("Login", { instanceId: broker.instanceId }),
 *   ),
 * );
 *
 * export default class Api extends Stackit.Functions.Function<Api>()(
 *   "Api",
 *   {
 *     main: import.meta.url,
 *     registry: { repository: "ghcr.io/my-org/api" },
 *   },
 *   Effect.gen(function* () {
 *     // init
 *     const publish = yield* Stackit.RabbitMQ.Publish(yield* Login);
 *     return {
 *       // runtime
 *       fetch: Effect.gen(function* () {
 *         const { routed } = yield* publish({
 *           routing_key: "jobs",
 *           payload: JSON.stringify({ id: 1 }),
 *         });
 *         return yield* HttpServerResponse.json({ routed });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.RabbitMQ.PublishHttp)),
 * ) {}
 * ```
 *
 * ### Secrets Manager Bindings
 * `ReadSecret` creates a read-only AppRole for this host and instance. It reads every
 * secret in the instance, because STACKIT can't limit an AppRole to a path, so use one
 * instance per trust boundary. The function's egress address has to be in the instance's
 * `acls`.
 *
 * **Example:** Read a secret
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Vault = Stackit.SecretsManager.Instance("Vault", {
 *   acls: ["203.0.113.7/32"],
 * });
 *
 * export default class Api extends Stackit.Functions.Function<Api>()(
 *   "Api",
 *   {
 *     main: import.meta.url,
 *     registry: { repository: "ghcr.io/my-org/api" },
 *   },
 *   Effect.gen(function* () {
 *     // init
 *     const secrets = yield* Stackit.SecretsManager.ReadSecret(yield* Vault);
 *     return {
 *       // runtime
 *       fetch: Effect.gen(function* () {
 *         const secret = yield* secrets.get({ secretPath: "payments/api" });
 *         return yield* HttpServerResponse.json({ version: secret.data.metadata.version });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.SecretsManager.ReadSecretHttp)),
 * ) {}
 * ```
 *
 * ### KMS Bindings
 * `Encrypt`, `Decrypt`, `Sign` and `Verify` take one key. Alchemy grants `kms.keyring.get`
 * through a custom role on the project holding the key. That one permission allows those
 * operations on every key in the project, so the binding narrows what your code calls, not
 * what its credential could do.
 *
 * **Example:** Encrypt bytes
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as Redacted from "effect/Redacted";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Ring = Stackit.KMS.KeyRing("Ring", {});
 * export const DataKey = Ring.pipe(
 *   Effect.flatMap((ring) =>
 *     Stackit.KMS.Key("DataKey", {
 *       keyRingId: ring.keyRingId,
 *       algorithm: "aes_256_gcm",
 *       purpose: "symmetric_encrypt_decrypt",
 *     }),
 *   ),
 * );
 *
 * export default class Api extends Stackit.Functions.Function<Api>()(
 *   "Api",
 *   {
 *     main: import.meta.url,
 *     registry: { repository: "ghcr.io/my-org/api" },
 *   },
 *   Effect.gen(function* () {
 *     // init
 *     const encrypt = yield* Stackit.KMS.Encrypt(yield* DataKey);
 *     return {
 *       // runtime
 *       fetch: Effect.gen(function* () {
 *         const { ciphertext, version } = yield* encrypt({
 *           plaintext: Redacted.make(new TextEncoder().encode("hello")),
 *         });
 *         return yield* HttpServerResponse.json({ ciphertext: Array.from(ciphertext), version });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.KMS.EncryptHttp)),
 * ) {}
 * ```
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
  createRuntimeContext: createRawEnvRuntimeContext("Stackit.Functions.Function"),
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

/** The API returned a function or revision with no id; the spec marks it optional. */
export class FunctionIdMissing extends Data.TaggedError("Stackit.Functions.FunctionIdMissing")<{
  readonly resourceName: string;
  readonly message: string;
}> {}

const toName = (id: string, name: string | undefined) =>
  name !== undefined
    ? Effect.succeed(name)
    : createPhysicalName({ id, lowercase: true, maxLength: FUNCTION_NAME_MAX_LENGTH });

const imageSourceOf = (news: FunctionProps, main: string) =>
  hostImageSource({
    props: news,
    main,
    port: FUNCTION_PORT,
    resourceType: "Stackit.Functions.Function",
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
  return yield* pushHostImage({
    id,
    source: imageSourceOf(news, news.main),
    registry,
    deployed: output,
    session,
  });
});

/** The desired variables, in a stable order. */
const desiredVariables = Effect.fn(function* (
  news: FunctionProps,
  bindings: ReadonlyArray<ResourceBinding<HostBinding>>,
) {
  const external = news.isExternal === true || news.main === undefined;
  const env = yield* hostEnv(news, bindings, external);
  const variables = Object.entries(env).flatMap(([name, value]) =>
    value === undefined ? [] : [{ name, value: hostEnvVariable(name, value, external) }],
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
      const env = yield* StackitEnvironment.current;
      if ((triggerProps<FunctionProps>(desired).projectId ?? env.projectId) !== output.projectId) {
        return { action: "replace" } as const;
      }
      // Runtime exports are covered by the bundle hash, not infrastructure inputs.
      const news = stripEffects(desired);
      if (news === undefined || !isResolved(news)) return undefined;
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
