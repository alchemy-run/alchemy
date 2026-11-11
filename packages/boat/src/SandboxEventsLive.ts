import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { WebhookHost } from "alchemy/WebhookHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { bindBoat, bindOwnerLabels } from "./BoatBindings.ts";
import { asSecret, handleDelivery } from "./internal/WebhookDelivery.ts";
import {
  type SandboxEvent,
  SandboxEvents,
  type SandboxEventsProps,
  type SandboxEventsService,
  sandboxEventsPath,
  sandboxEventsSecretEnvName,
} from "./SandboxEvents.ts";
import { ALL_SANDBOX_EVENTS, Webhook } from "./Webhook.ts";

/**
 * {@link SandboxEvents} on any {@link WebhookHost}: every Cloudflare Worker
 * is one.
 *
 * @layer
 * @product Webhook
 * @provides Boat.SandboxEvents
 */
export const SandboxEventsLive = Layer.effect(
  SandboxEvents,
  Effect.gen(function* () {
    const host = yield* WebhookHost;
    // Yielding the resource class erases its `Providers` requirement; the
    // stack satisfies it at plan time.
    const createWebhook = yield* Webhook;

    return Effect.fn(function* (
      props: SandboxEventsProps,
      process: (event: SandboxEvent) => Effect.Effect<void, never, any>,
    ) {
      const path = sandboxEventsPath(props);

      // Boat generates the signing secret. It goes to the host as a binding,
      // not a prop: the webhook depends on the host's URL.
      const runtime = yield* RuntimeContext;
      const secretKey = sandboxEventsSecretEnvName(path);
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* Namespace.push(
          host.LogicalId,
          Effect.gen(function* () {
            // Boat delivers only to public HTTPS URLs, and under `alchemy dev`
            // the host is on localhost: skip the webhook rather than fail.
            const context = yield* Effect.serviceOption(AlchemyContext);
            if (Option.isSome(context) && context.value.dev) {
              yield* Effect.logWarning(
                `Boat.consumeSandboxEvents: no webhook for ${path} under alchemy dev; Boat only delivers to public URLs, so deploy to receive events.`,
              );
              return;
            }
            const hook = yield* createWebhook(`BoatEvents${path}`, {
              url: Output.interpolate`${host.url}${path}`,
              events: [...(props.events ?? ALL_SANDBOX_EVENTS)],
            });
            yield* host.bind(`boat-webhook:${path}`, { env: { [secretKey]: hook.secret } });
          }),
        );
      }
      const boundSecret = Effect.map(runtime.get<unknown>(secretKey), asSecret);

      // Scoped to the stack: the host reads each sandbox's labels with a
      // key that may only read sandboxes.
      const scope =
        (props.scope ?? "stack") === "stack"
          ? {
              auth: yield* bindBoat("BoatEventsKey", "BOAT_EVENTS_KEY", {
                actions: ["sandbox.read"],
              }),
              owner: yield* bindOwnerLabels,
            }
          : undefined;

      const types = new Set<string>(props.events ?? ALL_SANDBOX_EVENTS);
      yield* host.route(path, (request) =>
        handleDelivery(request, boundSecret, types, scope, process),
      );
    }) as SandboxEventsService;
  }),
);
