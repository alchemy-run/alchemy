import * as Celld from "@alchemy.run/celld";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { Notes, NotesLive } from "./object.ts";
import {
  Database,
  Dead,
  FeatureApi,
  FeatureService,
  Files,
  Jobs,
  Observations,
} from "./resources.ts";

type Job = { id: string; mode?: "retry" | "dead" };
type Report = { id: string; wait?: boolean };

const Bindings = Layer.mergeAll(
  Celld.KV.ReadWriteNamespaceBinding,
  Celld.D1.QueryDatabaseBinding,
  Celld.R2.ReadWriteBucketBinding,
  Celld.Queues.WriteQueueBinding,
  Celld.Queues.EventSourceLive,
  Celld.CronEventSourceLive,
  Celld.AssetsBinding,
  Celld.FetchBinding,
  NotesLive,
);

export default FeatureApi.make(
  {
    main: import.meta.url,
    assets: { directory: "public", binding: "ASSETS", runWorkerFirst: true },
    env: { GREETING: "hello from env" },
  },
  Effect.gen(function* () {
    const observations = yield* Celld.KV.ReadWriteNamespace(yield* Observations);
    const db = yield* Celld.D1.QueryDatabase(yield* Database);
    const files = yield* Celld.R2.ReadWriteBucket(yield* Files);
    const jobs = yield* Jobs;
    const dead = yield* Dead;
    const writer = yield* Celld.Queues.WriteQueue(jobs);
    const assets = yield* Celld.Assets();
    const service = yield* Celld.Fetch(yield* FeatureService, { bindingName: "SERVICE" });
    const loader = yield* Celld.WorkerLoader();
    const notes = yield* Notes;
    // Read from the deployer's environment and bound onto the Worker.
    const secret = yield* Config.Redacted("CELLD_FEATURE_SECRET");
    const observe = (key: string, value: unknown) =>
      Effect.sync(() => JSON.stringify(value)).pipe(
        Effect.flatMap((json) => observations.put(key, json)),
      );
    const reports = yield* Celld.Workflow(
      "Reports",
      Effect.succeed((input: Report) =>
        Effect.gen(function* () {
          const attempt = yield* Celld.Workflows.task(
            "record",
            Celld.Workflows.WorkflowStepContext.pipe(Effect.map((context) => context.attempt)),
          );
          yield* Celld.Workflows.sleep("brief", 100);
          const approved = input.wait
            ? (yield* Celld.Workflows.waitForEvent<{ approved: boolean }>("approval", {
                type: "approval",
                timeout: "1 minute",
              })).payload.approved
            : true;
          return { id: input.id, attempt, approved };
        }),
      ),
    );
    yield* Celld.Queues.consumeQueueMessages<Job>(
      jobs,
      { batchSize: 1, maxRetries: 1, retryDelay: "1 second", deadLetterQueue: dead },
      (messages) =>
        Stream.runForEach(messages, (message) =>
          Effect.gen(function* () {
            yield* observe(`attempt:${message.body.id}:${message.attempts}`, {
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
            });
          }),
        ),
    );
    yield* Celld.Queues.consumeQueueMessages<Job>(dead, { batchSize: 1 }, (messages) =>
      Stream.runForEach(messages, (message) =>
        observe(`dead:${message.body.id}`, { body: message.body, attempts: message.attempts }),
      ),
    );
    yield* Celld.cron("* * * * *", (event) =>
      observe("cron:last", { cron: event.cron, scheduledTime: event.scheduledTime }),
    );
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = yield* Effect.sync(() => new URL(request.url, "http://feature"));
        const [, route, action = "", id = ""] = url.pathname.split("/");
        if (route === "health") return yield* HttpServerResponse.json({ runtime: "celld" });
        if (route === "config")
          return yield* HttpServerResponse.json({
            greeting: yield* Config.String("GREETING"),
            secret: Redacted.value(secret),
          });
        if (route === "observe")
          return yield* HttpServerResponse.json(
            yield* observations.get(decodeURIComponent(action), "json"),
          );
        if (route === "kv") {
          if (request.method === "PUT") {
            yield* observations.put(action, yield* request.text, {
              metadata: { version: 1 },
            });
            return HttpServerResponse.text("ok");
          }
          if (request.method === "DELETE") {
            yield* observations.delete(action);
            return HttpServerResponse.text("ok");
          }
          if (action === "")
            return yield* HttpServerResponse.json(
              yield* observations.list({ prefix: url.searchParams.get("prefix") ?? "" }),
            );
          return yield* HttpServerResponse.json(
            yield* observations.getWithMetadata(action, "text"),
          );
        }
        if (route === "d1") {
          if (request.method === "POST") {
            yield* db
              .prepare("INSERT INTO items (id, value) VALUES (?, ?)")
              .bind(action, yield* request.text)
              .run();
            return HttpServerResponse.text("ok");
          }
          return yield* HttpServerResponse.json(
            yield* db.prepare("SELECT id, value FROM items ORDER BY id").all(),
          );
        }
        if (route === "r2") {
          if (request.method === "PUT") {
            yield* files.put(action, yield* request.text, {
              httpMetadata: { contentType: "text/plain" },
              customMetadata: { author: "alchemy" },
            });
            return HttpServerResponse.text("ok");
          }
          if (request.method === "DELETE") {
            yield* files.delete(action);
            return HttpServerResponse.text("ok");
          }
          if (action === "") {
            const page = yield* files.list();
            return yield* HttpServerResponse.json(page.objects.map((object) => object.key));
          }
          const object = yield* files.get(action);
          if (!object) return HttpServerResponse.text("missing", { status: 404 });
          return yield* HttpServerResponse.json({
            text: yield* object.text(),
            customMetadata: object.customMetadata,
          });
        }
        if (route === "notes") {
          const stub = notes.getByName(action);
          if (request.method === "POST") yield* stub.insert(yield* request.text);
          return yield* HttpServerResponse.json({
            ...(yield* stub.list()),
            count: yield* stub.count(),
          });
        }
        if (route === "queue") {
          const batch = (yield* request.json) as Job[];
          if (action === "batch") yield* writer.sendBatch(batch.map((body) => ({ body })));
          else yield* writer.send(batch[0]!);
          return HttpServerResponse.text("queued", { status: 202 });
        }
        if (route === "workflow") {
          if (action === "create") {
            const input = (yield* request.json) as Report;
            const instance = yield* reports.create({ id: input.id, params: input });
            return yield* HttpServerResponse.json({ id: instance.id });
          }
          const instance = yield* reports.get(id);
          if (action === "status") return yield* HttpServerResponse.json(yield* instance.status());
          if (action === "event")
            yield* instance.sendEvent({ type: "approval", payload: { approved: true } });
          else return HttpServerResponse.text("unknown workflow action", { status: 404 });
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
              export default {
                async fetch(request, env) {
                  const url = new URL(request.url);
                  console.log("loaded-request", url.searchParams.get("id"));
                  return Response.json({ loaded: true, marker: env.marker });
                }
              };`,
            },
            env: { marker: "feature-loader" },
            globalOutbound: null,
            tails: [service.raw],
          };
          const loaded =
            action === "named"
              ? yield* loader.get("feature-memo", () => code)
              : yield* loader.load(code);
          const entrypoint = yield* loaded.getEntrypoint();
          const response = yield* entrypoint.fetch(
            HttpClientRequest.get(`https://loaded.test/?id=${url.searchParams.get("id") ?? ""}`),
          );
          const calculator = yield* loaded.getEntrypoint<{ add(a: number, b: number): number }>(
            "Calculator",
            { props: { offset: 3 } },
          );
          return yield* HttpServerResponse.json({
            body: yield* response.json,
            sum: yield* calculator.add(2, 4),
          });
        }
        return yield* assets.fetch(request);
      }).pipe(
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ error: Cause.pretty(cause) }, { status: 500 }),
        ),
      ),
    };
  }).pipe(Effect.orDie, Effect.provide(Bindings)),
);
