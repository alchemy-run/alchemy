import * as Fly from "@alchemy.run/fly";
import * as GCP from "@alchemy.run/gcp";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";

/** Topic the Fly Service publishes to. */
export const FlyEvents = GCP.PubSub.Topic("FlyFederatedEvents", {});

/**
 * A Fly Service publishing to a GCP topic. Its Machines mint Fly OIDC
 * tokens, so it reaches Pub/Sub by exchanging one for a service account's
 * token, not with a service account key. Deployed from
 * {@link ../GCPBindings.test.ts}.
 */
export default class FlyFederatedService extends Fly.Service<FlyFederatedService>()(
  "FlyFederatedService",
  {
    main: import.meta.url,
    region: "iad",
    port: 3000,
    guest: { cpuKind: "shared", cpus: 1, memoryMb: 256 },
  },
  Effect.gen(function* () {
    const publish = yield* GCP.PubSub.Publish(yield* FlyEvents);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (new URL(request.url, "http://service").pathname === "/identity") {
          // What the Machine holds: a provider to federate through, no key.
          const read = (name: string) =>
            Config.option(Config.String(name)).pipe(
              Effect.map(Option.getOrUndefined),
              Effect.orDie,
            );
          return yield* HttpServerResponse.json({
            audience: yield* read("ALCHEMY_GCP_WORKLOAD_IDENTITY_AUDIENCE"),
            email: yield* read("ALCHEMY_GCP_WORKLOAD_IDENTITY_SERVICE_ACCOUNT"),
            hasKey: (yield* read("ALCHEMY_GCP_SERVICE_ACCOUNT_KEY")) !== undefined,
          });
        }
        return yield* publish({
          body: { messages: [{ data: btoa("hello from fly") }] },
        }).pipe(
          Effect.flatMap((response) => HttpServerResponse.json(response)),
          Effect.catchCause((cause) =>
            HttpServerResponse.json({ error: Cause.pretty(cause) }, { status: 500 }),
          ),
        );
      }),
    };
  }).pipe(Effect.provide(GCP.PubSub.PublishHttp)),
) {}
