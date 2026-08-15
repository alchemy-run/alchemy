/**
 * The aggregate-smoke Effect Api (DEPTH.md row 7, the §1.1 showcase): ONE
 * Effect-mode Vercel Function carrying every runtime surface at once —
 *
 * - `ReadEdgeConfig(SmokeFlags)` — flag reads over the injected
 *   connection-string token,
 * - `ReadWriteBlob(SmokeUploads)` — blob put/get over the injected
 *   `BLOB_READ_WRITE_TOKEN` (the capability binding is what connects the
 *   store to this project),
 * - `SendMessage`/`subscribe`/`ReceiveMessages` — the D9a two-function
 *   queue shape (public routes produce, the platform push-delivers to the
 *   generated consumer func, which echoes into `SmokeEchoes` for readback),
 * - `cron` — a `CRON_SECRET`-guarded schedule route.
 *
 * Release identity (`API_VERSION` env + a rotated `Redacted` secret) is
 * parameterized through a module-level setter read by the PROPS EFFECT at
 * registration time: the test calls `setApiRelease("v2", …)` before a
 * deploy cycle to rotate the release in that cycle. Inside the deployed
 * bundle the props effect re-runs with the module defaults — harmless, the
 * runtime never reconciles.
 */
import * as Vercel from "@/Vercel/index.ts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { SmokeFlags } from "./smoke-flags.ts";
import { SmokeUploads } from "./smoke-store.ts";

export class SmokeJobs extends Vercel.Topic<SmokeJobs>()("alchemy-smoke-jobs", {
  schema: Schema.Struct({
    jobId: Schema.String,
    runId: Schema.String,
  }),
  region: "iad1",
  retentionSeconds: 300,
}) {}

export interface JobEcho {
  readonly jobId: string;
  readonly runId: string;
  readonly deliveryCount: number;
  readonly topicName: string;
  readonly consumerGroup: string;
}

export class SmokeEchoes extends Vercel.Topic<SmokeEchoes>()(
  "alchemy-smoke-echoes",
  {
    schema: Schema.Struct({
      jobId: Schema.String,
      runId: Schema.String,
      deliveryCount: Schema.Int,
      topicName: Schema.String,
      consumerGroup: Schema.String,
    }),
    region: "iad1",
    retentionSeconds: 300,
  },
) {}

// The release the NEXT registration deploys — mutated by the test between
// cycles (the props effect below reads it at registration time).
let apiVersion = "v1";
let apiSecret = "smoke-secret-v1";
export const setApiRelease = (version: string, secret: string) => {
  apiVersion = version;
  apiSecret = secret;
};

// Instance-global counters/buffers (readable on the same warm instance).
let cronFires = 0;
const received: JobEcho[] = [];

export default class SmokeApi extends Vercel.Function<SmokeApi>()(
  "SmokeApi",
  Effect.sync(() => ({
    main: import.meta.url,
    env: {
      API_VERSION: apiVersion,
      // Rotated between cycles: sensitive env var, fingerprint-diffed —
      // rotation MUST mint a new immutable deployment.
      API_SECRET: Redacted.make(apiSecret),
    },
  })),
  Effect.gen(function* () {
    const flags = yield* SmokeFlags;
    const config = yield* Vercel.ReadEdgeConfig(flags);
    const blob = yield* Vercel.ReadWriteBlob(SmokeUploads);
    const jobs = yield* Vercel.SendMessage(SmokeJobs);
    const echoes = yield* Vercel.SendMessage(SmokeEchoes);
    const echoReader = yield* Vercel.ReceiveMessages(SmokeEchoes, {
      consumerGroup: "alchemy-smoke-readback",
    });

    // Queue consumer half: decoded payload + delivery metadata re-published
    // into the echo topic for cross-function readback (the consumer func is
    // a separate artifact — module globals there are invisible here).
    yield* Vercel.subscribe(SmokeJobs, (job, meta) =>
      echoes
        .send({
          jobId: job.jobId,
          runId: job.runId,
          deliveryCount: meta.deliveryCount,
          topicName: meta.topicName,
          consumerGroup: meta.consumerGroup,
        })
        .pipe(Effect.orDie, Effect.asVoid),
    );
    // Echo topic needs a trigger too (sends into a trigger-less topic 503).
    yield* Vercel.subscribe(SmokeEchoes, () => Effect.void);

    yield* Vercel.cron(
      "0 3 * * *",
      Effect.sync(() => {
        cronFires++;
      }),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = yield* Effect.sync(
          () => new globalThis.URL(request.url, "http://localhost"),
        );

        // Release identity — the rollback/promote observable.
        if (url.pathname === "/version") {
          const body = yield* Effect.sync(() => ({
            version: process.env.API_VERSION ?? null,
            secretTail: (process.env.API_SECRET ?? "").slice(-2) || null,
          }));
          return yield* HttpServerResponse.json(body);
        }

        // Edge Config reads (data plane — shared across ALL deployments).
        if (url.pathname.startsWith("/flag/")) {
          const key = decodeURIComponent(url.pathname.slice("/flag/".length));
          const value = yield* config.get(key).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ value: value ?? null });
        }

        // Blob data path.
        if (url.pathname === "/blob/put") {
          const put = yield* blob
            .put(
              url.searchParams.get("path") ?? "",
              url.searchParams.get("body") ?? "",
              { contentType: "text/plain" },
            )
            .pipe(Effect.orDie);
          return yield* HttpServerResponse.json({
            etag: put.etag,
            pathname: put.pathname,
          });
        }
        if (url.pathname === "/blob/get") {
          const result = yield* blob
            .get(url.searchParams.get("path") ?? "")
            .pipe(
              Effect.flatMap((got) =>
                Effect.map(got.text, (text) => ({ text })),
              ),
              Effect.catchTag("Vercel.Blob.NotFound", () =>
                Effect.succeed({ notFound: true }),
              ),
              Effect.orDie,
            );
          return yield* HttpServerResponse.json(result);
        }

        // Queue producer + echo readback.
        if (url.pathname === "/send") {
          const runId = url.searchParams.get("runId") ?? "missing-run-id";
          const jobId = url.searchParams.get("jobId") ?? "job-1";
          yield* jobs.send({ jobId, runId }).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ queued: true, jobId, runId });
        }
        if (url.pathname === "/received") {
          const batch = yield* echoReader
            .receive({ maxMessages: 10, visibilityTimeoutSeconds: 60 })
            .pipe(Effect.orDie);
          for (const message of batch) {
            received.push(message.payload as JobEcho);
            yield* echoReader.ack(message.receiptHandle).pipe(Effect.orDie);
          }
          return yield* HttpServerResponse.json({ received });
        }

        if (url.pathname === "/cron-fires") {
          return yield* HttpServerResponse.json({ cronFires });
        }

        return yield* HttpServerResponse.json({ ok: true, path: request.url });
      }),
    };
  }).pipe(
    Effect.provide([
      Vercel.ReadEdgeConfigHttp,
      Vercel.ReadWriteBlobHttp,
      Vercel.SendMessageHttp,
      Vercel.ReceiveMessagesHttp,
      Vercel.QueueEventSourceLive,
      Vercel.CronEventSourceLive,
    ]),
  ),
) {}
