import * as Boat from "@alchemy.run/boat";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as boat from "@distilled.cloud/boat-dev/boat";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { doWork, OtelCollector, waitForWorkSpan, withCollectorUrl } from "../Utils/Telemetry.ts";
import Agent from "./fixtures/program.ts";
import TracedAgent from "./fixtures/traced.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(Boat.providers(), Cloudflare.providers()),
});

const tags = ["provider:boat", "provider:boat:sandbox", "live"];

/** GET a path of the program with its token, retrying while the port warms up. */
const get = (url: string, token: Redacted.Redacted<string> | undefined) =>
  HttpClient.execute(
    HttpClientRequest.get(url).pipe(
      token === undefined
        ? (request) => request
        : HttpClientRequest.setHeader("cookie", `_port_auth=${Redacted.value(token)}`),
    ),
  ).pipe(
    Effect.timeout("20 seconds"),
    Effect.flatMap((res) =>
      res.status === 200
        ? res.json
        : Effect.flatMap(res.text, (text) => Effect.fail(new Error(`${res.status}: ${text}`))),
    ),
    Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 15 }),
  );

const sandboxState = (sandboxId: string) =>
  boat.getSandbox({ sandboxId }).pipe(
    Effect.map((got): string => got.sandbox?.state ?? "gone"),
    Effect.catchTag("NotFound", () => Effect.succeed("gone")),
  );

test.provider(
  "a sandbox that runs an Effect program: deploy, a binding, heal after a stop, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = Effect.gen(function* () {
        return { agent: yield* Agent };
      });

      const first = yield* stack.deploy(program);
      const id = first.agent.sandboxId;
      expect(first.agent.url).toMatch(/^https:\/\/[a-z0-9-]+-3000\.on\.boat\.dev$/);
      expect(first.agent.urlToken).toBeDefined();
      expect(first.agent.program?.port).toEqual(3000);

      const served = (yield* get(first.agent.url!, first.agent.urlToken)) as {
        greeting: string;
        node: string;
      };
      expect(served.greeting).toEqual("hello-from-boat");
      expect(served.node).toMatch(/^v\d+/);
      expect(yield* get(`${first.agent.url}/disk`, first.agent.urlToken)).toEqual({
        marker: "written-by-agent",
      });
      // The program's binding works inside the sandbox, with its own key.
      expect(
        ((yield* get(`${first.agent.url}/sandboxes`, first.agent.urlToken)) as { ids: string[] })
          .ids,
      ).toContain(id);

      // Without the token, the port refuses the request.
      const refused = yield* HttpClient.get(first.agent.url!).pipe(Effect.timeout("20 seconds"));
      expect(refused.status).toBe(403);
      // Its auto-stop is off, so the program keeps serving.
      expect((yield* boat.getSandbox({ sandboxId: id })).sandbox?.ttlSeconds ?? null).toBeNull();

      // Redeploying unchanged leaves the sandbox and the running process alone.
      const again = yield* stack.deploy(program);
      expect(again.agent.sandboxId).toEqual(id);
      expect(again.agent.program?.processId).toEqual(first.agent.program?.processId);

      // Stopping the sandbox ends the process; the next deploy resumes both.
      yield* boat.stopSandbox({ sandboxId: id });
      yield* sandboxState(id).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (state) => state === "archived",
          times: 30,
        }),
      );
      const healed = yield* stack.deploy(program);
      expect(healed.agent.sandboxId).toEqual(id);
      expect(healed.agent.url).toEqual(first.agent.url);
      expect(
        ((yield* get(healed.agent.url!, healed.agent.urlToken)) as { greeting: string }).greeting,
      ).toEqual("hello-from-boat");

      yield* stack.destroy();
      expect(yield* sandboxState(id)).toBe("gone");
    }),
  { tags, timeout: 600_000 },
);

test.provider(
  "a sandbox program exports spans to the bound OTLP destination",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // The traced program binds the collector url at deploy, so it deploys first.
      const collector = yield* stack.deploy(OtelCollector());
      const agent = yield* stack
        .deploy(
          Effect.gen(function* () {
            yield* OtelCollector();
            return yield* TracedAgent;
          }),
        )
        .pipe(withCollectorUrl(collector.url!));

      const cookie = agent.urlToken
        ? { cookie: `_port_auth=${Redacted.value(agent.urlToken)}` }
        : undefined;
      expect(yield* doWork(agent.url!, "boat", cookie)).toBe("did work boat");
      const traces = yield* waitForWorkSpan(collector.url!, "boat");
      expect(traces).toContain("work:boat");
      expect(traces).toContain("boat-sandbox-e2e");

      yield* stack.destroy();
      expect(yield* sandboxState(agent.sandboxId)).toBe("gone");
    }),
  { tags: [...tags, "provider:cloudflare", "provider:cloudflare:worker"], timeout: 600_000 },
);
