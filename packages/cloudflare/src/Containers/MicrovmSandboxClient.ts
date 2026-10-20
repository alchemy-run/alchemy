import {
  SandboxError,
  type SandboxClient,
  type SandboxEgressOptions,
  type SandboxHostDescriptor,
  type SandboxPort,
  type SandboxStartOptions,
} from "@alchemy.run/ai/Sandbox";
import { execOverSocket } from "@alchemy.run/ai/SandboxExec";
import { CreateAuthToken } from "@alchemy.run/aws/Lambda/CreateAuthToken";
import { CreateAuthTokenHttp } from "@alchemy.run/aws/Lambda/CreateAuthTokenHttp";
import { GetMicrovm } from "@alchemy.run/aws/Lambda/GetMicrovm";
import { GetMicrovmHttp } from "@alchemy.run/aws/Lambda/GetMicrovmHttp";
import type { MicrovmImage } from "@alchemy.run/aws/Lambda/MicrovmImage";
import { MicrovmImage as MicrovmImagePlatform } from "@alchemy.run/aws/Lambda/MicrovmImage";
import { microvmAuthHeaders } from "@alchemy.run/aws/Lambda/MicrovmRpc";
import {
  MICROVM_SANDBOX_CONTROL_PORT,
  MICROVM_SANDBOX_HOST,
  microvmSandboxImageId,
} from "@alchemy.run/aws/Lambda/MicrovmSandboxHost";
import { RunMicrovm, type RunMicrovmRequest } from "@alchemy.run/aws/Lambda/RunMicrovm";
import { RunMicrovmHttp } from "@alchemy.run/aws/Lambda/RunMicrovmHttp";
import { TerminateMicrovm } from "@alchemy.run/aws/Lambda/TerminateMicrovm";
import { TerminateMicrovmHttp } from "@alchemy.run/aws/Lambda/TerminateMicrovmHttp";
/**
 * The Durable Object side of `AWS.Lambda.MicrovmSandbox` (Egress/DESIGN.md
 * §8 "Anywhere else", §10, §12): an `AI.Sandbox` client over Lambda
 * MicroVMs, for a Cloudflare Durable Object.
 *
 * The object stores what it granted (`{ ttl, egress }`) and the MicroVM it
 * runs (`{ id, endpoint, size, secret }`). `start` mints grants
 * (`Egress.grant`) and runs a MicroVM from the size's image with the control
 * secret, the first route table and the program's environment in the `/run`
 * hook's payload. The proxy in the MicroVM can't mint, so the object renews:
 * an `Alchemy.makeCallback` job on its alarm re-mints at 40% of the TTL and
 * pushes the fresh table to the proxy's control port (`PUT /routes`, bearer
 * secret). Pushing only swaps the proxy's table: open connections keep the
 * grant they started with.
 *
 * Loaded lazily by the Cloudflare Durable Object platform (only objects that
 * own a MicroVM sandbox bundle it).
 */
import type * as cf from "@cloudflare/workers-types";
import type * as microvms from "@distilled.cloud/aws/lambda-microvms";
import { type Callback, makeCallback } from "alchemy/Callback";
import { canonicalJson } from "alchemy/Egress/Canonical";
import { type EgressError, grant, placeholdersFor } from "alchemy/Egress/Gateway";
import type { EgressRef } from "alchemy/Egress/Kind";
import type { Route } from "alchemy/Egress/Route";
import type { RunPayload } from "alchemy/Runtime/EgressProxy";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import { HttpClientError, TransportError } from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Socket from "effect/socket/Socket";
import { onAlarmCallbacksReady } from "../Workers/AlarmCallback.ts";
import { DurableObjectState } from "../Workers/DurableObjectState.ts";

/** What the owning Durable Object stores for one MicroVM sandbox. */
export interface StoredMicrovmSandbox {
  /** Each grant's lifetime, in milliseconds. */
  readonly ttl: number;
  /** The granted egresses; each names its gateway. */
  readonly egress: ReadonlyArray<EgressRef>;
  /** The running MicroVM (absent while stopped). */
  readonly microvm?: RunningMicrovm;
}

interface RunningMicrovm {
  readonly id: string;
  /** The MicroVM endpoint's host name. */
  readonly endpoint: string;
  readonly size: string;
  /** Authenticates route-table pushes to the proxy's control port. */
  readonly secret: string;
}

const DEFAULT_TTL = Duration.minutes(5);

/**
 * `RunMicrovm` rejects a `runHookPayload` over 4,096 characters: a larger
 * first table is pushed once the MicroVM runs.
 */
const MAX_RUN_PAYLOAD = 4096;

/** Renew at 40% of the TTL: one renewal can fail and the next still lands before expiry. */
const renewIn = (ttl: number) => Math.max(1_000, Math.floor(ttl * 0.4));

const storageKey = (id: string) => `alchemy:egress:${id}`;

/** MicroVM states that still hold the sandbox (it can be resumed or is starting). */
const LIVE_STATES = new Set(["PENDING", "RUNNING", "SUSPENDING", "SUSPENDED"]);

const sandboxError = (message: string) => (cause: unknown) =>
  new SandboxError({
    message: `${message}: ${cause instanceof Error || (typeof cause === "object" && cause !== null && "message" in cause) ? String((cause as { message: unknown }).message) : String(cause)}`,
    cause,
  });

const imageTag = (id: string, size: string) =>
  (MicrovmImagePlatform as unknown as () => (id: string) => Effect.Effect<unknown>)()(
    microvmSandboxImageId(id, size),
  );

/** One size's MicroVM operations, bound to its image. */
interface SizeOps {
  readonly imageArn: Effect.Effect<string>;
  readonly run: (
    request: RunMicrovmRequest,
  ) => Effect.Effect<microvms.RunMicrovmResponse, microvms.RunMicrovmError>;
  readonly get: (
    request: microvms.GetMicrovmRequest,
  ) => Effect.Effect<microvms.GetMicrovmResponse, microvms.GetMicrovmError>;
  readonly token: (
    request: microvms.CreateMicrovmAuthTokenRequest,
  ) => Effect.Effect<microvms.CreateMicrovmAuthTokenResponse, microvms.CreateMicrovmAuthTokenError>;
  readonly terminate: (
    request: microvms.TerminateMicrovmRequest,
  ) => Effect.Effect<microvms.TerminateMicrovmResponse, microvms.TerminateMicrovmError>;
}

/** Each object's renewal callback, registered when its instance initializes. */
const renewals = new WeakMap<object, Map<string, Callback<Record<string, never>>>>();

/**
 * @internal Connect declaration `id` to its MicroVMs from the Durable Object
 * that owns it: at deploy, bind the MicroVM operations on each size's image
 * into the object's Worker (an assumed IAM role); at run time, the client.
 */
export const connectMicrovmSandbox = (id: string, descriptor: SandboxHostDescriptor) =>
  Effect.gen(function* () {
    if (descriptor.host !== MICROVM_SANDBOX_HOST) {
      return yield* Effect.die(
        new SandboxError({ message: `Sandbox '${id}' is not hosted on AWS Lambda MicroVMs.` }),
      );
    }
    const sizes = Object.keys(descriptor.sizes).sort();
    const ops: Record<string, SizeOps> = {};
    yield* Effect.gen(function* () {
      for (const size of sizes) {
        // The platform tag yields the image resource (its Outputs bind into the Worker).
        const image = (yield* imageTag(id, size)) as MicrovmImage;
        ops[size] = {
          imageArn: (yield* image.imageArn) as unknown as Effect.Effect<string>,
          run: yield* RunMicrovm(image),
          get: yield* GetMicrovm(image),
          token: yield* CreateAuthToken(image),
          terminate: yield* TerminateMicrovm(image),
        };
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(RunMicrovmHttp, GetMicrovmHttp, CreateAuthTokenHttp, TerminateMicrovmHttp),
      ),
    );
    const state = yield* DurableObjectState;
    // Resolved to the ARN at deploy (see `AI.Sandbox`'s descriptor binding).
    const networkConnector =
      typeof descriptor.networkConnector === "string" ? descriptor.networkConnector : undefined;
    return makeMicrovmSandboxClient(id, state.raw, ops, networkConnector);
  });

const makeMicrovmSandboxClient = (
  id: string,
  state: cf.DurableObjectState,
  ops: Record<string, SizeOps>,
  networkConnector: string | undefined,
): SandboxClient => {
  const key = storageKey(id);
  const load = Effect.tryPromise({
    try: () => state.storage.get<StoredMicrovmSandbox>(key),
    catch: sandboxError("reading the sandbox's state failed"),
  });
  const save = (stored: StoredMicrovmSandbox) =>
    Effect.tryPromise({
      try: () => state.storage.put(key, stored),
      catch: sandboxError("storing the sandbox's state failed"),
    });

  const opsFor = (size: string) =>
    ops[size] !== undefined
      ? Effect.succeed(ops[size])
      : Effect.fail(new SandboxError({ message: `Unknown sandbox size '${size}'.` }));

  //#region endpoint

  /** Auth headers per MicroVM and port, minted for 15 minutes and reused for 12. */
  const tokens = new Map<string, { headers: Record<string, string>; renewAt: number }>();
  const authHeaders = (vm: RunningMicrovm, port: number) =>
    Effect.gen(function* () {
      const cacheKey = `${vm.id}:${port}`;
      const cached = tokens.get(cacheKey);
      const now = Date.now();
      if (cached && now < cached.renewAt) return cached.headers;
      const size = yield* opsFor(vm.size);
      const { authToken } = yield* size
        .token({
          microvmIdentifier: vm.id,
          expirationInMinutes: 15,
          allowedPorts: [{ port }],
        })
        .pipe(Effect.mapError(sandboxError("minting a MicroVM auth token failed")));
      const headers = {
        ...microvmAuthHeaders(authToken),
        "X-aws-proxy-port": String(port),
      };
      tokens.set(cacheKey, { headers, renewAt: now + 12 * 60_000 });
      return headers;
    });

  /** `request` sent to `port` inside the MicroVM, through its endpoint. */
  const toEndpoint = (
    vm: RunningMicrovm,
    port: number,
    request: HttpClientRequest.HttpClientRequest,
  ) =>
    Effect.gen(function* () {
      const url = new URL(request.url, "http://sandbox");
      const headers = yield* authHeaders(vm, port);
      return request.pipe(
        HttpClientRequest.setUrl(`https://${vm.endpoint}${url.pathname}${url.search}`),
        HttpClientRequest.setHeaders(headers),
      );
    });

  /** Replace the proxy's route table (`[]`: nothing is routed). */
  const pushRoutes = (vm: RunningMicrovm, routes: ReadonlyArray<Route>) =>
    Effect.gen(function* () {
      const request = yield* toEndpoint(
        vm,
        MICROVM_SANDBOX_CONTROL_PORT,
        HttpClientRequest.put("/routes").pipe(
          HttpClientRequest.bearerToken(Redacted.make(vm.secret)),
          HttpClientRequest.bodyJsonUnsafe(routes),
        ),
      );
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.execute(request).pipe(
        Effect.mapError(sandboxError("pushing the egress routes failed")),
        Effect.flatMap((response) =>
          response.status === 204
            ? Effect.void
            : response.text.pipe(
                Effect.orElseSucceed(() => ""),
                Effect.flatMap((text) =>
                  Effect.fail(
                    new SandboxError({
                      message: `pushing the egress routes failed: ${response.status} ${text}`,
                    }),
                  ),
                ),
              ),
        ),
        // A suspended MicroVM resumes on traffic (502 while it can't).
        Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 5 }),
      );
      return response;
    }).pipe(Effect.provide(FetchHttpClient.layer));

  //#endregion

  //#region lifecycle

  const describe = (vm: RunningMicrovm) =>
    Effect.gen(function* () {
      const size = yield* opsFor(vm.size);
      return yield* size.get({ microvmIdentifier: vm.id }).pipe(
        Effect.map((described) => described.state as string),
        Effect.catchTag("ResourceNotFoundException", () => Effect.succeed("TERMINATED")),
        Effect.mapError(sandboxError("reading the MicroVM failed")),
      );
    });

  /** The stored MicroVM if it still runs (or can resume). */
  const live = (stored: StoredMicrovmSandbox | undefined) =>
    Effect.gen(function* () {
      if (!stored?.microvm) return undefined;
      const status = yield* describe(stored.microvm);
      return LIVE_STATES.has(status) ? stored.microvm : undefined;
    });

  const waitRunning = (vm: RunningMicrovm) =>
    describe(vm).pipe(
      Effect.flatMap((status) =>
        status === "RUNNING"
          ? Effect.void
          : LIVE_STATES.has(status)
            ? Effect.fail(new SandboxError({ message: `MicroVM ${vm.id} is ${status}` }))
            : Effect.die(new SandboxError({ message: `MicroVM ${vm.id} is ${status}` })),
      ),
      Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 45 }),
    );

  const routesFor = (next: Omit<StoredMicrovmSandbox, "microvm">) =>
    next.egress.length === 0
      ? Effect.succeed([] as ReadonlyArray<Route>)
      : grant(next.egress, { ttl: Duration.millis(next.ttl) }).pipe(
          Effect.map((granted) => granted.routes),
        );

  const merge = (
    stored: StoredMicrovmSandbox | undefined,
    options: SandboxEgressOptions,
  ): Omit<StoredMicrovmSandbox, "microvm"> => ({
    ttl:
      options.ttl !== undefined
        ? Duration.toMillis(options.ttl)
        : (stored?.ttl ?? Duration.toMillis(DEFAULT_TTL)),
    egress:
      options.egress !== undefined ? options.egress.map((e) => e.ref) : (stored?.egress ?? []),
  });

  const same = (
    stored: StoredMicrovmSandbox | undefined,
    next: Omit<StoredMicrovmSandbox, "microvm">,
  ) =>
    stored !== undefined &&
    canonicalJson({ ttl: stored.ttl, egress: stored.egress }) === canonicalJson(next);

  const scheduleRenewal = (next: Omit<StoredMicrovmSandbox, "microvm">) =>
    Effect.gen(function* () {
      const renewal = renewals.get(state)?.get(id);
      if (!renewal) return;
      yield* (
        next.egress.length === 0
          ? renewal.cancel("renew")
          : renewal.schedule("renew", { after: Duration.millis(renewIn(next.ttl)), payload: {} })
      ).pipe(Effect.catchTag("CallbackError", (e) => Effect.logWarning("egress renewal", e)));
    });

  const cancelRenewal = Effect.suspend(() => {
    const renewal = renewals.get(state)?.get(id);
    return renewal ? renewal.cancel("renew").pipe(Effect.ignore) : Effect.void;
  });

  /** Re-mint and push what's stored to the running MicroVM, then schedule the next renewal. */
  const renew = Effect.gen(function* () {
    const stored = yield* load;
    if (!stored?.microvm || stored.egress.length === 0) return;
    const vm = yield* live(stored);
    if (!vm) {
      yield* save({ ttl: stored.ttl, egress: stored.egress });
      return;
    }
    yield* pushRoutes(vm, yield* routesFor(stored));
    yield* scheduleRenewal(stored);
  });

  // The renewal callback registers when this instance initializes (an
  // alarm callback can only be registered then).
  if (globalThis.__ALCHEMY_RUNTIME__ && !renewals.get(state)?.has(id)) {
    onAlarmCallbacksReady(
      state,
      `alchemy/egress/microvm/${id}`,
      Effect.gen(function* () {
        const renewal = yield* makeCallback(`alchemy/egress/microvm/${id}`, () => renew, {
          retry: { delay: "5 seconds" },
        });
        let byId = renewals.get(state);
        if (!byId) {
          byId = new Map();
          renewals.set(state, byId);
        }
        byId.set(id, renewal as Callback<Record<string, never>>);
      }),
    );
  }

  //#endregion

  const start = (
    options: SandboxStartOptions,
  ): Effect.Effect<void, SandboxError | EgressError, RuntimeContext> =>
    Effect.gen(function* () {
      const size = yield* opsFor(options.size);
      const stored = yield* load;
      const next = merge(stored, options);
      const running = yield* live(stored);
      if (running) {
        if (same(stored, next)) return;
        yield* pushRoutes(running, yield* routesFor(next));
        yield* save({ ...next, microvm: running });
        yield* scheduleRenewal(next);
        return;
      }
      // Conflicts and refusals fail here, before anything runs or is stored.
      const routes = yield* routesFor(next);
      const secret = yield* Effect.sync(() =>
        `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", ""),
      );
      const env = { ...placeholdersFor(next.egress), ...options.env };
      // As on Cloudflare: with egress, only the gateways unless asked otherwise.
      const internet = options.enableInternet ?? next.egress.length === 0;
      const full: RunPayload = { secret, routes, env, internet };
      const inline = JSON.stringify(full).length <= MAX_RUN_PAYLOAD;
      const payload = JSON.stringify(inline ? full : { secret, env, internet });
      const imageArn = yield* size.imageArn;
      // arn:<partition>:lambda:<region>:<account>:microvm-image:<name>
      const regionPrefix = imageArn.split(":").slice(0, 4).join(":");
      const launched = yield* size
        .run({
          runHookPayload: payload,
          egressNetworkConnectors: [
            networkConnector ??
              `${regionPrefix}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`,
          ],
          idlePolicy: {
            autoResumeEnabled: true,
            maxIdleDurationSeconds: 900,
            suspendedDurationSeconds: 3600,
          },
        })
        .pipe(Effect.mapError(sandboxError("running the MicroVM failed")));
      const vm: RunningMicrovm = {
        id: launched.microvmId,
        endpoint: launched.endpoint,
        size: options.size,
        secret,
      };
      yield* save({ ...next, microvm: vm });
      yield* waitRunning(vm);
      if (!inline) yield* pushRoutes(vm, routes);
      yield* scheduleRenewal(next);
    });

  const setEgress = (
    options: SandboxEgressOptions,
  ): Effect.Effect<void, SandboxError | EgressError, RuntimeContext> =>
    Effect.gen(function* () {
      const stored = yield* load;
      const next = merge(stored, options);
      const routes = yield* routesFor(next);
      const running = yield* live(stored);
      if (running) yield* pushRoutes(running, routes);
      yield* save({ ...next, ...(running ? { microvm: running } : {}) });
      if (running) yield* scheduleRenewal(next);
    });

  const stop = (): Effect.Effect<void, SandboxError, RuntimeContext> =>
    Effect.gen(function* () {
      const stored = yield* load;
      yield* cancelRenewal;
      if (!stored?.microvm) return;
      const vm = stored.microvm;
      // Refuse every routed host first, then terminate.
      yield* pushRoutes(vm, []).pipe(Effect.ignore);
      const size = yield* opsFor(vm.size);
      yield* size.terminate({ microvmIdentifier: vm.id }).pipe(
        Effect.catchTag("ResourceNotFoundException", () => Effect.void),
        Effect.mapError(sandboxError("terminating the MicroVM failed")),
      );
      for (const cached of tokens.keys()) if (cached.startsWith(`${vm.id}:`)) tokens.delete(cached);
      yield* save({ ttl: stored.ttl, egress: stored.egress });
    });

  /** A request to `port` in the running MicroVM. */
  const fetchPort = (port: number, request: HttpClientRequest.HttpClientRequest) =>
    Effect.gen(function* () {
      const stored = yield* load;
      if (!stored?.microvm) {
        return yield* new SandboxError({ message: `Sandbox '${id}' is not running.` });
      }
      const client = yield* HttpClient.HttpClient;
      return yield* client.execute(yield* toEndpoint(stored.microvm, port, request));
    }).pipe(Effect.provide(FetchHttpClient.layer));

  const getTcpPort = (port: number) =>
    Effect.succeed({
      fetch: (request) => fetchPort(port, request),
    } satisfies SandboxPort);

  return {
    running: Effect.map(Effect.flatMap(load, live), (vm) => vm !== undefined),
    start,
    setEgress,
    exec: (cmd, options) =>
      Effect.gen(function* () {
        const vm = yield* Effect.flatMap(load, live);
        if (vm === undefined) {
          return yield* new SandboxError({
            message: "exec needs a running sandbox: call start first.",
          });
        }
        // The bootstrap's exec server, on the control port, behind the bearer secret.
        const headers = yield* authHeaders(vm, MICROVM_SANDBOX_CONTROL_PORT);
        const socket = yield* Socket.fromWebSocket(
          Effect.acquireRelease(
            Effect.tryPromise({
              try: () =>
                fetch(`https://${vm.endpoint}/exec`, {
                  headers: {
                    ...headers,
                    Upgrade: "websocket",
                    Authorization: `Bearer ${vm.secret}`,
                  },
                }).then((response) => {
                  const ws = (response as unknown as { webSocket?: cf.WebSocket }).webSocket;
                  if (!ws)
                    return Promise.reject(new Error(`exec upgrade answered ${response.status}`));
                  ws.accept();
                  return ws as unknown as Socket.WebSocketLike;
                }),
              catch: (cause) =>
                new Socket.SocketError({
                  reason: new Socket.SocketOpenError({ kind: "Unknown", cause }),
                }),
            }),
            (ws) => Effect.sync(() => ws.close(1000)),
          ),
        );
        return yield* execOverSocket(socket, cmd, options);
      }),
    getTcpPort,
    httpClient: (port) =>
      Effect.succeed(
        HttpClient.make(
          (request) =>
            fetchPort(port, request).pipe(
              Effect.catchTag("SandboxError", (error) =>
                Effect.fail(
                  new HttpClientError({
                    reason: new TransportError({
                      request,
                      cause: error,
                      description: error.message,
                    }),
                  }),
                ),
              ),
            ) as Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError>,
        ),
      ),
    stop,
  } satisfies SandboxClient;
};
