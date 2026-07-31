/**
 * Live Lambda dev-side runtime.
 *
 * Runs inside the AWS local RPC child process. Maintains one AppSync Events
 * subscription for the whole stack, tracks the locally-served functions
 * (registered by the local Function provider), and executes invocations
 * forwarded by deployed bridge sandboxes:
 *
 * - `init` — a bridge sandbox announced itself: remember its `workerId`,
 *   function id and forwarded environment (including the execution role's
 *   credentials).
 * - `next` — an invocation: reply `ping` immediately (extends the bridge's
 *   wait to the invocation deadline), run the handler in a per-worker child
 *   process, publish `response`/`error` back to the sandbox's channel.
 * - Unknown worker (this process restarted) — publish `reboot` so the bridge
 *   re-sends `init`, and buffer the invocation until it does.
 */
import * as Redacted from "effect/Redacted";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { fileURLToPath } from "node:url";
import { Stack } from "../../../Stack.ts";
import { AWSEnvironment } from "../../Environment.ts";
import { AppSyncEventsClient } from "./AppSyncEvents.ts";
import { ensureEventApi, type EventApi } from "./EventApi.ts";
import {
  channelPrefix,
  DEV_SOURCE,
  devChannel,
  encodePackets,
  PacketAssembler,
  workerChannel,
  type ErrorBody,
  type InitBody,
  type Message,
  type MessageType,
  type NextBody,
  type Packet,
} from "./Protocol.ts";
import { EVENT_API_NAME } from "./EventApi.ts";

/**
 * Entry module of the per-worker handler child process. Resolved relative to
 * this file so it works both from `src/` (bun / tests) and the compiled
 * `lib/` (published package).
 */
export const LIVE_CHILD_ENTRY_URL = import.meta.resolve(
  import.meta.url.endsWith(".ts") ? "./Child.ts" : "./Child.js",
  import.meta.url,
);

export interface FunctionTarget {
  /** Absolute path to the locally-built entry module. */
  bundlePath: string;
  /** Export name of the handler (`default` for Effect Functions). */
  handler: string;
}

interface RegisteredTarget extends FunctionTarget {
  /** Bumped on every rebuild; children on an older version are recycled. */
  version: number;
}

interface Worker {
  functionId: string;
  environment: Record<string, string>;
}

interface HandlerChild {
  functionId: string;
  version: number;
  address: Deferred.Deferred<string>;
  scope: Scope.Closeable;
  lock: Semaphore.Semaphore;
}

interface ChildInvokeResponse {
  ok: boolean;
  result?: unknown;
  error?: ErrorBody;
}

export class LiveLambdaRuntime extends Context.Service<
  LiveLambdaRuntime,
  {
    readonly eventApi: EventApi;
    readonly channelPrefix: string;
    /** Register (or refresh after a rebuild) a locally-served function. */
    readonly setTarget: (
      functionId: string,
      target: FunctionTarget,
    ) => Effect.Effect<void>;
    /** Stop serving a function locally and recycle its children. */
    readonly removeTarget: (functionId: string) => Effect.Effect<void>;
  }
>()("alchemy/AWS/Lambda/LiveLambdaRuntime") {}

export const makeLiveLambdaRuntime = Effect.gen(function* () {
  const stack = yield* Stack;
  const environment = yield* AWSEnvironment.current;
  const httpClient = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const rootScope = yield* Effect.scope;

  const eventApi = yield* ensureEventApi.pipe(Effect.orDie);
  const prefix = channelPrefix(EVENT_API_NAME, stack.name, stack.stage);

  const client = new AppSyncEventsClient({
    httpEndpoint: eventApi.httpEndpoint,
    realtimeEndpoint: eventApi.realtimeEndpoint,
    region: environment.region,
    getCredentials: () =>
      Effect.runPromise(
        environment.credentials.pipe(
          Effect.map((credentials) => ({
            accessKeyId: Redacted.value(credentials.accessKeyId),
            secretAccessKey: Redacted.value(credentials.secretAccessKey),
            sessionToken: credentials.sessionToken
              ? Redacted.value(credentials.sessionToken)
              : undefined,
          })),
        ),
      ),
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => client.close()));

  const targets = new Map<string, RegisteredTarget>();
  const workers = new Map<string, Worker>();
  const children = new Map<string, HandlerChild>();
  /** Invocations that arrived before their worker's `init` (or re-`init`). */
  const pendingNexts = new Map<string, NextBody[]>();

  const publish = (
    type: MessageType,
    workerId: string,
    id: string,
    body: unknown,
  ) =>
    Effect.forEach(
      encodePackets(type, DEV_SOURCE, id, body),
      (packet) =>
        Effect.tryPromise(() =>
          client.publish(workerChannel(prefix, workerId), packet),
        ).pipe(
          Effect.retry({
            schedule: Schedule.exponential(200),
            times: 3,
          }),
        ),
      { discard: true },
    );

  const killChild = Effect.fn(function* (workerId: string) {
    const child = children.get(workerId);
    if (!child) return;
    children.delete(workerId);
    yield* Scope.close(child.scope, Exit.void);
  });

  const spawnChild = Effect.fn(function* (workerId: string, worker: Worker) {
    const target = targets.get(worker.functionId);
    if (!target) {
      return yield* Effect.fail(
        new Error(
          `function "${worker.functionId}" is not being served by this dev session`,
        ),
      );
    }
    const scope = yield* Scope.fork(rootScope);
    const main = fileURLToPath(LIVE_CHILD_ENTRY_URL);
    const bin = typeof globalThis.Bun !== "undefined" ? "bun" : "node";
    const command = ChildProcess.make(
      bin,
      {
        bun: ["run", main],
        node: main.endsWith(".ts")
          ? [
              "--experimental-transform-types",
              "--no-warnings=ExperimentalWarning",
              main,
            ]
          : [main],
      }[bin],
      {
        stdout: "pipe",
        stderr: "pipe",
        detached: false,
        env: {
          // The deployed sandbox's environment: binding env vars, ALCHEMY_*,
          // AWS_REGION and the execution role's credentials — so local code
          // runs with the same configuration and permissions as the real
          // function.
          ...worker.environment,
          ALCHEMY_LIVE_BUNDLE: target.bundlePath,
          ALCHEMY_LIVE_HANDLER: target.handler,
          NODE_OPTIONS: "--enable-source-maps",
        },
        extendEnv: true,
      },
    );
    const handle = yield* spawner.spawn(command).pipe(Scope.provide(scope));
    yield* Scope.addFinalizer(
      scope,
      handle.kill({ forceKillAfter: "500 millis" }).pipe(Effect.ignore),
    );

    const address = yield* Deferred.make<string>();
    const label = `[${worker.functionId}]`;
    let found = false;
    yield* handle.stdout.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.runForEach((line) => {
        if (!found) {
          const match = line.match(
            /<ALCHEMY_CHILD_ADDRESS>(.+)<\/ALCHEMY_CHILD_ADDRESS>/,
          );
          if (match) {
            found = true;
            return Deferred.succeed(address, match[1]);
          }
        }
        return Effect.log(`${label} ${line}`);
      }),
      Effect.ignore,
      Effect.forkIn(scope),
    );
    yield* handle.stderr.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.runForEach((line) => Effect.logError(`${label} ${line}`)),
      Effect.ignore,
      Effect.forkIn(scope),
    );

    const child: HandlerChild = {
      functionId: worker.functionId,
      version: target.version,
      address,
      scope,
      lock: Semaphore.makeUnsafe(1),
    };
    children.set(workerId, child);
    return child;
  });

  const ensureChild = Effect.fn(function* (workerId: string, worker: Worker) {
    const target = targets.get(worker.functionId);
    const existing = children.get(workerId);
    if (existing && target && existing.version === target.version) {
      return existing;
    }
    if (existing) {
      yield* killChild(workerId);
    }
    return yield* spawnChild(workerId, worker);
  });

  const invokeChild = Effect.fn(function* (
    child: HandlerChild,
    next: NextBody,
  ) {
    const address = yield* Deferred.await(child.address).pipe(
      Effect.timeoutOrElse({
        duration: "30 seconds",
        orElse: () =>
          Effect.fail(new Error("local handler child failed to start")),
      }),
    );
    const response = yield* httpClient
      .execute(
        HttpClientRequest.post(`${address}/invoke`).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            event: next.event,
            context: next.context,
          }),
        ),
      )
      .pipe(
        Effect.flatMap((response) => response.json),
        Effect.timeoutOrElse({
          // The bridge gives up at the invocation deadline anyway; cap the
          // local run slightly past it so a hung handler can't pin the child.
          duration:
            Math.max(next.context.deadlineMs - Date.now(), 1_000) + 5_000,
          orElse: () => Effect.fail(new Error("local handler timed out")),
        }),
      );
    return response as unknown as ChildInvokeResponse;
  });

  const handleNext = Effect.fn(function* (next: NextBody) {
    // Acknowledge immediately so the bridge extends its wait from the 16s
    // offline window to the invocation deadline.
    yield* publish("ping", next.workerId, next.requestId, {});

    const worker = workers.get(next.workerId);
    if (!worker) {
      // We restarted and lost the worker's environment — ask the bridge to
      // re-introduce itself and park the invocation until it does.
      const pending = pendingNexts.get(next.workerId) ?? [];
      pending.push(next);
      pendingNexts.set(next.workerId, pending);
      yield* publish("reboot", next.workerId, next.requestId, {});
      return;
    }

    const result = yield* Effect.gen(function* () {
      const child = yield* ensureChild(next.workerId, worker);
      return yield* Semaphore.withPermits(
        child.lock,
        1,
      )(invokeChild(child, next));
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed<ChildInvokeResponse>({
          ok: false,
          error: {
            errorType: "Error",
            errorMessage:
              error instanceof Error ? error.message : String(error),
          },
        }),
      ),
    );

    if (result.ok) {
      yield* publish("response", next.workerId, next.requestId, {
        result: result.result,
      });
    } else {
      yield* publish("error", next.workerId, next.requestId, result.error);
    }
  });

  const handleMessage = Effect.fn(function* (message: Message) {
    switch (message.type) {
      case "init": {
        const init = JSON.parse(message.body) as InitBody;
        workers.set(init.workerId, {
          functionId: init.functionId,
          environment: init.environment,
        });
        yield* Effect.log(
          `[${init.functionId}] connected (worker: ${init.workerId})`,
        );
        const pending = pendingNexts.get(init.workerId) ?? [];
        pendingNexts.delete(init.workerId);
        yield* Effect.forEach(
          pending,
          (next) => handleNext(next).pipe(Effect.forkIn(rootScope)),
          { discard: true },
        );
        break;
      }
      case "next": {
        const next = JSON.parse(message.body) as NextBody;
        yield* handleNext(next).pipe(Effect.forkIn(rootScope));
        break;
      }
    }
  });

  const assembler = new PacketAssembler();
  const messages = Stream.callback<Message>((queue) =>
    Effect.acquireRelease(
      Effect.tryPromise(() =>
        client.subscribe(devChannel(prefix), (raw) => {
          try {
            const packet = JSON.parse(raw) as Packet;
            if (packet.source === DEV_SOURCE) return;
            const message = assembler.push(packet);
            if (message) {
              Queue.offerUnsafe(queue, message);
            }
          } catch {
            // malformed packet — ignore
          }
        }),
      ),
      (unsubscribe) => Effect.sync(() => unsubscribe()),
    ),
  );
  yield* messages.pipe(Stream.runForEach(handleMessage), Effect.forkScoped);

  return LiveLambdaRuntime.of({
    eventApi,
    channelPrefix: prefix,
    setTarget: Effect.fn(function* (functionId, target) {
      const existing = targets.get(functionId);
      targets.set(functionId, {
        ...target,
        version: (existing?.version ?? 0) + 1,
      });
      // Recycle children running the previous build; they respawn with the
      // fresh bundle on the next invocation.
      yield* Effect.forEach(
        [...children.entries()].filter(
          ([, child]) => child.functionId === functionId,
        ),
        ([workerId]) => killChild(workerId),
        { discard: true },
      );
    }),
    removeTarget: Effect.fn(function* (functionId) {
      targets.delete(functionId);
      yield* Effect.forEach(
        [...children.entries()].filter(
          ([, child]) => child.functionId === functionId,
        ),
        ([workerId]) => killChild(workerId),
        { discard: true },
      );
    }),
  });
});

export const LiveLambdaRuntimeLive = () =>
  Layer.effect(LiveLambdaRuntime, makeLiveLambdaRuntime);
