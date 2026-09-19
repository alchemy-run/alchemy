import * as machines from "@distilled.cloud/fly-io/machines";
import * as Fly from "@/Fly";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { Api, apiLayer, Site } from "./fixtures/bluegreen-api.ts";

const { test } = Test.make({ providers: Fly.providers() });

test.provider(
  "managed bluegreen preserves traffic and drains a request on the old Machine",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (version: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const app = yield* Site;
            yield* Fly.IpAssignment("Shared", { app, type: "shared_v4" });
            return yield* Api.pipe(Effect.provide(apiLayer(version)));
          }),
        );
      const first = yield* deploy("one");
      const url = `http://${first.appName}.fly.dev`;
      const get = (path: string) =>
        HttpClient.get(`${url}${path}`).pipe(
          Effect.flatMap((response) =>
            response.status === 200
              ? response.text
              : Effect.fail(new Error(`HTTP ${response.status}`)),
          ),
          Effect.timeout("75 seconds"),
        );
      expect(
        yield* get("/").pipe(
          Effect.retry({ times: 8, schedule: Schedule.spaced("1 second") }),
        ),
      ).toBe("one");
      const slow = yield* get("/slow").pipe(Effect.forkScoped);
      expect(
        yield* get("/active").pipe(
          Effect.repeat({
            until: (value) => value === "1",
            times: 8,
            schedule: Schedule.spaced("500 millis"),
          }),
        ),
      ).toBe("1");
      const responses = yield* Ref.make<string[]>([]);
      const finished = yield* Ref.make(false);
      const traffic = yield* get("/").pipe(
        Effect.flatMap((value) =>
          Ref.update(responses, (values) => [...values, value]),
        ),
        Effect.andThen(Ref.get(finished)),
        Effect.repeat({
          until: (done) => done,
          times: 150,
          schedule: Schedule.spaced("500 millis"),
        }),
        Effect.forkScoped,
      );
      const second = yield* deploy("two");
      expect(second.machineId).not.toBe(first.machineId);
      expect(yield* Fiber.join(slow)).toBe("one:drained");
      expect(yield* get("/")).toBe("two");
      yield* Ref.set(finished, true);
      yield* Fiber.join(traffic);
      const observed = yield* Ref.get(responses);
      expect(observed).toContain("one");
      expect(observed).toContain("two");
      expect(
        (yield* machines.listMachines({ app_name: first.appName }))
          .filter((machine) => machine.state !== "destroyed")
          .map((machine) => machine.id),
      ).toEqual([second.machineId]);
      yield* stack.destroy();
    }).pipe(Effect.scoped),
  { timeout: 180_000 },
);
