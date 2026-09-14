import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Path from "node:path";
class RegistryPending extends Data.TaggedError("RegistryPending") {}
const { test } = Test.make({ providers: Cloudflare.providers(), dev: true });
const main = Path.resolve(import.meta.dirname, "fixtures/local-dispatch.ts");
test.provider(
  "local dispatch routes by namespace and observes user-worker updates and removal",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const program = (value = "first", include = true) =>
        Effect.gen(function* () {
          const first = yield* Cloudflare.WorkersForPlatforms.DispatchNamespace(
            "First",
            {},
          );
          const second =
            yield* Cloudflare.WorkersForPlatforms.DispatchNamespace(
              "Second",
              {},
            );
          const user = include
            ? yield* Cloudflare.Worker("FirstUser", {
                name: "local-dispatch-customer",
                namespace: first,
                main,
                env: { VALUE: value },
              })
            : undefined;
          yield* Cloudflare.Worker("SecondUser", {
            name: "local-dispatch-customer",
            namespace: second.name,
            main,
            env: { VALUE: "second" },
          });
          const caller = yield* Cloudflare.Worker("Caller", {
            main,
            env: { DISPATCH: first },
          });
          const other = yield* Cloudflare.Worker("OtherCaller", {
            main,
            env: { DISPATCH: second },
          });
          return { first, second, user, caller, other };
        });
      let deployed = yield* stack.deploy(program());
      expect(deployed.first.name).toMatch(/^dev:/);
      expect(deployed.user!.namespace).toBe(deployed.first.name);
      const call = (url: string, name = "local-dispatch-customer") =>
        Effect.promise(async () => {
          const response = await fetch(`${url}?worker=${name}`, {
            method: "POST",
            body: "hello",
          });
          return {
            status: response.status,
            body: (await response.json()) as any,
          };
        });
      const wait = (url: string, value: string | undefined) =>
        call(url).pipe(
          Effect.flatMap((result) =>
            (
              value === undefined
                ? result.status === 404 &&
                  result.body.error?.includes("Worker not found")
                : result.body.value === value
            )
              ? Effect.succeed(result)
              : Effect.fail(new RegistryPending()),
          ),
          Effect.retry({ times: 8, schedule: Schedule.spaced("250 millis") }),
        );
      expect((yield* wait(deployed.caller.url!, "first")).body).toEqual({
        value: "first",
        body: "hello",
        internalHeader: false,
      });
      expect((yield* wait(deployed.other.url!, "second")).body.value).toBe(
        "second",
      );
      expect((yield* call(deployed.caller.url!, "missing")).status).toBe(404);
      const original = deployed.first.name;
      deployed = yield* stack.deploy(program("updated"));
      expect(deployed.first.name).toBe(original);
      expect((yield* wait(deployed.caller.url!, "updated")).body.value).toBe(
        "updated",
      );
      deployed = yield* stack.deploy(program("updated", false));
      expect(
        (yield* wait(deployed.caller.url!, undefined)).body.error,
      ).toContain("Worker not found");
      expect((yield* wait(deployed.other.url!, "second")).body.value).toBe(
        "second",
      );
      yield* stack.destroy();
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);
