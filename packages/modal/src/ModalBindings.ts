import { GrpcTransport } from "@distilled.cloud/core/grpc-transport";
import { withAuthToken } from "@distilled.cloud/modal/AuthToken";
import {
  containerSocket,
  Credentials,
  CredentialsFromEnv,
  credentials,
  fromContainer,
  streamTaskCommandRouter,
  withTaskCommandRouter,
} from "@distilled.cloud/modal/Credentials";
import { orDieCredentialsUnavailable } from "alchemy/Auth/Resolve";
import * as Binding from "alchemy/Binding";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import { CurrentRuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type * as Stream from "effect/Stream";
import { withAuthTokens } from "./Credentials.ts";
import type { OperationServices } from "./internal.ts";
import { ModalTransport } from "./internal/Transport.ts";
import { ServiceUser } from "./ServiceUser.ts";

/**
 * How a Modal binding reaches Modal from its host.
 *
 * Modal grants access per environment, as a `viewer` or a `contributor`. So:
 *
 * - a Modal Function or Server: nothing is bound. It calls Modal as its own
 *   container, over the API socket Modal gives every container
 *   (`fromContainer`), the way Modal's Python client does there. No
 *   credential is stored. A host with `restrictModalAccess` has no such
 *   access, so it gets a service user like any other host;
 * - any other host (a Cloudflare Worker, a Lambda, a Modal Sandbox):
 *   {@link Bind} creates a scoped `Modal.ServiceUser` for the
 *   host (`<host>ModalIdentity`), grants it the role each binding asks for
 *   on the bound resource's environment, and binds its token pair into the
 *   host's env (`MODAL_TOKEN_ID`, and `MODAL_TOKEN_SECRET` kept `Redacted`);
 * - no host (a script or a deploy-time Action): nothing is bound, and calls
 *   use the deployer's credentials.
 *
 * Modal's Starter plan has no service users. There, provide
 * {@link DeployerHostIdentity} to bind the deployer's own token pair into
 * each host instead: hosts then act with the deployer's workspace-wide
 * access, not the roles their bindings ask for.
 *
 * Import it as a namespace. A binding resolves its operations with
 * {@link withCredentials} and gets its `bind` from {@link Bind} when its layer
 * is built, then binds behind its own `__ALCHEMY_RUNTIME__` guard:
 *
 * ```ts
 * Effect.gen(function* () {
 *   const put = yield* ModalBindings.withCredentials(modalQueue.putQueue);
 *   const bind = yield* ModalBindings.Bind;
 *   return Effect.fn(function* (queue: Queue) {
 *     if (!globalThis.__ALCHEMY_RUNTIME__) {
 *       yield* bind`Modal.WriteQueue(${queue})`({
 *         roles: [{ environment: queue.environment, role: "contributor" }],
 *       });
 *     }
 *     const queueId = yield* queue.queueId;
 *     return (value) => put({ queueId: yield* queueId, values: [...] });
 *   });
 * })
 * ```
 */
export const TOKEN_ENV = {
  id: "MODAL_TOKEN_ID",
  secret: "MODAL_TOKEN_SECRET",
  // Not MODAL_SERVER_URL: inside a Modal container, Modal sets that to the
  // container's own socket (`unix:/run/modal.sock`), shadowing ours.
  serverUrl: "ALCHEMY_MODAL_SERVER_URL",
} as const;

/**
 * The identity {@link Bind} gives a binding's host:
 *
 * - `"service-user"`: a scoped `Modal.ServiceUser` per host with only the
 *   roles its bindings ask for (needs Modal's Team or Enterprise plan);
 * - `"deployer"`: the deployer's own token pair, with its workspace-wide
 *   access (for the Starter plan, which has no service users).
 *
 * Set it with {@link DeployerHostIdentity}.
 */
export const HostIdentity = Context.Reference<"service-user" | "deployer">("Modal/HostIdentity", {
  defaultValue: () => "service-user",
});

/**
 * Bind the deployer's own Modal token into binding hosts instead of a
 * scoped service user per host. Use it on Modal's Starter plan, which has
 * no service users; hosts then have the deployer's workspace-wide access.
 *
 * @example
 * ```ts
 * export default Alchemy.Stack(
 *   "App",
 *   { providers: Layer.mergeAll(Cloudflare.providers(), Modal.providers(), Modal.DeployerHostIdentity) },
 *   Effect.gen(function* () { ... }),
 * );
 * ```
 */
export const DeployerHostIdentity: Layer.Layer<never> = Layer.succeed(HostIdentity, "deployer");

/** A role a binding needs in one environment. */
export interface EnvironmentGrant {
  /** The environment's name; `undefined` is the workspace default. */
  readonly environment: Input<string | undefined>;
  readonly role: "viewer" | "contributor";
}

/** What a Modal binding attaches to its host. */
export interface HostBinding {
  /** Environment roles the host's identity needs. */
  readonly roles?: ReadonlyArray<EnvironmentGrant>;
  /** Env vars the binding reads at runtime. */
  readonly env?: Record<string, unknown>;
}

/** The signature {@link Bind} yields. */
export type BindHost = (
  label: TemplateStringsArray,
  ...args: unknown[]
) => (data?: HostBinding) => Effect.Effect<void>;

type BindTarget = {
  bind: (...args: unknown[]) => (data: unknown) => Effect.Effect<void>;
};

const labelled = (verb: string, label: TemplateStringsArray): TemplateStringsArray => {
  const strings = [`${verb}(`, `, ${label[0]}`, ...label.slice(1)];
  strings[strings.length - 1] += ")";
  return Object.assign(strings, { raw: strings }) as unknown as TemplateStringsArray;
};

/**
 * The `bind` for a binding's layer: yield it while the layer is built, then
 * call it from the returned function behind a literal
 * `if (!globalThis.__ALCHEMY_RUNTIME__)` so the bundler drops it. On a host it
 * grants `data.roles` to the host's service user and binds that user's token
 * pair (and `data.env`) into the host's env; with no host it does nothing.
 */
export const Bind: Effect.Effect<BindHost> = Effect.gen(function* () {
  // Bindings only bind at deploy, so a host bundle captures nothing here
  // and drops the identity resource.
  if (globalThis.__ALCHEMY_RUNTIME__) return () => () => Effect.void;
  const Identity = yield* ServiceUser;
  const identity = yield* HostIdentity;
  const ambient = yield* Effect.serviceOption(Credentials);
  return (label: TemplateStringsArray, ...args: unknown[]) =>
    Effect.fn(function* (data: HostBinding = {}) {
      const host = yield* Binding.Host;
      if (host === undefined) return;
      const runtime = yield* CurrentRuntimeContext;
      if (runtime === undefined) return;

      // A binding that calls no Modal API (only `env`) needs no identity, and
      // a Modal Function or Server calls as its own container.
      if (data.roles !== undefined && data.roles.length > 0 && !callsAsContainer(host)) {
        // The host talks to the deployer's Modal control plane.
        const resolve = Option.isSome(ambient)
          ? ambient.value
          : yield* Credentials.pipe(Effect.provide(CredentialsFromEnv));
        // Binding initialization can't fail; the engine reports this defect as
        // `CredentialsRequired`.
        const creds = yield* resolve.pipe(orDieCredentialsUnavailable("Modal"));
        if (identity === "deployer") {
          yield* runtime.set(TOKEN_ENV.id, creds.tokenId.pipe(Redacted.value, Output.literal));
          yield* runtime.set(TOKEN_ENV.secret, Output.literal(creds.tokenSecret));
        } else {
          const user = yield* Identity(`${host.LogicalId}ModalIdentity`, { scoped: true });
          yield* (user as unknown as BindTarget).bind(
            labelled("Allow", label),
            host,
            ...args,
          )({ environments: data.roles });
          yield* runtime.set(TOKEN_ENV.id, user.tokenId);
          yield* runtime.set(TOKEN_ENV.secret, user.tokenSecret);
        }
        yield* runtime.set(TOKEN_ENV.serverUrl, Output.literal(creds.apiBaseUrl));
      }
      for (const [name, value] of Object.entries(data.env ?? {})) {
        yield* runtime.set(name, Output.isOutput(value) ? value : Output.literal(value));
      }
    });
});

/** Host types whose containers call Modal over their own API socket. */
const CONTAINER_HOSTS = new Set(["Modal.Function", "Modal.Server"]);

/** Whether `host` calls Modal as its container instead of with a bound token. */
const callsAsContainer = (host: { readonly Type?: string; readonly Props?: unknown }) =>
  CONTAINER_HOSTS.has(host.Type ?? "") &&
  !(host.Props as { readonly restrictModalAccess?: boolean } | undefined)?.restrictModalAccess;

/**
 * The credentials, HTTP client and gRPC transport distilled operations run
 * with on this host. A resolved operation keeps them as a fallback under its
 * caller's context, so a Worker's own `HttpClient` doesn't displace the
 * transport.
 */
const operationContext = Effect.gen(function* () {
  const runtime = yield* CurrentRuntimeContext;
  if (globalThis.__ALCHEMY_RUNTIME__ && runtime !== undefined) {
    const tokenId = yield* runtime.get<string>(TOKEN_ENV.id);
    const tokenSecret = yield* runtime.get<string | Redacted.Redacted<string>>(TOKEN_ENV.secret);
    if (tokenId !== undefined && tokenSecret !== undefined) {
      const serverUrl = yield* runtime.get<string>(TOKEN_ENV.serverUrl);
      return yield* Layer.build(
        Layer.mergeAll(
          withAuthTokens(
            credentials({
              tokenId: Redacted.make(tokenId),
              tokenSecret: Redacted.isRedacted(tokenSecret)
                ? tokenSecret
                : Redacted.make(tokenSecret),
              apiBaseUrl: serverUrl,
            }),
          ),
          ModalTransport,
        ),
      ).pipe(Effect.scoped);
    }
    // A Modal Function or Server: call as the container (see `Bind`).
    const socket = yield* containerSocket;
    if (socket !== undefined) {
      return yield* Layer.build(
        Layer.mergeAll(
          withAuthToken.pipe(Layer.provide(Layer.mergeAll(fromContainer, FetchHttpClient.layer))),
          fromContainer,
          FetchHttpClient.layer,
        ),
      ).pipe(Effect.orDie, Effect.scoped);
    }
  }
  // No bound identity (deploy, scripts, Actions): the ambient Modal
  // credentials, falling back to `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET`.
  const ambientCredentials = yield* Effect.serviceOption(Credentials);
  const ambientHttp = yield* Effect.serviceOption(HttpClient.HttpClient);
  const transport = yield* Effect.provide(Effect.service(GrpcTransport), ModalTransport);
  return Context.make(
    Credentials,
    Option.isSome(ambientCredentials)
      ? ambientCredentials.value
      : yield* Credentials.pipe(Effect.provide(withAuthTokens(CredentialsFromEnv))),
  ).pipe(
    Context.add(
      HttpClient.HttpClient,
      Option.isSome(ambientHttp)
        ? ambientHttp.value
        : yield* HttpClient.HttpClient.pipe(Effect.provide(ModalTransport)),
    ),
    Context.add(GrpcTransport, transport),
  );
});

/**
 * Resolve a distilled operation (or several, with `Effect.all`) once when
 * the binding's layer is built: with the token pair {@link Bind} bound into
 * the host, or the deployer's credentials when there is none.
 *
 * @example
 * ```ts
 * const ops = yield* ModalBindings.withCredentials(
 *   operations({ getFile: volume.volumeGetFile2, putFiles: volume.volumePutFiles2 }),
 * );
 * ```
 */
export const withCredentials: <Op>(
  operation: Effect.Effect<Op, never, OperationServices>,
) => Effect.Effect<Op> = Effect.fn(function* <Op>(
  operation: Effect.Effect<Op, never, OperationServices>,
) {
  const context = yield* operationContext;
  return yield* operation.pipe(Effect.provide(context));
});

/**
 * Resolve a task command router operation for one sandbox: the router runs
 * per task, at a URL with its own JWT (from `sandboxGetCommandRouterAccess`).
 * The router credentials are applied on every call, because a resolved
 * operation runs with its caller's `Credentials` (the control plane's) over
 * the ones it captured. `withTaskCommandRouter` also supplies the HTTP/2
 * client the router requires.
 */
export const withRouter =
  <I, O, E>(operation: (input: I) => Effect.Effect<O, E, OperationServices>) =>
  (access: RouterAccess): Effect.Effect<(input: I) => Effect.Effect<O, E>> =>
    Effect.succeed((input: I) => operation(input).pipe(withTaskCommandRouter(access)));

/**
 * {@link withRouter} for a server-streaming router operation: its `.stream`,
 * which emits each message as the router sends it.
 */
export const streamRouter =
  <I, A, E>(operation: { readonly stream: (input: I) => Stream.Stream<A, E, OperationServices> }) =>
  (access: RouterAccess): Effect.Effect<(input: I) => Stream.Stream<A, E>> =>
    Effect.succeed((input: I) => operation.stream(input).pipe(streamTaskCommandRouter(access)));

/** A task's command router: its URL and JWT, from `sandboxGetCommandRouterAccess`. */
export interface RouterAccess {
  readonly url: string;
  readonly jwt: string;
}
