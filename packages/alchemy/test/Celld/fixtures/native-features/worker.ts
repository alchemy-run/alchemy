import { Assets, AssetsBinding } from "@/Celld/AssetsBinding.ts";
import { cron, CronEventSourceLive } from "@/Celld/CronEventSource.ts";
import { Namespace } from "@/Celld/KV/Namespace.ts";
import { ReadWriteNamespace } from "@/Celld/KV/ReadWriteNamespace.ts";
import { ReadWriteNamespaceBinding } from "@/Celld/KV/ReadWriteNamespaceBinding.ts";
import {
  consumeQueueMessages,
  EventSourceLive,
} from "@/Celld/Queues/EventSource.ts";
import { Queue } from "@/Celld/Queues/Queue.ts";
import { WriteQueue } from "@/Celld/Queues/WriteQueue.ts";
import { WriteQueueBinding } from "@/Celld/Queues/WriteQueueBinding.ts";
import { Fetch, FetchBinding } from "@/Celld/ServiceBinding.ts";
import { Worker, type CelldWorker } from "@/Celld/Worker.ts";
import { Resource } from "@/Resource.ts";
import { WorkerLoader } from "@/Celld/WorkerLoader.ts";
import { Workflow } from "@/Celld/Workflows/Workflow.ts";
import {
  sleep,
  task,
  waitForEvent,
  WorkflowStepContext,
} from "@/Celld/Workflows/WorkflowRuntime.ts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

type Job = { id: string; mode?: "retry" | "dead" };
type Report = { id: string; wait?: boolean };

export const reportRun = (input: Report) =>
  Effect.gen(function* () {
    const attempt = yield* task(
      "record",
      WorkflowStepContext.pipe(Effect.map((context) => context.attempt)),
    );
    yield* sleep("brief", 100);
    const approval = input.wait
      ? (yield* waitForEvent<{ approved: boolean }>("approval", {
          type: "approval",
          timeout: "1 minute",
        })).payload.approved
      : true;
    return { id: input.id, attempt, approved: approval };
  });

export const reportExport = {
  kind: "Celld.WorkflowExport" as const,
  run: (input: unknown) => reportRun(input as Report),
};

export default class NativeFeatures extends Worker<NativeFeatures>()(
  "NativeFeatures",
  { main: import.meta.url },
  Effect.gen(function* () {
    const observations = yield* ReadWriteNamespace(
      yield* Namespace.ref("OBSERVATIONS"),
    );
    const queue = yield* Queue.ref("JOBS");
    const dead = yield* Queue.ref("DEAD");
    const writer = yield* WriteQueue(queue);
    const assets = yield* Assets();
    const service = yield* Fetch(
      yield* Resource<CelldWorker>("Celld.Worker").ref("NativeService"),
      {
        bindingName: "SERVICE",
      },
    );
    const loader = yield* WorkerLoader();
    const observe = (key: string, value: unknown) =>
      Effect.sync(() => JSON.stringify(value)).pipe(
        Effect.flatMap((json) => observations.put(key, json)),
      );
    const reports = yield* Workflow("NativeReports", Effect.succeed(reportRun));
    yield* consumeQueueMessages<Job>(
      queue,
      {
        batchSize: 1,
        maxRetries: 1,
        retryDelay: "1 second",
        deadLetterQueue: dead,
      },
      (messages) =>
        Stream.runForEach(messages, (message) =>
          Effect.gen(function* () {
            yield* observe(`attempt:${message.body.id}:${message.attempts}`, {
              id: message.id,
              attempts: message.attempts,
            });
            if (
              message.body.mode === "dead" ||
              (message.body.mode === "retry" && message.attempts === 1)
            ) {
              yield* Effect.sync(() => message.retry({ delaySeconds: 1 }));
              return;
            }
            yield* observe(`queue:${message.body.id}`, {
              body: message.body,
              attempts: message.attempts,
              messageId: message.id,
            });
          }),
        ),
    );
    yield* consumeQueueMessages<Job>(dead, { batchSize: 1 }, (messages) =>
      Stream.runForEach(messages, (message) =>
        observe(`dead:${message.body.id}`, {
          body: message.body,
          attempts: message.attempts,
        }),
      ),
    );
    yield* cron("* * * * *", (event) =>
      observe("cron:last", {
        cron: event.cron,
        scheduledTime: event.scheduledTime,
      }),
    );
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = yield* Effect.sync(
          () => new URL(request.url, "http://native"),
        );
        const [, route, action, id = ""] = url.pathname.split("/");
        if (route === "observe")
          return yield* HttpServerResponse.json(
            yield* observations.get(decodeURIComponent(action), "json"),
          );
        if (route === "queue") {
          const jobs = (yield* request.json) as Job[];
          if (action === "batch")
            yield* writer.sendBatch(jobs.map((body) => ({ body })));
          else yield* writer.send(jobs[0]);
          return HttpServerResponse.text("queued", { status: 202 });
        }
        if (route === "workflow") {
          if (action === "create") {
            const input = (yield* request.json) as Report;
            const instance = yield* reports.create({
              id: input.id,
              params: input,
            });
            return yield* HttpServerResponse.json({ id: instance.id });
          }
          if (action === "batch") {
            const inputs = (yield* request.json) as Report[];
            const instances = yield* reports.createBatch(
              inputs.map((params) => ({ id: params.id, params })),
            );
            return yield* HttpServerResponse.json(
              instances.map((instance) => instance.id),
            );
          }
          if (action === "deleteBatch")
            return yield* HttpServerResponse.json(
              yield* reports.deleteBatch((yield* request.json) as string[]),
            );
          const instance = yield* reports.get(id);
          if (action === "status")
            return yield* HttpServerResponse.json(yield* instance.status());
          if (action === "pause") yield* instance.pause();
          else if (action === "resume") yield* instance.resume();
          else if (action === "restart") yield* instance.restart();
          else if (action === "terminate") yield* instance.terminate();
          else if (action === "delete") yield* instance.delete();
          else if (action === "event")
            yield* instance.sendEvent({
              type: "approval",
              payload: { approved: true },
            });
          else
            return HttpServerResponse.text("unknown workflow action", {
              status: 404,
            });
          return yield* HttpServerResponse.json({ ok: true });
        }
        if (route === "service") return yield* service(request);
        if (route === "loader") {
          const code = {
            compatibilityDate: "2026-09-01",
            mainModule: "main.js",
            modules: {
              "main.js": `import { WorkerEntrypoint } from "cloudflare:workers";
              export class Calculator extends WorkerEntrypoint { add(a, b) { return a + b + this.ctx.props.offset; } }
              export default { fetch(request, env) { return Response.json({ loaded: true, marker: env.marker, method: request.method }); } };`,
            },
            env: { marker: "native-loader" },
            globalOutbound: null,
          };
          const loaded =
            action === "named"
              ? yield* loader.get("native-features-memo", () => code)
              : yield* loader.load(code);
          const entrypoint = yield* loaded.getEntrypoint();
          const response = yield* entrypoint.fetch(
            HttpClientRequest.get("https://loaded.test/"),
          );
          const body = yield* response.json;
          const selected =
            action === "named"
              ? yield* loader.get("native-features-memo", () =>
                  Effect.die("Named loader evaluated its code callback twice"),
                )
              : loaded;
          const calculator = yield* selected.getEntrypoint<{
            add(a: number, b: number): number;
          }>("Calculator", { props: { offset: 3 } });
          const sum = yield* calculator.add(2, 4);
          return yield* HttpServerResponse.json({ body, sum });
        }
        if (route === "health")
          return yield* HttpServerResponse.json({
            runtime: "celld",
            fixture: "native-features",
          });
        return yield* assets.fetch(request);
      }).pipe(
        Effect.catchCause((cause) =>
          HttpServerResponse.json(
            { error: Cause.pretty(cause) },
            { status: 500 },
          ),
        ),
      ),
    };
  }).pipe(
    Effect.orDie,
    Effect.provide(
      Layer.mergeAll(
        ReadWriteNamespaceBinding,
        WriteQueueBinding,
        EventSourceLive,
        CronEventSourceLive,
        AssetsBinding,
        FetchBinding,
      ),
    ),
  ),
) {}
