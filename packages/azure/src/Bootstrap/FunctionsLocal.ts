/**
 * Process entry for an Effect-native `Azure.Functions.Function` under
 * `alchemy dev`. It runs the program's init like `./Functions.ts`, then:
 *
 * - serves `fetch` on the local port (see `./FunctionsLocalCore.ts`);
 * - polls each `queueTrigger` queue and runs its handler per message, the
 *   way the Functions host does (a failed message is retried after its
 *   visibility timeout; after five dequeues it moves to `<queue>-poison`);
 * - runs each `timerTrigger` on its NCRONTAB schedule.
 *
 * Other triggers (Event Grid, Service Bus, Event Hubs, Cosmos DB, Durable
 * Task) do not run locally; the bootstrap logs a warning for each.
 *
 * There is no managed identity locally: bindings get a placeholder token,
 * which the Storage emulator route drops in favour of Azurite's SAS. A
 * binding to a remote (non-emulated) resource therefore fails to authorize.
 */
import { Credentials, fromStaticToken } from "@distilled.cloud/azure";
import * as storageQueue from "@distilled.cloud/azure/storage-queue";
import { NodeServices } from "@effect/platform-node";
import { reifyBoundConfigProvider } from "alchemy/Runtime";
import { entrypointLayer, stackFromEnv } from "alchemy/Runtime/Bootstrap";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Cron from "effect/Cron";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Result from "effect/Result";
import {
  functionRegistry,
  type RegisteredTrigger,
  type TriggerInvocation,
} from "../Functions/internal.ts";
import { installStorageEmulator, listen } from "./FunctionsLocalCore.ts";

/** Placeholder credentials: there is no identity to get a token from locally. */
const localCredentials = fromStaticToken({ bearerToken: "alchemy-local", subscriptionId: "" });

const runtimeLayer = Layer.mergeAll(localCredentials, FetchHttpClient.layer);

const withRuntime = <A, E>(effect: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>) =>
  effect.pipe(Effect.provide(runtimeLayer));

const tryJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/** Resolve `%SETTING%` references in a trigger binding value, as the host does. */
const settingValue = (value: unknown) =>
  typeof value === "string"
    ? value.replace(/%([^%]+)%/g, (_match, key: string) => process.env[key] ?? "")
    : undefined;

const invoke = (
  name: string,
  trigger: RegisteredTrigger,
  invocation: Omit<TriggerInvocation, "functionName" | "invocationId">,
) =>
  Effect.tryPromise(() =>
    trigger.run({ ...invocation, functionName: name, invocationId: crypto.randomUUID() }),
  );

/** Poll a Storage queue and run `trigger` once per message. */
const consumeQueue = (name: string, trigger: RegisteredTrigger) =>
  Effect.gen(function* () {
    const connection = settingValue(trigger.binding.connection) ?? "AzureWebJobsStorage";
    const url = process.env[`${connection}__queueServiceUri`];
    const queueName = settingValue(trigger.binding.queueName);
    if (url === undefined || queueName === undefined || queueName === "") {
      return yield* Effect.logWarning(
        `queue trigger ${name}: no queue endpoint in ${connection}__queueServiceUri`,
      );
    }
    const poisonQueue = `${queueName}-poison`;
    const handle = (message: storageQueue.DequeuedMessageItem) =>
      Effect.gen(function* () {
        const result = yield* Effect.result(
          invoke(name, trigger, {
            input: tryJson(message.MessageText),
            metadata: {
              Id: message.MessageId,
              DequeueCount: message.DequeueCount,
              InsertionTime: message.InsertionTime,
              ExpirationTime: message.ExpirationTime,
              NextVisibleTime: message.TimeNextVisible,
              PopReceipt: message.PopReceipt,
            },
          }),
        );
        const remove = storageQueue.DeleteMessageId({
          url,
          queueName,
          messageid: message.MessageId,
          popreceipt: message.PopReceipt,
        });
        if (Result.isSuccess(result)) return yield* remove;
        if (message.DequeueCount >= 5) {
          yield* storageQueue
            .CreateQueue({ url, queueName: poisonQueue })
            .pipe(Effect.catchTag("QueueAlreadyExists", () => Effect.void));
          yield* storageQueue.MessagesEnqueue({
            url,
            queueName: poisonQueue,
            MessageText: message.MessageText,
          });
          yield* remove;
          return yield* Effect.logError(
            `queue trigger ${name}: message ${message.MessageId} moved to ${poisonQueue}`,
            result.failure,
          );
        }
        // Left on the queue: it is visible again after the visibility timeout.
        yield* Effect.logWarning(
          `queue trigger ${name}: message ${message.MessageId} failed (dequeue ${message.DequeueCount})`,
          result.failure,
        );
      });
    const poll = storageQueue
      .MessagesDequeue({ url, queueName, numofmessages: 16, visibilitytimeout: 30 })
      .pipe(
        Effect.tap((messages) => Effect.forEach(messages, handle, { discard: true })),
        Effect.map((messages) => messages.length),
      );
    yield* withRuntime(poll).pipe(
      Effect.catch((error) =>
        Effect.logWarning(`queue trigger ${name}: polling ${queueName} failed`, error).pipe(
          Effect.as(0),
        ),
      ),
      Effect.flatMap((count) => (count === 0 ? Effect.sleep("1 second") : Effect.void)),
      Effect.forever,
    );
  });

/** Run `trigger` on its NCRONTAB schedule (six fields, seconds first). */
const runTimer = (name: string, trigger: RegisteredTrigger) =>
  Effect.gen(function* () {
    const schedule = String(trigger.binding.schedule ?? "");
    const parsed = Cron.parse(schedule);
    if (Result.isFailure(parsed)) {
      return yield* Effect.logWarning(`timer trigger ${name}: cannot parse "${schedule}"`);
    }
    const cron = parsed.success;
    yield* Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const next = Cron.next(cron, now).getTime();
      yield* Effect.sleep(Duration.millis(Math.max(0, next - now)));
      const result = yield* Effect.result(
        invoke(name, trigger, {
          input: { isPastDue: false, IsPastDue: false },
          metadata: {},
        }),
      );
      if (Result.isFailure(result)) {
        yield* Effect.logWarning(`timer trigger ${name} failed`, result.failure);
      }
    }).pipe(Effect.forever);
  });

/** Run the program's init, then serve it and drive its triggers locally. */
export const bootstrap = async (entrypoint: unknown): Promise<void> => {
  installStorageEmulator();
  const initialized = Deferred.makeUnsafe<void>();
  const platform = Layer.mergeAll(
    NodeServices.layer,
    FetchHttpClient.layer,
    Logger.layer([Logger.consolePretty()]),
  );
  const program = Deferred.succeed(initialized, undefined).pipe(
    Effect.andThen(Effect.never),
    Effect.provide(
      entrypointLayer(entrypoint).pipe(
        Layer.provideMerge(stackFromEnv),
        Layer.provideMerge(localCredentials),
        Layer.provideMerge(platform),
        Layer.provideMerge(
          Layer.succeed(
            ConfigProvider.ConfigProvider,
            reifyBoundConfigProvider(ConfigProvider.fromEnv(), process.env),
          ),
        ),
      ),
    ),
    Effect.scoped,
  );
  Effect.runFork(
    program.pipe(
      Effect.tapCause((cause) => Effect.logError("Azure Functions program failed", cause)),
      Effect.onExit(() =>
        Deferred.die(initialized, new Error("Azure Functions program exited during init")),
      ),
    ),
  );
  await Effect.runPromise(Deferred.await(initialized));

  const registry = functionRegistry();
  for (const [name, trigger] of registry.triggers) {
    const type = trigger.binding.type.toLowerCase();
    if (type === "queuetrigger") Effect.runFork(consumeQueue(name, trigger));
    else if (type === "timertrigger") Effect.runFork(runTimer(name, trigger));
    else console.warn(`${trigger.binding.type} function ${name} does not run under alchemy dev`);
  }
  await listen(registry.http);
};
