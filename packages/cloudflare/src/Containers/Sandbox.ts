import {
  sandboxHost,
  type Sandbox as AISandbox,
  type SandboxHostService,
  type SandboxSize,
} from "@alchemy.run/ai/Sandbox";
import type { EgressKind } from "alchemy/Egress/Kind";
import type { InputProps } from "alchemy/Input";
import { EGRESS_CA_SWITCH } from "alchemy/Runtime/EgressCa";
import type * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Providers } from "../Providers.ts";
import type { WorkerShape } from "../Workers/Worker.ts";
import type { ContainerApplication, DurableObjectContainerProps } from "./ContainerApplication.ts";
import { ContainerPlatform } from "./ContainerPlatform.ts";
import { CLOUDFLARE_CONTAINER_HOST, type ContainerInstanceType } from "./SandboxClient.ts";

/**
 * Props of a sandbox on a Cloudflare Container: the program's image
 * (`main` bundled onto `image` or an inline `dockerfile`), and the instance
 * type of every size the declaration names. The container is scheduled by
 * the Durable Object that owns it.
 */
export type SandboxProps<Size extends string = string> = InputProps<
  Omit<DurableObjectContainerProps, "schedulingPolicy" | "main"> & {
    /** The program's entrypoint, usually `import.meta.url`. */
    main: string;
  }
> & {
  /**
   * The instance type each declared size starts on. Every size is one image:
   * `start({ size })` only picks the instance type.
   */
  readonly sizes: { readonly [K in Size]: ContainerInstanceType };
};

/**
 * Host an `AI.Sandbox` declaration on a Cloudflare Container scheduled by
 * the Durable Object that owns it. The program is bundled into the
 * Container's one image; each declared size is an instance type, chosen at
 * `start({ size })`. Returns the Layer that satisfies `yield* Sandbox`:
 * provide it on the stack.
 *
 * ### Hosting a harness server
 * A harness server (`Anthropic.ClaudeCodeServer`, `OpenAI.CodexServer`,
 * `OpenCode.Server`, `AI.AcpServer`) yields `{ fetch }`, so it can be the
 * whole program.
 *
 * **Example:** Claude Code as the program
 * ```typescript
 * // src/Sandbox.cloudflare.ts
 * import * as Anthropic from "@alchemy.run/anthropic";
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import { Sandbox } from "./Sandbox.ts";
 *
 * export default Cloudflare.Containers.Sandbox(
 *   Sandbox,
 *   {
 *     main: import.meta.url,
 *     runtime: "node",
 *     image: "node:24-bookworm",
 *     // A name is an instance type, chosen at start(): no extra builds.
 *     sizes: { small: "lite", large: "standard-4" },
 *   },
 *   Anthropic.ClaudeCodeServer("Claude", { cwd: "/workspace/app" }),
 * );
 * ```
 *
 * ### Your own routes next to a server
 * **Example:** Route to the server's `fetch`
 * ```typescript
 * export default Cloudflare.Containers.Sandbox(
 *   Sandbox,
 *   { main: import.meta.url, runtime: "node", sizes: { small: "lite", large: "standard-4" } },
 *   Effect.gen(function* () {
 *     const claude = yield* Anthropic.ClaudeCodeServer("Claude", { cwd: "/workspace/app" });
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         if (request.url === "/health") return HttpServerResponse.text("ok");
 *         return yield* claude.fetch;
 *       }),
 *     };
 *   }),
 * );
 * ```
 *
 * ### Sizes
 * Each host maps every size the declaration names. A missing or extra name
 * does not compile.
 *
 * **Example:** A missing size
 * ```typescript
 * Cloudflare.Containers.Sandbox(Sandbox, { main, sizes: { small: "lite" } }, program);
 * // ✗ Property 'large' is missing in type '{ small: "lite"; }'
 * ```
 *
 * @binding
 * @product Containers
 * @category Containers
 */
export const Sandbox = <const D extends AISandbox.Decl.Any, InitReq = never, WorkerReq = never>(
  sandbox: D,
  props: SandboxProps<SandboxSize<D>>,
  program: Effect.Effect<WorkerShape<WorkerReq>, Config.ConfigError, InitReq>,
): Layer.Layer<AISandbox.Host<SelfOf<D>>, never, Providers> => {
  const id = sandbox.LogicalId;
  const { sizes, ...containerProps } = props;
  // One Container is one image: the declaration's id names it, so a
  // Durable Object's `yield* Sandbox` binds this image.
  const tag = (
    ContainerPlatform as unknown as () => (id: string) => {
      make: (props: unknown, impl: unknown) => Layer.Layer<unknown, never, Providers>;
    } & Effect.Effect<unknown>
  )()(id);
  const application = tag.make({ ...containerProps, schedulingPolicy: "durable_object" }, program);
  const host = Layer.succeed(sandboxHost(id), {
    descriptor: { host: CLOUDFLARE_CONTAINER_HOST, sizes },
    image: tag,
    // The accepted kinds' tools, and the switch that makes the program
    // trust the interception CA (placeholders are set at start).
    install: (kinds: ReadonlyArray<EgressKind<string, never>>) =>
      Effect.gen(function* () {
        const application = (yield* tag) as unknown as ContainerApplication;
        const tools = kinds.flatMap((kind) => kind.tools ?? []);
        yield* application.bind`AcceptedEgress`({
          env: { [EGRESS_CA_SWITCH]: "1" },
          ...(tools.length > 0 ? { image: tools } : {}),
        });
      }),
  } satisfies SandboxHostService);
  return Layer.merge(application, host) as unknown as Layer.Layer<
    AISandbox.Host<SelfOf<D>>,
    never,
    Providers
  >;
};

type SelfOf<D> = D extends AISandbox.Decl<infer Self, any, any> ? Self : never;
