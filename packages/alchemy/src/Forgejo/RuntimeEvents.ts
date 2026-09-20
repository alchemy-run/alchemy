import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Semaphore from "effect/Semaphore";
import {
  ConflictingWebhookEndpoint,
  makeWebhookDispatcher,
  reserveWebhookPath,
  type WebhookDispatcher,
} from "../Serverless/Webhook.ts";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Namespace from "../Namespace.ts";
import * as Output from "../Output.ts";
import { Random } from "../Random.ts";
import { RuntimeContext, type BaseRuntimeContext } from "../RuntimeContext.ts";
import type { Repository } from "./Repository.ts";
import {
  IssuesPayload,
  PushPayload,
  type RepositoryEvent,
  type RepositoryEventSourceProps,
} from "./RepositoryEventSource.ts";
import { forgejoBindingId, forgejoSecretOutput } from "./RuntimeHttp.ts";
import { Webhook } from "./Webhook.ts";

export interface ForgejoWebhookReceiver {
  readonly path: string;
  readonly handle: (request: Request) => Effect.Effect<Response>;
}

export const makeForgejoEventSource = (options: {
  host: string;
  url: Output.Output<string | undefined>;
  runtime: BaseRuntimeContext;
  listen: (receiver: ForgejoWebhookReceiver) => Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    const receivers = new Map<
      string,
      {
        secret: RepositoryEventSourceProps["secret"];
        dispatcher: WebhookDispatcher<RepositoryEvent>;
      }
    >();
    return (
      repository: Repository,
      props: RepositoryEventSourceProps,
      handler: (
        event: RepositoryEvent,
      ) => Effect.Effect<void, never, RuntimeContext>,
    ) =>
      lock.withPermit(
        Effect.gen(function* () {
          if (props.events.length === 0)
            return yield* Effect.die(
              "Forgejo.RepositoryEventSource requires at least one event.",
            );
          const selection = [...new Set(props.events)].sort().join(",");
          const id = yield* forgejoBindingId(
            options.host,
            repository,
            `events:${selection}`,
          );
          let receiver = receivers.get(id);
          if (receiver && !Equal.equals(receiver.secret, props.secret)) {
            return yield* Effect.die(
              new ConflictingWebhookEndpoint({
                path: `/__alchemy/forgejo/${id}`,
                message:
                  "Subscriptions to the same Forgejo webhook must use the same signing secret source.",
              }),
            );
          }
          if (!receiver) {
            const dispatcher = yield* makeWebhookDispatcher<RepositoryEvent>();
            const subscription = yield* makeForgejoSubscription(
              options.host,
              options.url,
              repository,
              props,
            );
            yield* reserveWebhookPath(options.runtime, subscription.path);
            yield* options.listen({
              path: subscription.path,
              handle: (request) =>
                subscription.handle(request, dispatcher.dispatch),
            });
            receiver = { secret: props.secret, dispatcher };
            receivers.set(id, receiver);
          }
          yield* receiver.dispatcher.subscribe((event) =>
            handler(event).pipe(
              Effect.provideService(RuntimeContext, options.runtime),
            ),
          );
        }),
      );
  });

const makeForgejoSubscription = (
  host: string,
  url: Output.Output<string | undefined>,
  repository: Repository,
  props: RepositoryEventSourceProps,
) =>
  Effect.gen(function* () {
    if (props.events.length === 0)
      return yield* Effect.die(
        "Forgejo.RepositoryEventSource requires at least one event.",
      );
    const selection = yield* Effect.sync(() =>
      [...new Set(props.events)].sort().join(","),
    );
    const id = yield* forgejoBindingId(host, repository, `events:${selection}`);
    const path = `/__alchemy/forgejo/${id}`;
    const RandomResource = yield* Random;
    // Retain this dependency across managed/external secret transitions.
    const generated = yield* Namespace.set("ForgejoRuntime")(
      RandomResource(`Secret${id}`, { bytes: 32 }),
    );
    const secretOutput = props.secret ?? generated.text;
    const secret = yield* Output.named(
      forgejoSecretOutput(secretOutput),
      `Forgejo${id}WebhookSecret`,
    );
    const repoId = yield* Output.named(
      repository.repoId,
      `Forgejo${id}RepositoryId`,
    );
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      const Hook = yield* Webhook;
      yield* Namespace.set("ForgejoRuntime")(
        Hook(`Webhook${id}`, {
          owner: repository.owner,
          repository: repository.name,
          url: Output.map(url, (value) => {
            if (!value)
              throw new Error(
                "Forgejo.RepositoryEventSource requires a public host URL (enable functionUrl on Lambda).",
              );
            return `${value.replace(/\/$/, "")}${path}`;
          }),
          events: [...props.events],
          secret: secretOutput,
          contentType: "json",
        }),
      );
    }
    return {
      path,
      handle: (
        request: Request,
        handler: (event: RepositoryEvent) => Effect.Effect<Response>,
      ) =>
        handleForgejoDelivery(request, secret, repoId, props.events, handler),
    };
  });

/** WebCrypto verifies HMAC bytes using the platform's constant-time primitive. */
export const verifyForgejoSignature = (
  secret: Redacted.Redacted<string>,
  body: ArrayBuffer,
  signature: string | null,
) =>
  Effect.gen(function* () {
    if (!signature || !/^[a-fA-F0-9]{64}$/.test(signature)) return false;
    const keyBytes = yield* Effect.sync(() =>
      new TextEncoder().encode(Redacted.value(secret)),
    );
    if (keyBytes.length === 0) return false;
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
      Uint8Array.from(signature.match(/../g)!, (byte) =>
        Number.parseInt(byte, 16),
      ),
    );
    return yield* Effect.promise(() =>
      crypto.subtle.verify("HMAC", key, digest, body),
    );
  });

export const handleForgejoDelivery = (
  request: Request,
  secret: Effect.Effect<Redacted.Redacted<string>>,
  repoId: Effect.Effect<number>,
  events: readonly string[],
  handler: (event: RepositoryEvent) => Effect.Effect<Response>,
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    if (request.method !== "POST")
      return new Response("method not allowed", { status: 405 });
    const body = yield* Effect.promise(() => request.arrayBuffer());
    const valid = yield* verifyForgejoSignature(
      yield* secret,
      body,
      request.headers.get("x-forgejo-signature"),
    );
    if (!valid) return new Response("invalid signature", { status: 401 });
    const name = request.headers.get("x-forgejo-event");
    const id = request.headers.get("x-forgejo-delivery");
    if (!id) return new Response("missing delivery id", { status: 400 });
    if (
      !name ||
      !events.includes(name) ||
      (name !== "push" && name !== "issues")
    )
      return new Response("unsupported event", { status: 422 });
    const parsed = yield* Effect.try(
      () => JSON.parse(new TextDecoder().decode(body)) as unknown,
    ).pipe(Effect.option);
    if (parsed._tag === "None")
      return new Response("invalid JSON", { status: 400 });
    const decode: Effect.Effect<RepositoryEvent, Schema.SchemaError> =
      name === "push"
        ? Schema.decodeUnknownEffect(PushPayload)(parsed.value).pipe(
            Effect.map((payload) => ({ id, name: "push" as const, payload })),
          )
        : Schema.decodeUnknownEffect(IssuesPayload)(parsed.value).pipe(
            Effect.map((payload) => ({ id, name: "issues" as const, payload })),
          );
    const event = yield* decode.pipe(Effect.option);
    if (event._tag === "None")
      return new Response("invalid event payload", { status: 400 });
    if (event.value.payload.repository.id !== (yield* repoId))
      return new Response("wrong repository", { status: 403 });
    return yield* handler(event.value);
  });
