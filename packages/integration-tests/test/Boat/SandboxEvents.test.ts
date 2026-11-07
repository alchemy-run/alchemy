import * as Boat from "@alchemy.run/boat";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as boat from "@distilled.cloud/boat-dev/boat";
import * as Alchemy from "alchemy";
import { localState } from "alchemy/State";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import BoatEventsWorker, { EVENTS_PATH } from "./fixtures/events-worker.ts";

const providers = Layer.mergeAll(Boat.providers(), Cloudflare.providers());
const { test, deploy, destroy } = Test.make({ providers });

interface Seen {
  ready: boolean;
  archived: boolean;
  labelled: boolean;
}

/** Another stack's sandbox: its events reach the account's webhooks too. */
const ForeignStack = Alchemy.Stack(
  "BoatEventsForeign",
  { providers: Boat.providers(), state: localState() },
  Effect.gen(function* () {
    const box = yield* Boat.Sandbox("ForeignBox", {
      type: "small",
      noEnv: true,
      autoStop: "10 minutes",
    });
    return { sandboxId: box.sandboxId };
  }),
);

test.provider(
  "a Worker receives verified events for its stack's sandboxes, drops other stacks', rejects unsigned ones, and its webhook goes on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { url, secretNames } = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* BoatEventsWorker;
          return { url: worker.url.as<string>(), secretNames: worker.secretNames };
        }),
      );
      const deliveryUrl = `${url}${EVENTS_PATH}`;
      // The signing secret and the Worker's Boat key deploy as Cloudflare secrets.
      expect(secretNames).toContain(Boat.sandboxEventsSecretEnvName(EVENTS_PATH));
      expect(secretNames).toContain("BOAT_EVENTS_KEY");
      const hook = (yield* boat.listWebhooks({})).webhooks.find((h) => h.url === deliveryUrl);
      expect([...(hook?.events ?? [])].sort()).toEqual(["sandbox.archived", "sandbox.ready"]);

      // A fresh workers.dev URL answers 404, then briefly 5xx, until it propagates.
      const client = HttpClient.filterStatus(
        yield* HttpClient.HttpClient,
        (status) => status !== 404 && status < 500,
      );
      const retried = Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 8 });

      // An unsigned delivery is rejected before the handler runs.
      const now = yield* Clock.currentTimeMillis;
      const forged = yield* client
        .execute(
          HttpClientRequest.post(deliveryUrl).pipe(
            HttpClientRequest.setHeaders({
              "x-ascii-delivery": "evt_forged",
              "x-ascii-timestamp": String(Math.floor(Number(now) / 1000)),
              "x-ascii-signature": `v1=${"0".repeat(64)}`,
            }),
            HttpClientRequest.bodyJsonUnsafe({
              id: "evt_forged",
              type: "sandbox.ready",
              data: { sandbox: { id: "bx_forged" } },
            }),
          ),
        )
        .pipe(retried);
      expect(forged.status).toBe(401);

      const seenOf = (sandboxId: string) =>
        client.get(`${url}/?sandbox=${sandboxId}`).pipe(
          retried,
          Effect.flatMap((res) => res.json),
          Effect.map((body) => body as unknown as Seen),
        );

      // Another stack's sandbox starts while the webhook exists.
      const foreign = yield* deploy(ForeignStack);

      // The Worker's own sandbox starts and stops; both events reach the handler.
      const { sandboxId } = (yield* client.post(`${url}/lifecycle`).pipe(
        retried,
        Effect.flatMap((res) => res.json),
      )) as { sandboxId: string };
      const seen = yield* seenOf(sandboxId).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("3 seconds"),
          until: (body) => body.ready && body.archived,
          times: 20,
        }),
      );
      expect(seen).toEqual({ ready: true, archived: true, labelled: true });

      // The other stack's sandbox never reached the handler.
      expect(yield* seenOf(foreign.sandboxId)).toEqual({
        ready: false,
        archived: false,
        labelled: false,
      });

      yield* client.post(`${url}/delete?sandbox=${sandboxId}`).pipe(retried);
      yield* destroy(ForeignStack);
      yield* stack.destroy();
      const after = (yield* boat.listWebhooks({})).webhooks;
      expect(after.some((h) => h.url === deliveryUrl)).toBe(false);
    }),
  {
    tags: ["provider:boat", "provider:boat:webhook", "provider:cloudflare", "live"],
    timeout: 600_000,
  },
);
