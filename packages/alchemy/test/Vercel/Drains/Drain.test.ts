import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import * as drains from "@distilled.cloud/vercel/drains";
import * as projects from "@distilled.cloud/vercel/projects";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Vercel.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const teamScope = Effect.gen(function* () {
  const { teamId } = yield* Vercel.VercelEnvironment.current;
  return teamId !== undefined ? { teamId } : {};
});

/** Out-of-band read via distilled; `undefined` = drain does not exist. */
const getDrain = (id: string) =>
  Effect.gen(function* () {
    const team = yield* teamScope;
    return yield* drains.getDrain({ id, ...team }).pipe(
      Effect.map((drain): drains.GetDrainResponse | undefined => drain),
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    );
  });

test.provider("drain lifecycle: create, no-op redeploy, destroy", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const props: Vercel.DrainProps = {
      schemas: { log: { version: "v1" } },
      delivery: {
        type: "http",
        // Vercel validates the endpoint URL (must resolve) but does not
        // verify delivery, so a well-known host works as a sink.
        endpoint: "https://example.com/alchemy/drain-lifecycle",
        encoding: "json",
      },
    };

    const created = yield* stack.deploy(Vercel.Drain("Logs", props));

    expect(created.drainId).toMatch(/^drn_/);
    // Engine-generated deterministic physical name.
    expect(created.drainName.length).toBeGreaterThan(0);
    expect(created.status).toEqual("enabled");
    expect(created.ownerId).toBeDefined();
    expect(created.projectIds).toBeUndefined();

    // Out-of-band verification via distilled.
    const fetched = yield* getDrain(created.drainId);
    expect(fetched).toBeDefined();
    expect(fetched!.name).toEqual(created.drainName);
    expect(fetched!.source).toMatchObject({ kind: "self-served" });
    expect(fetched!.delivery).toMatchObject({
      type: "http",
      endpoint: "https://example.com/alchemy/drain-lifecycle",
      encoding: "json",
    });
    expect(fetched!.filterV2).toBeUndefined();

    // Same props again is a true no-op: same id AND untouched updatedAt
    // (a PATCH would bump it).
    const noop = yield* stack.deploy(Vercel.Drain("Logs", props));
    expect(noop.drainId).toEqual(created.drainId);
    expect(noop.drainName).toEqual(created.drainName);
    expect(noop.updatedAt).toEqual(created.updatedAt);

    yield* stack.destroy();
    expect(yield* getDrain(created.drainId)).toBeUndefined();

    // Destroy again — delete path is idempotent.
    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider(
  "update in place: filter, sampling, delivery, and status deltas",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Vercel.Drain("Updating", {
          name: "alchemy-test-drain-update",
          schemas: { log: { version: "v1" } },
          filter: { type: "basic", log: { sources: ["lambda"] } },
          sampling: [{ rate: 0.5 }],
          delivery: {
            type: "http",
            endpoint: "https://example.com/alchemy/drain-update",
            encoding: "json",
          },
        }),
      );

      expect(created.drainName).toEqual("alchemy-test-drain-update");
      const before = yield* getDrain(created.drainId);
      expect(before!.filterV2?.filter).toMatchObject({
        type: "basic",
        log: { sources: ["lambda"] },
      });
      expect(before!.sampling).toMatchObject([
        { type: "head_sampling", rate: 0.5 },
      ]);

      // Widen the filter, drop sampling, switch encoding, pause the drain —
      // all PATCH deltas on the same drain (no replacement).
      const updated = yield* stack.deploy(
        Vercel.Drain("Updating", {
          name: "alchemy-test-drain-update",
          schemas: { log: { version: "v1" } },
          filter: { type: "basic", log: { sources: ["lambda", "edge"] } },
          delivery: {
            type: "http",
            endpoint: "https://example.com/alchemy/drain-update",
            encoding: "ndjson",
          },
          status: "disabled",
        }),
      );

      expect(updated.drainId).toEqual(created.drainId);
      expect(updated.status).toEqual("disabled");

      const after = yield* getDrain(created.drainId);
      expect(after!.filterV2?.filter).toMatchObject({
        type: "basic",
        log: { sources: ["lambda", "edge"] },
      });
      expect(after!.sampling ?? []).toEqual([]);
      expect(after!.delivery).toMatchObject({
        type: "http",
        encoding: "ndjson",
      });
      expect(after!.status).toEqual("disabled");

      yield* stack.destroy();
      expect(yield* getDrain(created.drainId)).toBeUndefined();
    }).pipe(logLevel),
);

test.provider("drain scoped to a specific project", (stack) =>
  Effect.gen(function* () {
    // Host project created out-of-band via distilled (deterministic name so
    // an interrupted run reuses it); removed again in `ensuring` below.
    const hostName = "alchemy-test-drain-host";
    const team = yield* teamScope;
    const host = yield* projects
      .createProject({ name: hostName, ...team })
      .pipe(
        Effect.map((p) => ({ id: p.id })),
        Effect.catchTag("Conflict", () =>
          projects
            .getProject({ idOrName: hostName, ...team })
            .pipe(Effect.map((p) => ({ id: p.id }))),
        ),
      );

    yield* Effect.gen(function* () {
      yield* stack.destroy();

      const scoped = yield* stack.deploy(
        Vercel.Drain("Scoped", {
          projects: "some",
          projectIds: [host.id],
          schemas: { log: { version: "v1" } },
          delivery: {
            type: "http",
            endpoint: "https://example.com/alchemy/drain-scoped",
            encoding: "json",
          },
        }),
      );

      expect(scoped.projectIds).toEqual([host.id]);
      const fetched = yield* getDrain(scoped.drainId);
      expect([...(fetched!.projectIds ?? [])]).toEqual([host.id]);

      // Back to all projects — PATCH { projects: "all", projectIds: null }.
      const widened = yield* stack.deploy(
        Vercel.Drain("Scoped", {
          schemas: { log: { version: "v1" } },
          delivery: {
            type: "http",
            endpoint: "https://example.com/alchemy/drain-scoped",
            encoding: "json",
          },
        }),
      );
      expect(widened.drainId).toEqual(scoped.drainId);
      expect(widened.projectIds ?? []).toEqual([]);

      yield* stack.destroy();
      expect(yield* getDrain(scoped.drainId)).toBeUndefined();
    }).pipe(
      Effect.ensuring(
        projects
          .deleteProject({ idOrName: host.id, ...team })
          .pipe(Effect.ignore),
      ),
    );
  }).pipe(logLevel),
);
