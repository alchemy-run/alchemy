import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Alchemist from "alchemy/Alchemist";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

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
  (stack) =>
    Effect.gen(function* () {
      const environment = yield* yield* CloudflareEnvironment;
      const { accountId } = environment;
      // Never the default store, which every other run on the account uses.
      const name = "lifecycle";
      const worker = "alchemy-state-store-lifecycle";
      const target = { _tag: "Provider", backend: "cloudflare", name } as const;
      const alchemist = Alchemist.layer();
      const defaultStacks = () =>
        Effect.flatMap(
          Alchemist.State.store({ _tag: "Provider", backend: "cloudflare" }).pipe(
            Effect.provide(alchemist),
          ),
          (store) => store.listStacks(),
        );

      const before = yield* defaultStacks();
      yield* stack.destroy();
      yield* Alchemist.State.teardown(target).pipe(Effect.provide(alchemist));

      const created = yield* Alchemist.State.bootstrap(target).pipe(Effect.provide(alchemist));
      expect(created.status).toBe("created");
      expect(yield* scriptExists(accountId, worker)).toBe(true);

      const adopted = yield* Alchemist.State.bootstrap(target).pipe(Effect.provide(alchemist));
      expect(adopted.status).toBe("adopted");

      // Opening the store from a profile with no cached credentials, with a
      // token that can't read Workers scripts, can't tell whether the store
      // exists. It fails instead of bootstrapping over the live store, which
      // would replace its auth token and encryption key.
      const limited = yield* stack.deploy(
        Cloudflare.ApiToken.AccountApiToken("NoWorkersScriptsRead", {
          policies: [
            {
              effect: "allow",
              permissionGroups: ["Account Settings Read"],
              resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
            },
          ],
        }),
      );
      const unknown = `Could not determine whether Cloudflare State Store '${worker}' exists, so it was left untouched`;
      const blind = yield* inCI(
        {
          CLOUDFLARE_API_TOKEN: Redacted.value(limited.value),
          CLOUDFLARE_ACCOUNT_ID: accountId,
          ALCHEMY_PROFILE: `${stack.stage}-no-scripts-read`,
        },
        Effect.exit(
          Alchemist.State.store(target).pipe(
            Effect.flatMap((store) => store.listStacks()),
            Effect.provide(alchemist),
          ),
        ),
      ).pipe(
        // A fresh token can take a few seconds to authenticate.
        Effect.repeat({
          until: (exit) => Exit.isFailure(exit) && Cause.pretty(exit.cause).includes(unknown),
          schedule: Schedule.spaced("5 seconds"),
          times: 6,
        }),
      );
      expect(Exit.isFailure(blind)).toBe(true);
      if (Exit.isFailure(blind)) {
        expect(Cause.pretty(blind.cause)).toContain(unknown);
        expect(Cause.pretty(blind.cause)).toContain("Workers Scripts Read");
      }

      // The named store holds only its own bootstrap stack, and still serves
      // it with the credentials it had.
      const store = yield* Alchemist.State.store(target).pipe(Effect.provide(alchemist));
      expect(yield* store.listStacks()).toEqual(["CloudflareStateStore"]);
      expect(yield* store.listStages("CloudflareStateStore")).toEqual([worker]);

      const torn = yield* Alchemist.State.teardown(target).pipe(Effect.provide(alchemist));
      expect(torn.deleted).toEqual([worker]);
      expect(yield* scriptExists(accountId, worker)).toBe(false);

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
      expect(yield* scriptExists(accountId, worker)).toBe(false);

      // The default store kept serving through all of it.
      expect(yield* scriptExists(accountId, "alchemy-state-store")).toBe(true);
      expect(yield* defaultStacks()).toEqual(before);
      yield* stack.destroy();
    }),
  // Exclusive: sets `CI` on the process.
  {
    tags: ["provider:cloudflare", "provider:cloudflare:statestore", "live"],
    timeout: 300_000,
    exclusive: true,
  },
);
