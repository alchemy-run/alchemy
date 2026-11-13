import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { functionsGetTrigger, getFunctionNamespace } from "@distilled.cloud/digitalocean";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import { isGone, logLevel } from "../support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:functions", "live"];

const code = (greeting: string) =>
  `function main(args) { return { body: "${greeting} " + (args.name || "world") } }`;

const resources = (greeting: string, cron: string) =>
  Effect.gen(function* () {
    const fns = yield* DigitalOcean.Functions.Namespace("Fns", { region: "nyc1" });
    const hello = yield* DigitalOcean.Functions.Action("Hello", {
      namespace: fns,
      runtime: "nodejs:18",
      web: true,
      code: code(greeting),
    });
    const trigger = yield* DigitalOcean.Functions.Trigger("Nightly", {
      namespaceId: fns.namespaceId,
      function: hello.name,
      cron,
      body: { name: "cron" },
    });
    return {
      namespaceId: fns.namespaceId,
      url: hello.url,
      version: hello.version,
      trigger: trigger.name,
    };
  });

const fetchText = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(url);
    if (response.status !== 200) return yield* Effect.fail(new Error(`HTTP ${response.status}`));
    return yield* response.text;
  }).pipe(Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 10 }));

test.provider(
  "namespace, web function and trigger: create, update code in place, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(resources("hello", "0 3 * * *"));
      expect(created.url).toMatch(/^https:\/\/.+\/api\/v1\/web\/fn-/);
      expect(yield* fetchText(`${created.url}?name=alchemy`)).toEqual("hello alchemy");
      const trigger = yield* functionsGetTrigger({
        namespace_id: created.namespaceId,
        trigger_name: created.trigger,
      });
      expect(trigger.trigger.scheduled_details?.cron).toEqual("0 3 * * *");

      // New code and a new schedule update in place.
      const updated = yield* stack.deploy(resources("hi", "0 4 * * *"));
      expect(updated.namespaceId).toEqual(created.namespaceId);
      expect(updated.version).not.toEqual(created.version);
      expect(
        yield* fetchText(`${updated.url}?name=alchemy`).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("3 seconds"),
            until: (t) => t === "hi alchemy",
            times: 10,
          }),
        ),
      ).toEqual("hi alchemy");
      const after = yield* functionsGetTrigger({
        namespace_id: created.namespaceId,
        trigger_name: created.trigger,
      });
      expect(after.trigger.scheduled_details?.cron).toEqual("0 4 * * *");

      // Redeploying unchanged deploys no new version.
      const plan = yield* stack.plan(resources("hi", "0 4 * * *"));
      expect(Object.values(plan.resources).filter((node) => node.action !== "noop")).toEqual([]);

      yield* stack.destroy();
      expect(yield* isGone(getFunctionNamespace({ namespace_id: created.namespaceId }))).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: 300_000 },
);
