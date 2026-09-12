import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { makeFetchRpcStub } from "../Rpc.ts";
import { Sandbox } from "./Sandbox.ts";
import { sandboxOverRpc, type SandboxRpcShape } from "./SandboxRpc.ts";
import { Thread } from "./Thread.ts";

export interface SandboxHttpOptions {
  /**
   * Base URL of the sandbox server (`http://host:port`). Given as an
   * Effect it is resolved PER CALL, so the address may come from the
   * runtime environment (a binding the host filled in at deploy). An
   * `undefined` resolution fails the call model-visibly.
   */
  readonly url: string | Effect.Effect<string | undefined>;
  /**
   * Derive the MACHINE key from a session's thread key. ONE server is
   * shared by every session this layer serves, so PTY ids are scoped
   * by machine key — sessions keep separate shells on the same host.
   * @default the thread key itself
   */
  readonly machineKey?: (threadKey: string) => string;
}

/**
 * `AI.Sandbox` over a sandbox server at a FIXED address — the client
 * half of {@link serveSandbox}: the same guest RPC protocol the AWS
 * MicroVM and Cloudflare Container guests speak, minus the machine
 * (no launch, no suspend/resume, no lifecycle — the server is
 * somebody else's process, typically the developer's own workspace
 * served by `alchemy dev`).
 *
 * Every session addresses the SAME tree: this is a development
 * convenience for exercising sessions, tools, and terminals against a
 * live checkout without building a machine image — not an isolation
 * boundary.
 *
 * ```ts
 * // dev-mode Worker: the host process is a Command.Dev whose URL is
 * // bound into the Worker env at plan time
 * AI.SandboxHttp({
 *   url: runtime.get<string>("SANDBOX_URL"),
 *   machineKey: (key) => key.split("::")[0]!,
 * })
 * ```
 */
export const SandboxHttp = (
  options: SandboxHttpOptions,
): Layer.Layer<Sandbox> =>
  Layer.effect(
    Sandbox,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;

      const stubs = new Map<string, SandboxRpcShape>();
      const stubFor = (baseUrl: string): SandboxRpcShape => {
        const existing = stubs.get(baseUrl);
        if (existing !== undefined) return existing;
        const stub = makeFetchRpcStub<SandboxRpcShape>({
          baseUrl,
          fetch: (request) => client.execute(request),
        });
        stubs.set(baseUrl, stub);
        return stub;
      };

      const resolveUrl: Effect.Effect<string, string> = Effect.gen(
        function* () {
          const url =
            typeof options.url === "string" ? options.url : yield* options.url;
          if (url === undefined || url.length === 0) {
            return yield* Effect.fail(
              "sandbox server address is not configured (no URL bound for the sandbox host)",
            );
          }
          return url.replace(/\/+$/, "");
        },
      );

      // The error channel of every shape method is already `string`;
      // an unconfigured address fails the same way (typed here so the
      // shape's `E` flows through unchanged).
      const withStub = <A, E>(
        use: (stub: SandboxRpcShape) => Effect.Effect<A, E>,
      ): Effect.Effect<A, E> =>
        resolveUrl.pipe(
          Effect.flatMap((url) => use(stubFor(url))),
        ) as Effect.Effect<A, E>;

      // The session context carries Thread at call time (every driver
      // provides it); the contract's R stays clean — same cast the
      // MicroVM session layer makes.
      const ptyId = (id: string): Effect.Effect<string> =>
        Effect.map(Thread, (thread) => {
          const machine =
            options.machineKey === undefined
              ? thread.key
              : options.machineKey(thread.key);
          return `${machine}/${id}`;
        }) as unknown as Effect.Effect<string>;

      return sandboxOverRpc(withStub, { ptyId });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
