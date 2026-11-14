import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { getFunctionNamespace } from "@distilled.cloud/digitalocean";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schedule from "effect/Schedule";
import { isGone, logLevel } from "../support.ts";
import EffectFunction, { Fns } from "./fixtures/effect-function.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:functions", "live"];

const retrying = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 20 }));

test.provider(
  "function: an Effect handler and an async handler serve HTTP, redeploy, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const declare = (greeting: string) =>
        Effect.gen(function* () {
          const fns = yield* Fns;
          const ambient = yield* ConfigProvider.ConfigProvider;
          const effectFn = yield* EffectFunction.pipe(
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.orElse(
                ConfigProvider.fromUnknown({ GREETING: "hello from an effect" }),
                ambient,
              ),
            ),
          );
          const asyncFn = yield* DigitalOcean.Functions.Function("AsyncFunction", {
            main: new URL("./fixtures/async-function.ts", import.meta.url).pathname,
            namespace: fns,
            isExternal: true,
            env: { GREETING: greeting },
          });
          return {
            namespaceId: fns.namespaceId,
            effectUrl: effectFn.url,
            asyncUrl: asyncFn.url,
            asyncHash: asyncFn.code.hash,
          };
        });

      const deployed = yield* stack.deploy(declare("hi"));
      const client = yield* HttpClient.HttpClient;
      const ok = (response: { status: number }) =>
        response.status === 200 ? Effect.void : Effect.fail(new Error(`HTTP ${response.status}`));

      const effectBody = (yield* retrying(
        client
          .execute(
            HttpClientRequest.post(`${deployed.effectUrl}/echo`).pipe(
              HttpClientRequest.bodyText("ping", "text/plain"),
            ),
          )
          .pipe(
            Effect.tap(ok),
            Effect.flatMap((r) => r.json),
          ),
      )) as { greeting: string; method: string; path: string; body: string };
      expect(effectBody).toEqual({
        greeting: "hello from an effect",
        method: "POST",
        path: "/echo",
        body: "ping",
      });

      const asyncText = yield* retrying(
        client.get(`${deployed.asyncUrl}/there`).pipe(
          Effect.tap(ok),
          Effect.flatMap((r) => r.text),
        ),
      );
      expect(asyncText).toEqual("hi /there");

      // A new environment value redeploys in place.
      const redeployed = yield* stack.deploy(declare("hey"));
      expect(redeployed.asyncUrl).toEqual(deployed.asyncUrl);
      const after = yield* retrying(
        client.get(`${deployed.asyncUrl}/there`).pipe(
          Effect.tap(ok),
          Effect.flatMap((r) => r.text),
          Effect.filterOrFail(
            (text) => text.startsWith("hey"),
            () => new Error("stale"),
          ),
        ),
      );
      expect(after).toEqual("hey /there");

      yield* stack.destroy();
      expect(yield* isGone(getFunctionNamespace({ namespace_id: deployed.namespaceId }))).toBe(
        true,
      );
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: 600_000 },
);
