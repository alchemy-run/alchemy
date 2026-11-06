import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { call } from "./bench.ts";
import ScaleNoneWorker from "./fixtures/scale-none-worker.ts";
import ScaleV1Worker from "./fixtures/scale-v1-worker.ts";
import { MODELS } from "./fixtures/scale.ts";
import { backdatePasses, doBindings, movedBy, namespacesOf, tagsOf, untilListed } from "./move.ts";

/**
 * #2976: a Worker with ten models deployed before Domain versions existed has
 * 61 classes. Upgrading it by renaming each class would list 123 exports (the
 * classes under their new names, and a rename entry for each old one), over
 * Cloudflare's limit of 100. Upgraded straight to the shared class, it keeps
 * each class under its own name while its objects move: 62 exports.
 */

const { test } = Test.make({ providers: Cloudflare.providers() });

const json = <A>(url: string, path: string) =>
  call(url, "GET", path).pipe(Effect.map((body) => JSON.parse(body) as A));
const kinds = ["checking", "savings"] as const;
/** Every model's two accounts, `a-<n>` in each of its aggregates. */
const accounts = Array.from({ length: MODELS }, (_, n) =>
  kinds.map((kind) => ({ n, kind, id: `a-${n}`, owner: `${kind}-${n}` })),
).flat();

const serving = (url: string, version: number | null) =>
  json<{ version: number | null }>(url, "/version").pipe(
    Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 30 }),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (body) => body.version === version,
      times: 60,
    }),
  );

/** Every account reads its owner, in its aggregate and in its view. */
const everyAccountReads = (url: string) =>
  Effect.forEach(
    accounts,
    ({ n, kind, id, owner }) =>
      Effect.gen(function* () {
        expect({ n, kind, state: yield* json(url, `/${n}/${kind}/state/${id}`) }).toEqual({
          n,
          kind,
          state: { owner },
        });
        const view = yield* json<{ owner: string } | null>(url, `/${n}/${kind}/owners/${id}`).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (view) => view?.owner === owner,
            times: 30,
          }),
        );
        expect({ n, kind, view }).toEqual({ n, kind, view: { owner } });
      }),
    { concurrency: 8, discard: true },
  );

test.provider(
  "upgrading ten models deployed before Domain versions stays under Cloudflare's export limit",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { worker } = yield* stack.deploy(
        Effect.gen(function* () {
          return { worker: yield* ScaleNoneWorker };
        }),
      );
      const url = worker.url!.replace(/\/+$/, "");
      const scriptName = worker.workerName;
      yield* serving(url, null);
      yield* Effect.forEach(
        accounts,
        ({ n, kind, id, owner }) => call(url, "POST", `/${n}/${kind}/open/${id}/${owner}`),
        { concurrency: 8, discard: true },
      );
      yield* everyAccountReads(url);
      const legacy = yield* namespacesOf(scriptName);
      // Two aggregates and two views (each with its run class) per model, and one directory.
      expect(Object.keys(legacy).length).toBe(MODELS * 6 + 1);
      yield* untilListed(
        Object.entries(legacy)
          .filter(([cls]) => cls.endsWith("Aggregate"))
          .map(([, id]) => id as string),
        (count) => count > 0,
      );

      yield* stack.deploy(
        Effect.gen(function* () {
          return { worker: yield* ScaleV1Worker };
        }),
      );
      yield* serving(url, 1);
      const upgraded = yield* namespacesOf(scriptName);
      expect(upgraded).toEqual({ ...legacy, AlchemyDomain: upgraded.AlchemyDomain });
      expect(yield* tagsOf(scriptName)).toContain("alchemy:domain:v1");
      // The first model keeps the directory they all had; the others' bindings to it are left out.
      const bindings = yield* doBindings(scriptName);
      expect(bindings["Bank0.DomainDirectory.BeforeVersions"]).toBe("DomainDirectory");
      for (let n = 1; n < MODELS; n++)
        expect(bindings[`Bank${n}.DomainDirectory.BeforeVersions`]).toBeUndefined();
      expect(yield* movedBy(scriptName)).toBeGreaterThanOrEqual(accounts.length);
      yield* everyAccountReads(url);

      // Once the move has settled, an upload deletes every old class. It reads each
      // class's passes from Cloudflare's list of Workflow instances, which can lag
      // behind the migration that recorded them: a class whose pass isn't listed yet
      // is kept, and a later upload deletes it.
      yield* backdatePasses(scriptName, Object.keys(legacy));
      const remaining = yield* stack
        .deploy(
          Effect.gen(function* () {
            return { worker: yield* ScaleV1Worker };
          }),
        )
        .pipe(
          Effect.andThen(doBindings(scriptName)),
          Effect.repeat({
            schedule: Schedule.spaced("30 seconds"),
            until: (bindings) => Object.keys(bindings).length === 1,
            times: 4,
          }),
        );
      expect(remaining).toEqual({ AlchemyDomain: "AlchemyDomain" });
      yield* everyAccountReads(url);
      // And it takes new writes.
      yield* call(url, "POST", `/3/savings/open/b-3/new`);
      expect(yield* json(url, "/3/savings/state/b-3")).toEqual({ owner: "new" });

      yield* stack.destroy();
    }),
  { tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"], timeout: 1_800_000 },
);
