// The effectful site module: default-exports the Website class, anchored
// by `main: import.meta.url`. The engine imports it at plan time (binding
// collection — bucket/queue env vars + IAM onto the server Lambda) and the
// deployed Lambda's virtual entry re-imports it to serve `/api/*`.
//
// Narrow subpath imports only (`alchemy/AWS/S3`, not `alchemy/AWS`): this
// module is bundled into the Lambda — the provider barrel would drag the
// whole IaC engine along with it.
import { QueueEventSource } from "alchemy/AWS/Lambda/QueueEventSource";
import * as S3 from "alchemy/AWS/S3";
import * as SQS from "alchemy/AWS/SQS";
import { Vite } from "alchemy/AWS/Website";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { Processed, SiteApi, VisitCount } from "./api.ts";

/**
 * S3 bucket backing the demo's state (visit counter + the queue
 * consumer's progress). S3 is fully emulated by the local runtime, so
 * `alchemy dev` runs the whole demo offline — no cloud calls, no
 * credentials — while a deploy uses a real bucket.
 */
export const Data = S3.Bucket("Data", {
  forceDestroy: true,
});

/**
 * SQS queue for the async leg: the site's program both produces to it (the
 * `enqueue` endpoint) and CONSUMES it — the program IS a full effect
 * Lambda, so the event-source mapping attaches to the site's own function
 * (no sibling, unlike the framework composites). Like the bucket, the
 * queue and its event delivery are emulated locally under `alchemy dev`.
 */
export const Jobs = SQS.Queue("Jobs", {
  // Lambda event-source polling needs the visibility timeout to cover the
  // consumer function's timeout with headroom.
  visibilityTimeout: "2 minutes",
});

// The HttpApi router never serves files — stub the platform instead of
// dragging a Node HttpPlatform into the Lambda bundle.
const HttpPlatformStub = Layer.succeed(HttpPlatform.HttpPlatform, {
  platform: "web",
  compression: {
    algorithms: new Set<HttpPlatform.CompressionAlgorithm>(),
    compressResponse: (response) => Effect.succeed(response),
  },
  fileResponse: () => Effect.die("HttpPlatform.fileResponse not supported"),
  fileWebResponse: () =>
    Effect.die("HttpPlatform.fileWebResponse not supported"),
});

/**
 * One deployment serves both halves: the Vite build uploads to S3 behind
 * CloudFront, and the Effect program deploys as an effect-native Lambda
 * that the edge router consults FIRST for `server.routes` (default
 * `["/api/*"]`) — a static file can never shadow an API path, even under
 * `spa: true`.
 *
 * The program's non-`fetch` methods are the trusted-caller RPC surface
 * (in-process `createClient(Site)` from server code, AWS invoke-style
 * bindings from sibling functions). The static frontend is untrusted — it
 * talks ONLY through the schema-validated HttpApi mounted on `fetch`.
 */
export default class Site extends Vite<Site>()(
  "Site",
  // Props are an Effect: the optional Route 53 / ACM config resolves
  // through effect/Config at plan time (inert inside the deployed
  // Lambda). Set WEBSITE_DOMAIN / WEBSITE_ZONE_ID (and optionally
  // WEBSITE_ALIASES, comma-separated) before deploying a custom domain.
  Effect.gen(function* () {
    const domainName = yield* Config.string("WEBSITE_DOMAIN").pipe(
      Effect.orElseSucceed(() => undefined),
    );
    const hostedZoneId = yield* Config.string("WEBSITE_ZONE_ID").pipe(
      Effect.orElseSucceed(() => undefined),
    );
    const domainAliases = yield* Config.string("WEBSITE_ALIASES").pipe(
      Effect.map((aliases) =>
        aliases
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean),
      ),
      Effect.orElseSucceed(() => undefined),
    );
    return {
      // The Vite conventions are the defaults: `npx vite build` → dist/,
      // `npx vite dev` under `alchemy dev`, spa fallback on.
      main: import.meta.url,
      invalidation: {
        paths: "all" as const,
      },
      domain:
        domainName !== undefined && hostedZoneId !== undefined
          ? { name: domainName, hostedZoneId, aliases: domainAliases }
          : undefined,
      tags: {
        Example: "aws-vite",
        Surface: "website",
      },
    };
  }),
  Effect.gen(function* () {
    const bucket = yield* Data;
    const getObject = yield* S3.GetObject(bucket);
    const putObject = yield* S3.PutObject(bucket);
    const queue = yield* Jobs;
    const sendMessage = yield* SQS.SendMessage(queue);

    /** Read one key's text content (undefined when the key is unset). */
    const readKey = Effect.fn(function* (key: string) {
      return yield* getObject({ Key: key }).pipe(
        Effect.flatMap((result) =>
          Stream.mkString(Stream.decodeText(result.Body!)),
        ),
        Effect.catchTag("NoSuchKey", () => Effect.succeed(undefined)),
        Effect.orDie,
      );
    });

    /** Write one key's text content. */
    const writeKey = Effect.fn(function* (key: string, value: string) {
      yield* putObject({
        Key: key,
        Body: value,
        ContentType: "text/plain",
      }).pipe(Effect.orDie);
    });

    /** Read the visit counter (0 when unset). */
    const visits = Effect.fn(function* () {
      return Number((yield* readKey("count")) ?? "0");
    });

    /** Increment the counter, persist it, and return the new count. */
    const bump = Effect.fn(function* () {
      const count = (yield* visits()) + 1;
      yield* writeKey("count", String(count));
      return count;
    });

    /** Send a message to the queue; the consumer catches up out of band. */
    const enqueue = Effect.fn(function* (message: string) {
      yield* sendMessage({ MessageBody: message }).pipe(Effect.orDie);
    });

    /** Read the consumer's async state. */
    const processed = Effect.fn(function* () {
      const count = yield* readKey("processed-count");
      const last = yield* readKey("processed-last");
      return { count: Number(count ?? "0"), last: last ?? null };
    });

    // The async leg's CONSUMER — registered on the SAME program, so the
    // event-source mapping targets the site's own Lambda. Each message
    // bumps `processed-count` and records `processed-last` in the bucket,
    // where the `processed` endpoint reads them back.
    yield* SQS.consumeQueueMessages(queue, (records) =>
      records.pipe(
        Stream.runForEach(
          Effect.fn(function* (record) {
            const count = Number((yield* readKey("processed-count")) ?? "0");
            yield* writeKey("processed-count", String(count + 1));
            yield* writeKey("processed-last", record.body);
          }),
        ),
      ),
    );

    // The public API: the shared schema's endpoints, handled by the same
    // effects the trusted RPC surface exposes. Payload validation (the
    // enqueue 400 on an empty message) happens before any handler runs.
    const siteGroup = HttpApiBuilder.group(SiteApi, "Site", (handlers) =>
      handlers
        .handle("visits", () =>
          Effect.map(visits(), (count) => new VisitCount({ count })),
        )
        .handle("bump", () =>
          Effect.map(bump(), (count) => new VisitCount({ count })),
        )
        .handle("enqueue", ({ payload }) =>
          Effect.as(enqueue(payload.message), { enqueued: true }),
        )
        .handle("processed", () =>
          Effect.map(processed(), (state) => new Processed(state)),
        ),
    );

    return {
      // The schema-validated HTTP surface the untrusted frontend calls.
      fetch: HttpApiBuilder.layer(SiteApi).pipe(
        Layer.provide(siteGroup),
        Layer.provide([Etag.layer, HttpPlatformStub, Path.layer]),
        HttpRouter.toHttpEffect,
      ),
      // Trusted-caller RPC methods (in-process value form, invoke bindings).
      visits,
      bump,
      enqueue,
      processed,
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        S3.GetObjectHttp,
        S3.PutObjectHttp,
        SQS.SendMessageHttp,
        QueueEventSource,
      ),
    ),
  ),
) {}
