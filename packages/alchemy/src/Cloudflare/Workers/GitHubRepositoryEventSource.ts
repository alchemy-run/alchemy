import * as Webhooks from "@distilled.cloud/github/Webhooks";
import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import {
  RepositoryEventSource,
  webhookPath,
  webhookSecretEnvName,
  type RepositoryEventSourceProps,
  type RepositoryEventSourceService,
  type WebhookEvent,
  type WebhookEventName,
} from "../../GitHub/RepositoryEventSource.ts";
import { Webhook } from "../../GitHub/Webhook.ts";
import * as Namespace from "../../Namespace.ts";
import * as Output from "../../Output.ts";
import { isWorkerEvent, Worker } from "./Worker.ts";

/**
 * GitHub event source for Cloudflare Workers.
 *
 * Deploy-time: provisions a {@link Webhook} on the repository whose delivery
 * URL points at this Worker (at a deterministic per-repo path). The webhook
 * secret is bound onto the Worker via an `Output` accessor so the runtime can
 * verify delivery signatures.
 *
 * Runtime: registers a `fetch` listener that claims requests on the
 * repository's delivery path, verifies the `HMAC-SHA256` signature against the
 * bound secret, and forwards each delivery to the subscriber. Requests on any
 * other path fall through to the Worker's own `fetch` handler.
 *
 * @binding
 * @product Workers
 * @category Workers & Compute
 */
export const GitHubRepositoryEventSourceLive = Layer.effect(
  RepositoryEventSource,
  Effect.gen(function* () {
    const ctx = yield* Worker;
    // Loosely-typed constructor — yielding the resource class erases its
    // `GitHub.Providers` requirement. The requirement is satisfied by the
    // stack at plan time.
    const createWebhook = yield* Webhook;

    return Effect.fn(function* (
      props: RepositoryEventSourceProps,
      process: (event: WebhookEvent) => Effect.Effect<void, never, never>,
    ) {
      const path = webhookPath(props);

      // Deploy-time: provision the repository webhook pointing at this Worker.
      // Skipped once running inside the deployed Worker (the global guard).
      // Namespaced under the host so the webhook's logical identity matches the
      // previous Binding.Policy.
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const events = props.events.map((event) =>
          event === "*" ? event : Webhooks.getEventName(event),
        );
        yield* Namespace.push(
          ctx.LogicalId,
          Effect.gen(function* () {
            yield* createWebhook(`${props.owner}/${props.repository}`, {
              owner: props.owner,
              repository: props.repository,
              url: Output.interpolate`${ctx.url}${path}`,
              events: events.includes("*") ? ["*"] : [...new Set(events)],
              secret: props.secret,
              contentType: "json",
            });
          }),
        );
      }

      // Bind the webhook secret as a Worker env accessor under a
      // deterministic key. This single `yield*` does both halves: at plan
      // time it registers a `secret_text` binding (the engine deploys
      // `Redacted` values as Cloudflare secrets), and it returns an Effect
      // that reads the value back from `WorkerEnvironment` at runtime —
      // reconstructing the `Redacted` wrapper. No direct `event.env` access.
      const secret = props.secret
        ? yield* Output.named(
            Output.asOutput(props.secret),
            webhookSecretEnvName(props),
          )
        : undefined;

      yield* ctx.listen((event) => {
        if (!isWorkerEvent(event) || event.type !== "fetch") return;
        const request = event.input as cf.Request;

        let pathname: string;
        try {
          pathname = new URL(request.url).pathname;
        } catch {
          return;
        }
        // Not our delivery path — let the Worker's own handler take it.
        if (pathname !== path) return;

        return handleDelivery(request, secret, props.events, process);
      });
    }) as RepositoryEventSourceService;
  }),
);

const handleDelivery = <Req>(
  request: cf.Request,
  secret: Effect.Effect<Redacted.Redacted<string> | undefined> | undefined,
  events: ReadonlyArray<WebhookEventName>,
  process: (event: WebhookEvent) => Effect.Effect<void, never, Req>,
): Effect.Effect<Response, never, Req> =>
  Effect.gen(function* () {
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }

    const payload = yield* Effect.promise(() => request.text());
    const options = {
      payload,
      name: request.headers.get("x-github-event"),
      id: request.headers.get("x-github-delivery"),
    };
    const delivery = yield* Effect.gen(function* () {
      // Signed subscriptions verify the raw body before any JSON decoding.
      if (secret !== undefined) {
        const signingSecret = yield* secret;
        if (signingSecret === undefined) {
          return new Response("webhook secret missing", { status: 500 });
        }
        yield* Webhooks.verifySignature({
          payload,
          secret: signingSecret,
          signature: request.headers.get("x-hub-signature-256"),
        });
      }
      return yield* Webhooks.parseEvent(options);
    }).pipe(
      Effect.catchTag("GitHubWebhookSignatureError", () =>
        Effect.succeed(new Response("invalid signature", { status: 401 })),
      ),
      Effect.catchTag("GitHubWebhookPayloadParseError", () =>
        Effect.succeed(
          new Response("invalid webhook payload", { status: 400 }),
        ),
      ),
    );
    if (delivery instanceof Response) return delivery;

    // GitHub sends ping deliveries even for subscriptions to specific events.
    // Acknowledge them without passing an unselected event to a narrowed handler.
    if (
      events.some(
        (event) => event === "*" || Webhooks.matchesEvent(delivery, event),
      )
    ) {
      yield* process(delivery).pipe(Effect.orDie);
    }
    return new Response(null, { status: 202 });
  });
