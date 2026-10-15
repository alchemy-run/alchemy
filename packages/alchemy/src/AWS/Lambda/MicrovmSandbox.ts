import type * as microvms from "@distilled.cloud/aws/lambda-microvms";
import type * as ConfigError from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  sandboxHost,
  type Sandbox as AISandbox,
  type SandboxHostService,
  type SandboxSize,
} from "../../AI/Sandbox.ts";
import type * as Bundle from "../../Bundle/Bundle.ts";
import type { ImageLayer } from "../../Docker/ImageLayer.ts";
import type { Main } from "../../Platform.ts";
import {
  EGRESS_PROXY_SWITCH,
  EGRESS_RUN_HOOK_SWITCH,
} from "../../Runtime/Bootstrap/EgressProxy.ts";
import { Role } from "../IAM/Role.ts";
import type { Providers } from "../Providers.ts";
import { MicrovmImage, type MicrovmImageServices } from "./MicrovmImage.ts";
import {
  MICROVM_SANDBOX_CONTROL_PORT,
  MICROVM_SANDBOX_HOST,
  MICROVM_SANDBOX_PORT,
  microvmSandboxImageId,
} from "./MicrovmSandboxHost.ts";
import type { NetworkConnector } from "./NetworkConnector.ts";

export { MICROVM_SANDBOX_HOST } from "./MicrovmSandboxHost.ts";

/**
 * A MicroVM's baseline memory, e.g. `"2 GB"`. Lambda MicroVMs offer 0.5, 1,
 * 2, 4 and 8 GB baselines (vCPU scales with memory, 2 GB = 1 vCPU) and burst
 * to four times the baseline.
 */
export type MicrovmSandboxMemory = `${number} GB`;

/**
 * Props of a sandbox on AWS Lambda MicroVMs: the program's image (`main`
 * bundled onto the MicroVM base, or onto `image`), and the memory of every
 * size the declaration names.
 */
export interface MicrovmSandboxProps<Size extends string = string> {
  /** The program's entrypoint, usually `import.meta.url`. */
  readonly main: string;
  /**
   * The memory each declared size runs with. A MicroVM's memory is fixed on
   * its image, so each size is its own image, built at deploy;
   * `start({ size })` picks the image.
   */
  readonly sizes: { readonly [K in Size]: MicrovmSandboxMemory };
  /**
   * A container base image to build on instead of the Lambda MicroVM base
   * (`public.ecr.aws/lambda/microvms:al2023-minimal`). It must be Linux,
   * public (or in this account's ECR) and snapshot compatible.
   */
  readonly image?: string;
  /** An inline Dockerfile base (`FROM …` plus steps), instead of `image`. */
  readonly dockerfile?: string;
  /** @default "node" */
  readonly runtime?: "node" | "bun";
  /** The port the program listens on. @default 3000 */
  readonly port?: number;
  /** Bundler configuration for `main`. */
  readonly build?: Bundle.BundleConfig;
  /** Module ids to leave external when bundling. */
  readonly external?: string[];
  /** Environment variables baked into every size's image. */
  readonly env?: Record<string, string>;
  /**
   * The role Lambda assumes to build the images, as an ARN or a
   * `AWS.IAM.Role`. @default a role created for this sandbox
   */
  readonly buildRole?: string | Role;
  /** The Lambda-managed MicroVM base image's ARN. @default the latest `al2023` */
  readonly baseImage?: string;
  /** CPU architectures to build for. */
  readonly cpuConfigurations?: microvms.CpuConfiguration[];
  /** Logging for the images' builds and their MicroVMs. */
  readonly logging?: microvms.Logging;
  /**
   * The egress network connector every MicroVM runs with: an
   * `AWS.Lambda.NetworkConnector` declaration (deployed with the sandbox) or a
   * connector ARN. A VPC egress connector puts the MicroVM's traffic under the
   * VPC's security groups and firewall: with one that only allows the egress
   * gateways, tools that ignore `HTTPS_PROXY` can't bypass them. A MicroVM
   * can't firewall itself (it runs without `CAP_NET_ADMIN`).
   * @default AWS's managed public-internet connector
   */
  readonly networkConnector?: string | Effect.Effect<NetworkConnector, never, any>;
}

/** The program a MicroVM sandbox runs: an HTTP server (`fetch`), e.g. a harness server. */
export type MicrovmSandboxProgram<InitReq> = Effect.Effect<
  Main<MicrovmImageServices>,
  ConfigError.ConfigError,
  InitReq
>;

const memoryInMiB = (memory: MicrovmSandboxMemory) => Math.round(Number.parseFloat(memory) * 1024);

/**
 * Host an `AI.Sandbox` declaration on AWS Lambda MicroVMs, run by the
 * Cloudflare Durable Object that owns it. The program is bundled into one
 * MicroVM image per declared size (a MicroVM's memory is fixed on its image),
 * with Alchemy's egress proxy and the tools of the egress kinds the
 * declaration accepts. Returns the Layer that satisfies `yield* Sandbox`:
 * provide it on the stack.
 *
 * The owning Durable Object runs the MicroVM with `RunMicrovm`; the
 * sandbox's requests to egress hosts go through the proxy in the MicroVM to
 * their gateways with short-lived grants, which the Durable Object renews on
 * its alarm and pushes to the proxy's control port.
 *
 * ### Hosting a program
 * **Example:** A shell server on two sizes
 * ```typescript
 * // src/Sandbox.microvm.ts
 * import * as AWS from "alchemy/AWS";
 * import { Sandbox } from "./Sandbox.ts";
 *
 * export default AWS.Lambda.MicrovmSandbox(
 *   Sandbox,
 *   {
 *     main: import.meta.url,
 *     // One MicroVM image per name, built at deploy; start() picks the image.
 *     sizes: { small: "2 GB", large: "8 GB" },
 *   },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.gen(function* () {
 *         return HttpServerResponse.text("hello from a MicroVM");
 *       }),
 *     };
 *   }),
 * );
 * ```
 *
 * **Example:** Claude Code as the program
 * ```typescript
 * export default AWS.Lambda.MicrovmSandbox(
 *   Sandbox,
 *   { main: import.meta.url, sizes: { small: "2 GB", large: "8 GB" } },
 *   Anthropic.ClaudeCodeServer("Claude", { cwd: "/workspace/app" }),
 * );
 * ```
 *
 * ### Using it from a Durable Object
 * The Durable Object's code is the same on every host: `start` runs a
 * MicroVM from the size's image, `httpClient(port)` reaches the program
 * through the MicroVM's endpoint, and `stop` terminates it.
 *
 * **Example:** Start with GitHub egress and call the program
 * ```typescript
 * export class Agent extends Cloudflare.DurableObject<Agent>()(
 *   "Agent",
 *   Effect.gen(function* () {
 *     const sandbox = yield* Sandbox;
 *     const work = yield* WorkGateway;
 *     return Effect.gen(function* () {
 *       return {
 *         run: (issue: number) =>
 *           Effect.gen(function* () {
 *             yield* sandbox.start({
 *               size: "large",
 *               egress: [work.repo.narrow({ repository: "alchemy-run/alchemy", issue })],
 *             });
 *             const client = yield* sandbox.httpClient(3000);
 *             return yield* client.get("http://sandbox/status");
 *           }),
 *         settle: () => sandbox.stop(),
 *       };
 *     });
 *   }),
 * ) {}
 * ```
 *
 * ### Sizes
 * Each size is an image of its own, so every declared size is built at
 * deploy. A missing or extra name does not compile.
 *
 * **Example:** A missing size
 * ```typescript
 * AWS.Lambda.MicrovmSandbox(Sandbox, { main, sizes: { small: "2 GB" } }, program);
 * // ✗ Property 'large' is missing in type '{ small: "2 GB"; }'
 * ```
 *
 * ### How the Durable Object reaches the MicroVM <!-- api-prose -->
 * Every request goes to the MicroVM's HTTPS endpoint with a short-lived
 * `X-aws-proxy-auth` token the Durable Object mints for one port, and
 * `X-aws-proxy-port` naming it: the program's port for `httpClient`, and the
 * egress control port (3129) for route-table pushes, which additionally
 * carry the bearer secret the Durable Object generated at `start` and keeps
 * in its storage. A MicroVM resumes from a snapshot taken at build time, so
 * the secret, the first route table and the program's environment
 * (placeholder credentials, `start({ env })`) arrive in the `/run`
 * lifecycle hook's payload. `exec` opens a WebSocket to the same control
 * port (`GET /exec`, same token and secret), served by the bootstrap: stdin,
 * stdout, stderr, exit code and `kill` work as on any host; a pty doesn't.
 *
 * ### Closing the internet <!-- api-prose -->
 * With egress, `start` defaults to `enableInternet: false`: the in-sandbox
 * proxy refuses every host without a route. A tool that ignores
 * `HTTPS_PROXY` would still reach the internet directly; to stop that, run
 * the MicroVMs on a VPC egress connector whose network only allows the
 * gateways.
 *
 * **Example:** MicroVMs on a VPC egress connector
 * ```typescript
 * export default AWS.Lambda.MicrovmSandbox(
 *   Sandbox,
 *   {
 *     main: import.meta.url,
 *     sizes: { small: "2 GB", large: "8 GB" },
 *     networkConnector: AWS.Lambda.NetworkConnector("SandboxEgress", {
 *       subnetIds: [privateSubnetId],
 *       securityGroupIds: [gatewaysOnlySecurityGroupId],
 *     }),
 *   },
 *   program,
 * );
 * ```
 *
 * @binding
 * @product Lambda
 * @category Lambda
 */
export const MicrovmSandbox = <const D extends AISandbox.Decl.Any, InitReq = never>(
  sandbox: D,
  props: MicrovmSandboxProps<SandboxSize<D>>,
  program: MicrovmSandboxProgram<InitReq>,
): Layer.Layer<AISandbox.Host<SelfOf<D>>, never, Providers> => {
  const id = sandbox.LogicalId;
  const { sizes, image, dockerfile, buildRole, env, port, networkConnector, ...imageProps } = props;
  const names = (Object.keys(sizes) as Array<keyof typeof sizes & string>).sort();
  // The accepted kinds' tools (`git`, `gh`) go into every size's image.
  const tools: ImageLayer[] = sandbox.egress.flatMap((kind) => [...(kind.tools ?? [])]);
  const tagFor = (size: string) =>
    (
      MicrovmImage as unknown as () => (id: string) => {
        make: (props: unknown, impl: unknown) => Layer.Layer<unknown, never, Providers>;
      } & Effect.Effect<unknown>
    )()(microvmSandboxImageId(id, size));

  const propsFor = (size: (typeof names)[number]) =>
    Effect.gen(function* () {
      const role = buildRole ?? (yield* Role(`${id}BuildRole`, {}));
      return {
        ...imageProps,
        main: props.main,
        port: port ?? MICROVM_SANDBOX_PORT,
        dockerfile: dockerfile ?? (image ? `FROM ${image}` : undefined),
        buildRole: role,
        imageLayers: tools,
        resources: [{ minimumMemoryInMiB: memoryInMiB(sizes[size]) }],
        env: {
          ...env,
          // The bootstrap runs the egress proxy, and takes its per-run
          // configuration from the `/run` hook on the control port.
          [EGRESS_PROXY_SWITCH]: "1",
          [EGRESS_RUN_HOOK_SWITCH]: "1",
          ALCHEMY_EGRESS_CONTROL_PORT: String(MICROVM_SANDBOX_CONTROL_PORT),
        },
        hooks: {
          port: MICROVM_SANDBOX_CONTROL_PORT,
          microvmHooks: { run: "ENABLED", runTimeoutInSeconds: 60 },
          microvmImageHooks: { ready: "ENABLED", readyTimeoutInSeconds: 600 },
        },
      };
    });

  // Every size is the same program: deploy builds each image, but a running
  // MicroVM serves it once.
  const built = (globalThis.__ALCHEMY_RUNTIME__ ? names.slice(0, 1) : names).map((size) =>
    tagFor(size).make(propsFor(size), program),
  );
  const host = Layer.effect(
    sandboxHost(id),
    Effect.gen(function* () {
      // A declared connector deploys with the sandbox; its ARN rides the descriptor.
      const connector =
        networkConnector === undefined || typeof networkConnector === "string"
          ? networkConnector
          : (yield* networkConnector).networkConnectorArn;
      return {
        descriptor: {
          host: MICROVM_SANDBOX_HOST,
          sizes,
          ...(connector !== undefined ? { networkConnector: connector } : {}),
        },
        image: tagFor(names[0]!),
        // The tools are already in every image (from the declaration's kinds).
        install: () => Effect.void,
      } satisfies SandboxHostService;
    }),
  );
  return Layer.mergeAll(host, ...built) as unknown as Layer.Layer<
    AISandbox.Host<SelfOf<D>>,
    never,
    Providers
  >;
};

type SelfOf<D> = D extends AISandbox.Decl<infer Self, any, any> ? Self : never;
