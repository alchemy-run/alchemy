import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import * as domains from "@distilled.cloud/vercel/domains";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Vercel.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const teamScope = Effect.gen(function* () {
  const { teamId } = yield* Vercel.VercelEnvironment.current;
  return teamId !== undefined ? { teamId } : {};
});

/** Out-of-band read of a domain via distilled. */
const getDomain = (name: string) =>
  Effect.gen(function* () {
    const team = yield* teamScope;
    return yield* domains.getDomain({ domain: name, ...team }).pipe(
      Effect.map((res) => res.domain as typeof res.domain | undefined),
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    );
  });

/** Typed wait-until-gone (bounded). */
const expectDomainGone = (name: string) =>
  Effect.gen(function* () {
    const gone = yield* getDomain(name).pipe(
      Effect.map((d) =>
        d === undefined ? ("gone" as const) : ("found" as const),
      ),
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (s) => s === "gone",
        times: 10,
      }),
    );
    expect(gone).toEqual("gone");
  });

test.provider(
  "domain lifecycle: add, observe, idempotent redeploy, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const NAME = "alchemy-vercel-test-crud.example";

      const created = yield* stack.deploy(
        Vercel.Domain("Apex", { name: NAME }),
      );
      expect(created.name).toEqual(NAME);
      expect(created.domainId.length).toBeGreaterThan(0);
      expect(created.verified).toEqual(true);

      // Out-of-band verification via distilled.
      const observed = yield* getDomain(NAME);
      expect(observed).toBeDefined();
      expect(observed!.name).toEqual(NAME);
      expect(observed!.id).toEqual(created.domainId);

      // Redeploying the same props converges without churn.
      const noop = yield* stack.deploy(Vercel.Domain("Apex", { name: NAME }));
      expect(noop.domainId).toEqual(created.domainId);
      expect(noop.name).toEqual(NAME);

      // list() enumerates the deployed domain.
      const provider = yield* Provider.findProvider(Vercel.Domain);
      const all = yield* provider.list();
      expect(all.find((d) => d.name === NAME)).toBeDefined();

      yield* stack.destroy();
      yield* expectDomainGone(NAME);

      // Destroy again — delete path is idempotent.
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "replaces the domain when the name changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const NAME_A = "alchemy-vercel-test-repl-a.example";
      const NAME_B = "alchemy-vercel-test-repl-b.example";

      const created = yield* stack.deploy(
        Vercel.Domain("Apex", { name: NAME_A }),
      );
      expect(created.name).toEqual(NAME_A);

      const replaced = yield* stack.deploy(
        Vercel.Domain("Apex", { name: NAME_B }),
      );
      expect(replaced.name).toEqual(NAME_B);
      expect(replaced.domainId).not.toEqual(created.domainId);

      // The new domain exists; the old generation was deleted.
      const observedB = yield* getDomain(NAME_B);
      expect(observedB).toBeDefined();
      yield* expectDomainGone(NAME_A);

      yield* stack.destroy();
      yield* expectDomainGone(NAME_B);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
