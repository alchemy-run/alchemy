import * as workers from "@distilled.cloud/cloudflare/workers";
import { expect } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Alchemist from "@/Alchemist/index.ts";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment.ts";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";

const { test } = Test.make({ providers: Cloudflare.providers() });

/** Run with `CI` and the given env set, as a CI deploy would. */
const inCI = <A, E, R>(env: Readonly<Record<string, string>>, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const vars = { CI: "true", ...env };
      const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
      Object.assign(process.env, vars);
      return previous;
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }),
  );

const scriptExists = (accountId: string, scriptName: string) =>
  workers.getScriptSetting({ accountId, scriptName }).pipe(
    Effect.as(true),
    Effect.catchTag(["WorkerNotFound", "InvalidRoute", "WorkerHasNoVersions"], () =>
      Effect.succeed(false),
    ),
  );

test.provider(
  "a named Cloudflare state store bootstraps, serves state and tears down beside the default",
  () =>
    Effect.gen(function* () {
      const environment = yield* yield* CloudflareEnvironment;
      const { accountId } = environment;
      // Never the default store, which every other run on the account uses.
      const name = "alchemy-state-store-lifecycle";
      const target = { backend: "cloudflare", name };
      const alchemist = Alchemist.layer();
      const defaultStacks = () =>
        Effect.flatMap(
          Alchemist.State.store({ backend: "cloudflare" }).pipe(Effect.provide(alchemist)),
          (store) => store.listStacks(),
        );

      const before = yield* defaultStacks();
      yield* Alchemist.State.teardown(target).pipe(Effect.provide(alchemist));

      const created = yield* Alchemist.State.bootstrap(target).pipe(Effect.provide(alchemist));
      expect(created.status).toBe("created");
      expect(yield* scriptExists(accountId, name)).toBe(true);

      const adopted = yield* Alchemist.State.bootstrap(target).pipe(Effect.provide(alchemist));
      expect(adopted.status).toBe("adopted");

      // The named store holds only its own bootstrap stack.
      const store = yield* Alchemist.State.store(target).pipe(Effect.provide(alchemist));
      expect(yield* store.listStacks()).toEqual(["CloudflareStateStore"]);
      expect(yield* store.listStages("CloudflareStateStore")).toEqual([name]);

      const torn = yield* Alchemist.State.teardown(target).pipe(Effect.provide(alchemist));
      expect(torn.deleted).toEqual([name]);
      expect(yield* scriptExists(accountId, name)).toBe(false);

      // In CI, a missing store fails instead of being deployed on first use.
      // CI reads Cloudflare credentials from the environment only. The
      // deleted Worker's workers.dev URL can keep serving for a few seconds,
      // so retry until the edge reports it gone.
      expect(environment.type).toBe("apiToken");
      const expected = `Run 'alchemy state bootstrap --backend cloudflare --name ${name}`;
      const inCi = yield* inCI(
        environment.type === "apiToken"
          ? {
              CLOUDFLARE_API_TOKEN: Redacted.value(environment.apiToken),
              CLOUDFLARE_ACCOUNT_ID: accountId,
            }
          : {},
        Effect.exit(
          Alchemist.State.store(target).pipe(
            Effect.flatMap((store) => store.listStacks()),
            Effect.provide(alchemist),
          ),
        ),
      ).pipe(
        Effect.repeat({
          until: (exit) => Exit.isFailure(exit) && Cause.pretty(exit.cause).includes(expected),
          schedule: Schedule.spaced("5 seconds"),
          times: 12,
        }),
      );
      expect(Exit.isFailure(inCi)).toBe(true);
      if (Exit.isFailure(inCi)) expect(Cause.pretty(inCi.cause)).toContain(expected);
      expect(yield* scriptExists(accountId, name)).toBe(false);

      // The default store kept serving through all of it.
      expect(yield* scriptExists(accountId, "alchemy-state-store")).toBe(true);
      expect(yield* defaultStacks()).toEqual(before);
    }),
  // Exclusive: sets `CI` on the process.
  { timeout: 300_000, exclusive: true },
);
