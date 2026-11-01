import * as Presign from "@distilled.cloud/aws/Presign";
import * as s3 from "@distilled.cloud/aws/s3";
import * as iaas from "@distilled.cloud/stackit/iaas";
import type { StackitOpContext } from "@distilled.cloud/stackit/Protocol";
import * as Bundle from "alchemy/Bundle/Bundle";
import { findCwdForBundle, resolveMainPath } from "alchemy/Bundle/TempRoot";
import { isResolved, stripEffects } from "alchemy/Diff";
import type { InputProps } from "alchemy/Input";
import { createPhysicalName } from "alchemy/PhysicalName";
import { Platform, type Main, type PlatformProps } from "alchemy/Platform";
import * as Provider from "alchemy/Provider";
import type { Resource, ResourceBinding } from "alchemy/Resource";
import type { HostRuntimeContext, ServerHost } from "alchemy/Runtime/Process";
import { zipFiles } from "alchemy/Util/zip";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import {
  commandOutput,
  installScript,
  INSTALL_TIMEOUT,
  prepareScript,
  PREPARE_TIMEOUT,
  publicKeyInOutput,
  removeScript,
  REMOVE_TIMEOUT,
  renderEnvFile,
  runScript,
  RUN_COMMAND_SERVICE_ID,
  sealEnv,
  ServerKeyUnusable,
  sha256Hex,
} from "../internal/commandHost.ts";
import { hasUnresolvedTrigger, triggerProps } from "../internal/diff.ts";
import { ensureServiceEnabled } from "../internal/enable.ts";
import {
  createRawEnvRuntimeContext,
  hostEnv,
  hostEnvVariable,
  hostImageSource,
} from "../internal/serverHost.ts";
import { Bucket } from "../ObjectStorage/Bucket.ts";
import { withDeployerS3 } from "../ObjectStorage/internal.ts";
import type { Providers } from "../Providers.ts";
import { type HostBinding, serviceAccountHostBundle } from "../StackitBindings.ts";
import type { Server } from "./Server.ts";

const DEFAULT_PORT = 3000;
/** Long enough for a program of any size; the key signing the URL lives for an hour. */
const DOWNLOAD_URL_LIFETIME_SECONDS = 1800;

/** A resource-valued prop: the resource, or the Effect that produces it. */
type Ref<T> = T | Effect.Effect<T, never, Providers>;

export interface ServiceProps<
  Env extends Record<string, any> = Record<string, any>,
> extends PlatformProps {
  /**
   * Server the program runs on, as a `Stackit.IaaS.Server` or the Effect producing
   * one. A server can run several Services. Changing it replaces the Service: the
   * program is installed on the new server, then removed from the old one.
   */
  server: Ref<Server>;
  /**
   * Module to run. On an effectful Service this is `import.meta.url`: the file is
   * both the bundle entry and the program. On an async Service it is a file exporting
   * `{ fetch(request, env) }`, which is bundled with no Effect runtime.
   */
  main: string;
  /**
   * Named export to load from {@link main}.
   *
   * @default "default"
   */
  handler?: string;
  /**
   * Port the program listens on, sent as `PORT`. When you set it, a deploy also
   * waits until the port answers on the server itself, with any HTTP status. It is
   * not opened to the network: add a `Stackit.IaaS.SecurityGroupRule`.
   *
   * @default 3000
   */
  port?: number;
  /**
   * Public address to build {@link ServiceAttributes.url} from: pass a
   * `Stackit.IaaS.PublicIp`'s `ip`, which also deploys the address first. Without
   * it, the address the server reports when the Service deploys is used, if any.
   */
  publicIp?: string;
  /**
   * Environment variables of the program. They reach the server encrypted to a key
   * that never leaves it, so their values appear neither in Run Command's history nor
   * in the bucket. On an async Service, `InferEnv` types the handler's second argument
   * from these keys, and each value arrives as a `string`.
   */
  env?: Env;
  /** Bundler configuration for {@link main}. */
  build?: Bundle.BundleConfig;
  /**
   * Bucket the program passes through on its way to the server. Each deploy puts one
   * object in it and deletes the object once the server has it. It must be in the
   * server's project and region.
   *
   * @default one bucket per server, which Alchemy creates and deletes with the stack
   */
  artifacts?: Bucket;
}

export interface ServiceAttributes {
  /** Server the program runs on. */
  serverId: string;
  /** Project of the server. */
  projectId: string;
  /** Region of the server. */
  region: string;
  /** Port the program listens on. */
  port: number;
  /** Public address, from {@link ServiceProps.publicIp} or the server's report at deploy. */
  publicIp: string | undefined;
  /** `http://<publicIp>:<port>`, when there is a public address. */
  url: string | undefined;
  /** Name of the systemd unit, without `.service`. Stable across updates. */
  unitName: string;
  /** Content hash of the bundled program. */
  code: {
    /** SHA-256 of the bundle. */
    hash: string;
  };
  /** Bucket the program passes through. */
  artifacts: {
    /** Name of the bucket. */
    bucketName: string;
    /** Path-style URL of the bucket. */
    urlPathStyle: string;
  };
}

export type Service<Env extends Record<string, any> = Record<string, any>> = Resource<
  "Stackit.IaaS.Service",
  ServiceProps<Env>,
  ServiceAttributes,
  HostBinding,
  Providers
>;

export type ServiceServices = ServerHost;
export type ServiceShape = Main<ServiceServices>;
export type ServiceRuntimeContext = HostRuntimeContext;

/**
 * A program hosted on a `Stackit.IaaS.Server` as a systemd unit running bun, and the
 * STACKIT runtime with an identity of its own: bindings use the server's service
 * account, with no key on the server. It ships in two forms from the same resource.
 *
 * Nothing logs in to the server. Alchemy drives it through STACKIT Run Command, so it
 * needs no SSH path and no public address: the Server Agent runs each step. Each
 * deploy bundles `main` on the deploying machine, puts it in a bucket for the server
 * to download through a presigned URL, and restarts the unit. A deploy waits until the
 * unit has stayed active for about 16 seconds, and with `port`, answers there too. It doesn't
 * watch it afterwards: a unit that stops, or a server
 * rebuilt outside Alchemy, is only corrected by the next change that reinstalls it.
 *
 * :::caution[What the server needs]
 * Linux with systemd, the Server Agent (set `agent: { provisioned: true }` on the
 * Server for an image that doesn't install it), and outbound HTTPS to `bun.sh` and to
 * Object Storage. A system with `apt-get` or `dnf` also gets `curl`, `unzip` and
 * `openssl` if they are missing. The program runs as root. A server must be `ACTIVE`
 * for a deploy.
 * :::
 *
 * :::caution[Run Command keeps its history]
 * Every step's script stays in the server's command history, readable by whoever holds
 * `run-command.command.get`. Those scripts hold the presigned URL, which stops working
 * with the deploy, and no env values. If the program fails to start, its journal is
 * printed there too, so a program that logs a secret at startup exposes it that way.
 * :::
 *
 * ### Effect-native Services
 * A Service is a class. Props describe it, and the Effect is the program that runs on
 * the server. `main: import.meta.url` makes the file the bundle entry. Construction
 * binds resources, and the returned handlers run per request.
 *
 * **Example:** A class with a `fetch` handler
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Box = Effect.gen(function* () {
 *   const network = yield* Stackit.IaaS.Network("App", {
 *     ipv4: { prefix: "10.0.1.0/24" },
 *   });
 *   return yield* Stackit.IaaS.Server("Box", {
 *     machineType: "g1.1",
 *     bootVolume: { size: 20, source: { type: "image", id: "<ubuntu 24.04 image id>" } },
 *     networking: { networkId: network.networkId },
 *   });
 * });
 *
 * export default class Api extends Stackit.IaaS.Service<Api>()(
 *   "Api",
 *   { server: Box, main: import.meta.url, port: 3000 },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("hello")),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * **Example:** A background loop with no HTTP handler
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import { ServerHost } from "alchemy/Runtime/Process";
 * import * as Effect from "effect/Effect";
 * import { Box } from "./server.ts";
 *
 * export default class Worker extends Stackit.IaaS.Service<Worker>()(
 *   "Worker",
 *   { server: Box, main: import.meta.url },
 *   Effect.gen(function* () {
 *     const { run } = yield* ServerHost;
 *     yield* run(
 *       Effect.logInfo("tick").pipe(
 *         Effect.andThen(Effect.sleep("1 minute")),
 *         Effect.forever,
 *       ),
 *     );
 *   }),
 * ) {}
 * ```
 *
 * ### Async Services
 * You don't have to use Effect. Pass `main` pointing at a file and no implementation.
 * Alchemy bundles that file as-is, serves its `fetch` from a small server on the
 * machine, and passes the environment as the second argument. `InferEnv` types it.
 *
 * **Example:** Defining an async Service in your stack
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import { Box } from "./server.ts";
 *
 * export const Ping = Effect.gen(function* () {
 *   const server = yield* Box;
 *   return yield* Stackit.IaaS.Service("Ping", {
 *     server,
 *     main: "./src/ping.ts",
 *     port: 3000,
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
 * ### Exposing it on the internet
 * The Service opens nothing. Give the server a public address and a rule for the port.
 *
 * **Example:** A public address and a security group rule
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 *
 * export const Site = Effect.gen(function* () {
 *   const network = yield* Stackit.IaaS.Network("App", {
 *     ipv4: { prefix: "10.0.1.0/24" },
 *   });
 *   const group = yield* Stackit.IaaS.SecurityGroup("Web", {});
 *   yield* Stackit.IaaS.SecurityGroupRule("Http", {
 *     securityGroupId: group.securityGroupId,
 *     direction: "ingress",
 *     protocol: "tcp",
 *     portRange: { min: 3000, max: 3000 },
 *   });
 *   const nic = yield* Stackit.IaaS.NetworkInterface("Web", {
 *     networkId: network.networkId,
 *     securityGroups: [group.securityGroupId],
 *   });
 *   const server = yield* Stackit.IaaS.Server("Web", {
 *     machineType: "g1.1",
 *     bootVolume: { size: 20, source: { type: "image", id: "<image id>" } },
 *     networking: { networkInterfaceIds: [nic.networkInterfaceId] },
 *   });
 *   const address = yield* Stackit.IaaS.PublicIp("Web", {
 *     networkInterfaceId: nic.networkInterfaceId,
 *   });
 *   return yield* Stackit.IaaS.Service("Site", {
 *     server,
 *     main: "./src/site.ts",
 *     port: 3000,
 *     publicIp: address.ip,
 *   });
 * });
 * ```
 *
 * ### Configuration
 * **Example:** Variables, a secret and a named export
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 * import { Box } from "./server.ts";
 *
 * const api = yield* Stackit.IaaS.Service("Api", {
 *   server: Box,
 *   main: "./src/api.ts",
 *   handler: "server",
 *   port: 8080,
 *   env: {
 *     LOG_LEVEL: "info",
 *     API_TOKEN: Config.Redacted("API_TOKEN"),
 *   },
 * });
 * ```
 *
 * **Example:** Bundler options, and your own bucket for the upload
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import { Box } from "./server.ts";
 *
 * const artifacts = yield* Stackit.ObjectStorage.Bucket("Releases", {});
 * const api = yield* Stackit.IaaS.Service("Api", {
 *   server: Box,
 *   main: "./src/api.ts",
 *   artifacts,
 *   build: { output: { minify: true } },
 * });
 * ```
 *
 * **Example:** Two Services on one server
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import { Box } from "./server.ts";
 *
 * const server = yield* Box;
 * const web = yield* Stackit.IaaS.Service("Web", {
 *   server,
 *   main: "./src/web.ts",
 *   port: 3000,
 * });
 * const admin = yield* Stackit.IaaS.Service("Admin", {
 *   server,
 *   main: "./src/admin.ts",
 *   port: 3001,
 * });
 * ```
 *
 * ### Using STACKIT bindings
 * Alchemy creates one `Stackit.IAM.ServiceAccount` per server, attaches it to the
 * server, and grants it what each binding needs. A running Service gets short-lived
 * tokens from the server's metadata API and stores no key. Services on one server
 * share the account and each other's grants, and you can't also attach your own with
 * `Stackit.IaaS.ServerServiceAccountAttachment`: a server already holding another account fails
 * the deploy with `Stackit.IaaS.ServerServiceAccountTaken`, which names it. Grants are project-scoped, because
 * STACKIT binds roles only on organizations, folders and projects. The deployer needs
 * `iam.service-account.act-as` on the account to attach it.
 *
 * **Example:** Read a DNS zone as the server's service account
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import { Box } from "./server.ts";
 *
 * export const Domain = Stackit.DNS.Zone("Domain", { dnsName: "example.com" });
 *
 * export default class Api extends Stackit.IaaS.Service<Api>()(
 *   "Api",
 *   { server: Box, main: import.meta.url, port: 3000 },
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
 * **Example:** Run a command on another server
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import { Box, Other } from "./server.ts";
 *
 * export default class Ops extends Stackit.IaaS.Service<Ops>()(
 *   "Ops",
 *   { server: Box, main: import.meta.url, port: 3000 },
 *   Effect.gen(function* () {
 *     const run = yield* Stackit.RunCommand.CreateCommand(yield* Other);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { id } = yield* run({
 *           commandTemplateName: "RunShellScript",
 *           parameters: { script: "uptime" },
 *         });
 *         return yield* HttpServerResponse.json({ id });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.RunCommand.CreateCommandHttp)),
 * ) {}
 * ```
 *
 * ### Event sources
 * A program on a server keeps running, so it can hold a connection open.
 *
 * A deploy stops the running process with a signal: HTTP requests get about six seconds to
 * finish, and a consumer's handler is interrupted mid message, so that message comes back. A
 * handler has to tolerate running twice.
 *
 * **Example:** Consume a RabbitMQ queue
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import { App } from "./broker.ts";
 * import { Box } from "./server.ts";
 *
 * export default class Consumer extends Stackit.IaaS.Service<Consumer>()(
 *   "Consumer",
 *   { server: Box, main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* Stackit.RabbitMQ.consumeQueueMessages(
 *       App,
 *       { queue: "jobs", prefetch: 10 },
 *       (message) => Effect.log(message.text),
 *     );
 *   }).pipe(Effect.provide(Stackit.RabbitMQ.ServerQueueEventSource)),
 * ) {}
 * ```
 *
 * ### Keeping files between deploys
 * Each deploy replaces the program in `/opt/<unitName>/current`. The unit's working directory
 * is `/var/lib/<unitName>`, which stays, so a program can write to a relative path such as
 * `./data.sqlite`. A file bundled with the program isn't there: read it relative to
 * `import.meta.dir`. Deleting the Service deletes the directory, and changing `server` leaves
 * it behind, with nothing copied to the new server, so keep data a server replacement has to
 * survive on a `Stackit.IaaS.Volume`.
 *
 * :::caution[Changing `server` replaces the Service]
 * The program is installed on the new server, and then removed from the old one.
 * Everything else updates in place and restarts the unit.
 * :::
 *
 * @see https://docs.stackit.cloud/products/compute-engine/run-command/
 * @see https://docs.stackit.cloud/products/compute-engine/server/how-tos/attaching-service-account-to-servers/
 *
 * @resource
 * @product STACKIT Compute Engine
 * @category IaaS
 */
export const Service: Platform<Service, ServiceServices, ServiceShape, ServiceRuntimeContext> & {
  /**
   * Async (no-impl) constructor: captures the `env` literal so `InferEnv` types the
   * handler's second argument.
   */
  <const Env extends Record<string, any>, PropsReq = never>(
    id: string,
    props:
      | InputProps<ServiceProps<Env>>
      | Effect.Effect<InputProps<ServiceProps<Env>>, never, PropsReq>,
  ): Effect.Effect<Service<Env>, never, Providers | PropsReq>;
} = Platform("Stackit.IaaS.Service", {
  createRuntimeContext: createRawEnvRuntimeContext("Stackit.IaaS.Service"),
  // `{ server: Box }` at module scope is an Effect. Yield it here so the server is
  // registered, `news.server` is its attributes at reconcile, and bindings can read
  // the server off the host. The default bucket hangs off the server, so its Services
  // share one and it lives in the server's project and region.
  transformProps: (_id, props) =>
    Effect.gen(function* () {
      if (globalThis.__ALCHEMY_RUNTIME__) return props;
      const server = Effect.isEffect(props.server)
        ? yield* props.server as Effect.Effect<Server, never, Providers>
        : (props.server as Server);
      const artifacts =
        props.artifacts ??
        (yield* Bucket(`${server.LogicalId}ServiceArtifacts`, {
          projectId: server.projectId,
          region: server.region,
          forceDestroy: true,
        }));
      return { ...props, server, artifacts };
    }),
});

/** The server isn't running, so it would never pick up a command. */
export class ServiceServerNotRunning extends Data.TaggedError(
  "Stackit.IaaS.ServiceServerNotRunning",
)<{
  readonly resourceName: string;
  readonly serverId: string;
  readonly status: string | undefined;
  readonly message: string;
}> {}

/** What a resolved `server` prop holds. */
type ResolvedServer = Pick<Server["Attributes"], "serverId" | "projectId" | "region">;

const toUnitName = (id: string, existing: string | undefined) =>
  existing !== undefined
    ? Effect.succeed(existing)
    : createPhysicalName({ id, maxLength: 64, lowercase: true }).pipe(
        Effect.map((name) => name.replaceAll(/[^a-z0-9-]/g, "-")),
      );

const toUrl = (publicIp: string | undefined, port: number) =>
  publicIp === undefined ? undefined : `http://${publicIp}:${String(port)}`;

const objectKeyOf = (unitName: string) => `${unitName}/bundle.zip`;

/** Bundle the program for bun, the way a `Functions.Function`'s image is built. */
const bundleProgram = Effect.fn(function* (news: ServiceProps) {
  const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;
  const main = yield* resolveMainPath(news.main);
  const cwd = yield* findCwdForBundle(main);
  const { bootstrap } = hostImageSource({
    props: news,
    main: news.main,
    port: news.port ?? DEFAULT_PORT,
    resourceType: "Stackit.IaaS.Service",
  });
  return yield* Bundle.build(
    serviceAccountHostBundle({
      ...news.build?.input,
      input: main,
      cwd,
      platform: "node",
      // The server runs bun, so its modules stay external.
      external: ["bun", "bun:*", ...((news.build?.input?.external as string[] | undefined) ?? [])],
      resolve: {
        conditionNames: [...Bundle.BUN_CONDITION_NAMES],
        ...news.build?.input?.resolve,
      },
      plugins: [news.build?.input?.plugins, virtualEntryPlugin(bootstrap)],
    }),
    {
      ...news.build?.output,
      format: "esm",
      sourcemap: news.build?.output?.sourcemap ?? false,
      minify: news.build?.output?.minify ?? false,
      entryFileNames: "index.mjs",
    },
    news.build,
  );
});

export const ServiceProvider = () =>
  Provider.succeed(Service, {
    stables: ["serverId", "projectId", "region", "unitName"],
    // A unit has no API of its own: nuke deletes the server it lives on, and an
    // empty list is the documented shape for a parent-keyed resource.
    nuke: { dependsOn: ["Stackit.IaaS.Server"] },
    list: () => Effect.succeed([]),

    diff: Effect.fn(function* ({ news: desired, output }) {
      if (output === undefined) return undefined;
      // A server updating in place resolves to its stable attributes here, so an
      // unresolved one is a server being replaced. The unit's generated name
      // carries the generation, so the new unit never collides with the old one.
      if (hasUnresolvedTrigger<ServiceProps>(desired, ["server"])) {
        return { action: "replace" } as const;
      }
      const server = triggerProps<ServiceProps>(desired).server as unknown as ResolvedServer;
      if (
        server.serverId !== output.serverId ||
        server.projectId !== output.projectId ||
        server.region !== output.region
      ) {
        return { action: "replace" } as const;
      }
      // Runtime exports are covered by the bundle hash, not infrastructure inputs.
      const news = stripEffects(desired);
      if (news === undefined || !isResolved(news)) return undefined;
      // A code-only change leaves the props untouched: hash the program so it
      // still surfaces as an update.
      const { hash } = yield* bundleProgram(news as ServiceProps);
      if (hash !== output.code.hash) return { action: "update" } as const;
      return undefined;
    }),

    read: Effect.fn(function* ({ output }) {
      // A unit carries no labels and nothing lists units, so without state there
      // is nothing to find: reconcile reinstalls under the same generated name.
      if (output === undefined) return undefined;
      const live = yield* iaas
        .getServer({
          projectId: output.projectId,
          region: output.region,
          serverId: output.serverId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
      return live === undefined ? undefined : output;
    }),

    reconcile: Effect.fn(function* ({ id, news, output, bindings, session }) {
      // Resource-valued props arrive as their attributes.
      const server = news.server as unknown as ResolvedServer;
      const artifacts = news.artifacts as unknown as Bucket["Attributes"];
      const { projectId, region, serverId } = server;
      const scope = { projectId, region, serverId };
      const port = news.port ?? DEFAULT_PORT;
      const unitName = yield* toUnitName(id, output?.unitName);

      // Build first, so a broken program touches nothing on the server.
      const bundled = yield* bundleProgram(news);
      const external = news.isExternal === true;
      const env = yield* hostEnv(
        { env: { PORT: String(port), ...news.env } },
        bindings as ReadonlyArray<ResourceBinding<HostBinding>>,
        external,
      );

      yield* ensureServiceEnabled({ projectId, region, serviceId: RUN_COMMAND_SERVICE_ID });

      // Observe: a stopped server would leave a command pending until the wait
      // runs out. Every step below is idempotent, however far an earlier one got.
      const live = yield* iaas.getServer({ ...scope, details: true });
      if (live.status !== "ACTIVE") {
        return yield* new ServiceServerNotRunning({
          resourceName: id,
          serverId,
          status: live.status,
          message: `${id}: server ${serverId} is ${live.status ?? "in an unknown state"}, and a Service can only deploy to an ACTIVE server`,
        });
      }
      const publicIp = news.publicIp ?? live.nics?.find((nic) => nic.publicIp)?.publicIp;

      // Ensure the tools and the key pair the env is encrypted to.
      yield* session.note(`Preparing server ${serverId}`);
      const prepared = yield* runScript({
        ...scope,
        what: `Preparing ${unitName}`,
        script: prepareScript(unitName),
        timeout: PREPARE_TIMEOUT,
      });
      const publicKey = publicKeyInOutput(commandOutput(prepared));
      if (publicKey === undefined) {
        return yield* new ServerKeyUnusable({
          resourceName: id,
          message: `${id}: server ${serverId} didn't report the public key its env is encrypted to`,
        });
      }
      const envFile = renderEnvFile(
        Object.fromEntries(
          Object.entries(env).flatMap(([name, value]) =>
            value === undefined ? [] : [[name, hostEnvVariable(name, value, external)]],
          ),
        ),
      );
      const sealed = yield* sealEnv({
        resourceName: id,
        publicKey,
        envFile: Redacted.make(envFile),
      });

      const archive = yield* zipFiles([
        ...bundled.files.map((file) => ({ path: file.path, content: file.content })),
        ...sealed.files,
      ]);
      const sha256 = yield* sha256Hex(archive);
      const key = objectKeyOf(unitName);
      const stackit = yield* Effect.context<StackitOpContext>();

      // Sync the program. The presigned URL is signed by the key the deployer mints
      // here, so the download has to happen before that key goes away.
      yield* session.note(`Installing ${unitName}`);
      yield* withDeployerS3(
        artifacts,
        Effect.gen(function* () {
          yield* s3
            .putObject({
              Bucket: artifacts.bucketName,
              Key: key,
              Body: archive,
              ContentType: "application/zip",
            })
            .pipe(
              // A bucket that was just created may not be visible to S3 yet.
              Effect.retry({
                while: (error) => error._tag === "NoSuchBucket",
                schedule: Schedule.spaced("3 seconds"),
                times: 10,
              }),
            );
          const url = yield* Presign.presignS3Url({
            method: "GET",
            bucket: artifacts.bucketName,
            key,
            expiresIn: DOWNLOAD_URL_LIFETIME_SECONDS,
          });
          return yield* runScript({
            ...scope,
            what: `Installing ${unitName}`,
            script: installScript({
              unitName,
              url,
              sha256,
              iv: sealed.iv,
              probePort: news.port,
            }),
            timeout: INSTALL_TIMEOUT,
          }).pipe(Effect.provideContext(stackit));
        }).pipe(
          // A copy a failed cleanup leaves behind is sealed, and the next deploy
          // and the delete remove it.
          Effect.ensuring(
            s3.deleteObject({ Bucket: artifacts.bucketName, Key: key }).pipe(Effect.ignore),
          ),
        ),
      );

      return {
        serverId,
        projectId,
        region,
        port,
        publicIp,
        url: toUrl(publicIp, port),
        unitName,
        code: { hash: bundled.hash },
        artifacts: {
          bucketName: artifacts.bucketName,
          urlPathStyle: artifacts.urlPathStyle,
        },
      };
    }),

    delete: Effect.fn(function* ({ output, session }) {
      const { projectId, region, serverId, unitName, artifacts } = output;
      const scope = { projectId, region, serverId };
      const live = yield* iaas
        .getServer(scope)
        .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
      // A server that isn't running can't take a command. Stopping the server is
      // also the way past an agent that no longer answers.
      if (live?.status === "ACTIVE") {
        yield* runScript({
          ...scope,
          what: `Removing ${unitName}`,
          script: removeScript(unitName),
          timeout: REMOVE_TIMEOUT,
        }).pipe(Effect.catchTag("NotFound", () => Effect.void));
      } else if (live !== undefined) {
        yield* session.note(
          `Server ${serverId} is ${live.status ?? "in an unknown state"}: ${unitName} stays on it, and starts again if the server does`,
        );
      }
      yield* withDeployerS3(
        { projectId, region, ...artifacts },
        s3.deleteObject({ Bucket: artifacts.bucketName, Key: objectKeyOf(unitName) }),
      ).pipe(Effect.catchTag("NoSuchBucket", () => Effect.void));
    }),
  });
