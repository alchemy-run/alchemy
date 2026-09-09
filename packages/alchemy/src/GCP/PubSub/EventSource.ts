import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Binding from "../../Binding.ts";
import { safeHttpEffect, type HttpEffect } from "../../Http.ts";
import * as Namespace from "../../Namespace.ts";
import * as Output from "../../Output.ts";
import { RuntimeContext } from "../../RuntimeContext.ts";
import type { HostRuntimeContext } from "../../Server/Process.ts";
import { isGcpHost } from "../Host.ts";
import { Subscription } from "./Subscription.ts";
import type { Topic } from "./Topic.ts";

export const PUBSUB_PUSH_PATH = "/__alchemy/pubsub";

/**
 * One Pub/Sub push message. `type` is the Eventarc-style event type;
 * `value` is the decoded payload.
 */
export class Message<A = string> {
  readonly _tag = "GCP.PubSub.Message";
  readonly type = "google.cloud.pubsub.topic.v1.messagePublished";
  constructor(
    readonly value: A,
    readonly messageId: string,
    readonly attributes: Record<string, string>,
    readonly publishTime: string | undefined,
  ) {}
}

type MessagesHandler<Req> = (
  stream: Stream.Stream<Message<string>>,
) => Effect.Effect<void, unknown, Req>;

const wrappedHosts = new WeakSet<object>();
const handlers = new Map<
  string,
  (message: Message<string>) => Effect.Effect<void, unknown, any>
>();

const decodeJwtAudience = (authorization: string | undefined): string => {
  if (authorization === undefined || !authorization.startsWith("Bearer ")) {
    return "";
  }
  const parts = authorization.slice("Bearer ".length).split(".");
  if (parts.length < 2) return "";
  try {
    const payload = JSON.parse(
      globalThis.atob(parts[1]!.replace(/-/g, "+").replace(/_/g, "/")),
    ) as { aud?: unknown };
    return typeof payload.aud === "string" ? payload.aud : "";
  } catch {
    return "";
  }
};

const pushFetch = (
  fallback: HttpEffect<any> | Effect.Effect<HttpEffect<any>>,
): HttpEffect<any> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    const path = new URL(request.url, "http://alchemy.local").pathname;
    if (path !== PUBSUB_PUSH_PATH) {
      return yield* safeHttpEffect(fallback);
    }
    const authorization = request.headers["authorization"];
    const audience = decodeJwtAudience(
      typeof authorization === "string" ? authorization : undefined,
    );
    if (
      audience.length > 0 &&
      !audience.includes(PUBSUB_PUSH_PATH) &&
      !audience.endsWith(PUBSUB_PUSH_PATH)
    ) {
      return HttpServerResponse.empty({ status: 401 });
    }
    const body = (yield* request.json) as {
      message?: {
        data?: string;
        messageId?: string;
        attributes?: Record<string, string>;
        publishTime?: string;
      };
      subscription?: string;
    };
    const raw = body.message?.data ?? "";
    const value =
      raw.length > 0
        ? globalThis.atob(raw.replace(/-/g, "+").replace(/_/g, "/"))
        : "";
    const message = new Message(
      value,
      body.message?.messageId ?? "",
      body.message?.attributes ?? {},
      body.message?.publishTime,
    );
    const key = body.subscription ?? "";
    const handler = handlers.get(key) ?? [...handlers.values()][0];
    if (handler === undefined) {
      return HttpServerResponse.empty({ status: 204 });
    }
    yield* handler(message).pipe(Effect.orDie);
    return HttpServerResponse.empty({ status: 204 });
  });

const wrapServe = (host: HostRuntimeContext) => {
  if (wrappedHosts.has(host)) return;
  wrappedHosts.add(host);
  const original = host.serve;
  if (original === undefined) return;
  host.serve = ((handler, options) =>
    original(
      pushFetch(handler as HttpEffect<any>),
      options,
    )) as typeof original;
};

/**
 * Subscribe an Effect handler to Pub/Sub push messages on the host
 * Cloud Run Function.
 *
 * Deploy-time yields a {@link Subscription} whose `pushConfig` points at
 * `{function.uri}/__alchemy/pubsub`. Runtime intercepts that path,
 * verifies the OIDC audience, and runs one Effect per message.
 *
 * ### Consuming messages
 * **Example:** Push into a Function
 * ```typescript
 * yield* GCP.PubSub.consumeMessages(topic, (stream) =>
 *   Stream.runForEach(stream, (msg) => Effect.log(msg.value)),
 * );
 * ```
 *
 * @binding
 * @product GCP
 * @category PubSub
 */
export function consumeMessages<Req = never>(
  topic: Topic,
  process: MessagesHandler<Req>,
): Effect.Effect<void, never, EventSource>;
export function consumeMessages<Req = never>(
  topic: Topic,
  process: MessagesHandler<Req>,
): Effect.Effect<void, never, EventSource> {
  return EventSource.use((source) => source(topic, process));
}

export type EventSourceService = (
  topic: Topic,
  process: MessagesHandler<any>,
) => Effect.Effect<void, never, never>;

export class EventSource extends Context.Service<
  EventSource,
  EventSourceService
>()("GCP.PubSub.EventSource") {}

/**
 * Runtime layer for {@link consumeMessages}.
 *
 * @layer
 * @provides GCP.PubSub.EventSource
 */
export const EventSourceLive = Layer.effect(
  EventSource,
  Effect.gen(function* () {
    return Effect.fn(function* (topic: Topic, process: MessagesHandler<any>) {
      const host = yield* Binding.Host;
      if (isGcpHost(host) && "serve" in host) {
        wrapServe(host as unknown as HostRuntimeContext);
      }
      if (!globalThis.__ALCHEMY_RUNTIME__ && isGcpHost(host)) {
        const uri = (host as { uri?: unknown }).uri;
        const serviceAccount = (host as { serviceAccount?: unknown })
          .serviceAccount;
        const endpoint = Output.interpolate`${uri as string}${PUBSUB_PUSH_PATH}`;
        yield* Namespace.push(
          host.LogicalId,
          Subscription(`${topic.LogicalId}Push`, {
            topic: topic.name,
            pushConfig: {
              pushEndpoint: endpoint as unknown as string,
              oidcToken: {
                serviceAccountEmail: serviceAccount as unknown as string,
                audience: endpoint as unknown as string,
              },
            },
          }),
        );
      }
      yield* RuntimeContext;
      const subscriptionName = `${topic.LogicalId}Push`;
      handlers.set(subscriptionName, (message) =>
        process(Stream.make(message)),
      );
    });
  }),
);
