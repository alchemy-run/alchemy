import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import AliasConsumer from "./fixtures/binding-aliases/consumer.ts";
import DefaultConsumer from "./fixtures/binding-aliases/default-consumer.ts";
import AliasTarget from "./fixtures/binding-aliases/target.ts";

const { test } = Test.make({ providers: Cloudflare.providers(), dev: true });

const program = () =>
  Effect.gen(function* () {
    yield* AliasTarget;
    const consumer = yield* AliasConsumer;
    const defaultConsumer = yield* DefaultConsumer;
    return {
      url: consumer.url.as<string>(),
      defaultUrl: defaultConsumer.url.as<string>(),
    };
  });

const actionOf = (
  plan: { resources: Record<string, { action: string; resource: { LogicalId: string } }> },
  id: string,
) => Object.values(plan.resources).find((node) => node.resource.LogicalId === id)?.action;

/** Real local workerd: an explicit env alias must be used without registering an extra binding. */
test.provider(
  "native R2, Queue and Worker clients reuse declared env aliases",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      yield* Effect.gen(function* () {
        const initialPlan = yield* stack.plan(program());
        expect(actionOf(initialPlan, "AliasConsumer")).toBe("create");
        expect(actionOf(initialPlan, "DefaultConsumer")).toBe("create");

        const { url, defaultUrl } = yield* stack.deploy(program());
        const client = yield* HttpClient.HttpClient;
        const request = (base: string, path: string) =>
          client.get(`${base}${path}`).pipe(
            Effect.flatMap((res) =>
              res.status === 200
                ? res.text
                : Effect.fail(new Error(`Worker returned ${res.status}`)),
            ),
            Effect.retry({ times: 8, schedule: Schedule.spaced("500 millis") }),
          );

        expect(yield* request(url, "/r2")).toBe("aliased content:aliased content");
        expect(yield* request(url, "/queue")).toBe("queue sent");
        expect(yield* request(url, "/rpc")).toBe("hello alice from alias target");
        expect(JSON.parse(yield* request(url, "/env"))).toEqual({ aliased: true, extra: [] });

        expect(yield* request(defaultUrl, "/r2")).toBe("default content");
        expect(yield* request(defaultUrl, "/queue")).toBe("default queue sent");
        expect(yield* request(defaultUrl, "/rpc")).toBe("hello bob from alias target");
        expect(JSON.parse(yield* request(defaultUrl, "/env"))).toEqual({
          defaults: true,
          aliased: [],
        });

        const stablePlan = yield* stack.plan(program());
        expect(actionOf(stablePlan, "AliasConsumer")).toBe("noop");
        expect(actionOf(stablePlan, "DefaultConsumer")).toBe("noop");
        expect(actionOf(stablePlan, "AliasTarget")).toBe("noop");

        expect(yield* request(url, "/r2-cleanup")).toBe("alias object deleted");
        expect(yield* request(defaultUrl, "/r2-cleanup")).toBe("default object deleted");
      }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.orDie)));
    }),
  { tags: ["provider:cloudflare", "provider:cloudflare:worker", "local"], timeout: 180_000 },
);
