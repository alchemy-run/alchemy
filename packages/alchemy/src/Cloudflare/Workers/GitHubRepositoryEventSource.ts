import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Semaphore from "effect/Semaphore";
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
import {
  ConflictingWebhookEndpoint,
  makeWebhookDispatcher,
  reserveWebhookPath,
  type WebhookDispatcher,
} from "../../Serverless/Webhook.ts";
import { isWorkerEvent, Worker } from "./Worker.ts";

/**
 * GitHub event source for Cloudflare Workers.
 *
 * Subscriptions to one repository endpoint share its webhook, signing secret,
 * and request decoder. All matching subscribers must succeed within 30 seconds
 * before the delivery is acknowledged. Failures return 503; retried deliveries
 * may repeat successful subscribers, so handlers must be idempotent.
 * Requests on other paths fall through to the Worker's application handler.
 *
 * @binding
 * @product Workers
 * @category Workers & Compute
 */
export const GitHubRepositoryEventSourceLive = Layer.effect(
  RepositoryEventSource,
  Effect.gen(function* () {
    const ctx = yield* Worker;
    const createWebhook = yield* Webhook;
    const lock = yield* Semaphore.make(1);
    const receivers = new Map<
      string,
      {
        props: RepositoryEventSourceProps;
        events: Set<WebhookEventName>;
        dispatcher: WebhookDispatcher<WebhookEvent>;
      }
    >();

    const subscribe = Effect.fn(function* (
      props: RepositoryEventSourceProps,
      process: (event: WebhookEvent) => Effect.Effect<void>,
    ) {
      const path = webhookPath(props);
      let receiver = receivers.get(path);
      if (
        receiver &&
        (receiver.props.owner !== props.owner ||
          receiver.props.repository !== props.repository ||
          !Equal.equals(receiver.props.secret, props.secret))
      ) {
        return yield* Effect.die(
          new ConflictingWebhookEndpoint({
            path,
            message:
              "Subscriptions to one GitHub endpoint must use the same repository and signing secret.",
          }),
        );
      }
      if (!receiver) {
        yield* reserveWebhookPath(ctx, path);
        const events = new Set<WebhookEventName>();
        const dispatcher = yield* makeWebhookDispatcher<WebhookEvent>();
        if (!globalThis.__ALCHEMY_RUNTIME__) {
          yield* Namespace.push(
            ctx.LogicalId,
            Effect.gen(function* () {
              yield* createWebhook(`${props.owner}/${props.repository}`, {
                owner: props.owner,
                repository: props.repository,
                url: Output.interpolate`${ctx.url}${path}`,
                events: Effect.sync(() =>
                  events.has("*") ? ["*"] : [...events].sort(),
                ),
                secret: props.secret,
                contentType: "json",
              });
            }),
          );
        }
        const secret = props.secret
          ? yield* Output.named(
              Output.asOutput(props.secret),
              webhookSecretEnvName(props),
            )
          : undefined;
        yield* ctx.listen((event) => {
          if (!isWorkerEvent(event) || event.type !== "fetch") return;
          const request = event.input as cf.Request;
          if (new URL(request.url).pathname !== path) return;
          return handleGitHubDelivery(request, secret, dispatcher.dispatch);
        });
        receiver = { props, events, dispatcher };
        receivers.set(path, receiver);
      }
      const selection = props.events ?? ["push"];
      for (const event of selection) receiver.events.add(event);
      yield* receiver.dispatcher.subscribe((event) =>
        selection.includes("*") || selection.some((name) => name === event.name)
          ? process(event)
          : Effect.void,
      );
    });
    return ((
      props: RepositoryEventSourceProps,
      process: (event: WebhookEvent) => Effect.Effect<void>,
    ) =>
      lock.withPermit(
        subscribe(props, process),
      )) as RepositoryEventSourceService;
  }),
);

const handleGitHubDelivery = (
  request: cf.Request,
  secret: Effect.Effect<Redacted.Redacted<string> | undefined> | undefined,
  process: (event: WebhookEvent) => Effect.Effect<Response>,
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    if (request.method !== "POST")
      return new Response("method not allowed", { status: 405 });
    const body = yield* Effect.promise(() =>
      (request as unknown as Request).text(),
    );
    if (secret !== undefined) {
      const resolved = yield* secret;
      if (
        !resolved ||
        !(yield* verifySignature(
          Redacted.value(resolved),
          body,
          request.headers.get("x-hub-signature-256"),
        ))
      ) {
        return new Response("invalid signature", { status: 401 });
      }
    }
    const name = request.headers.get("x-github-event") ?? "unknown";
    const id = request.headers.get("x-github-delivery") ?? "";
    const payload = yield* Effect.try(() => JSON.parse(body) as unknown).pipe(
      Effect.catch(() => Effect.succeed(body)),
    );
    const delivery = { id, name, payload } as unknown as WebhookEvent;
    return yield* process(delivery);
  });

const verifySignature = (
  secret: string,
  body: string,
  signature: string | null,
) =>
  Effect.gen(function* () {
    if (!secret || !signature || !/^sha256=[a-fA-F0-9]{64}$/.test(signature))
      return false;
    const keyBytes = yield* Effect.sync(() => new TextEncoder().encode(secret));
    const bodyBytes = yield* Effect.sync(() => new TextEncoder().encode(body));
    const key = yield* Effect.promise(() =>
      crypto.subtle.importKey(
        "raw",
        keyBytes,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      ),
    );
    const digest = yield* Effect.sync(() =>
      Uint8Array.from(signature.slice(7).match(/../g)!, (byte) =>
        Number.parseInt(byte, 16),
      ),
    );
    return yield* Effect.promise(() =>
      crypto.subtle.verify("HMAC", key, digest, bodyBytes),
    );
  });
