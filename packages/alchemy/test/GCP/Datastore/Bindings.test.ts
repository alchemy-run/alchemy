import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "Commit, Lookup, and RunQuery round-trip",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const index = yield* GCP.Datastore.Indexe("TasksByTitle", {
            ancestor: "NONE",
            properties: [
              { name: "title", direction: "ASCENDING" },
              { name: "created", direction: "DESCENDING" },
            ],
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              const kind = yield* index.kind;
              const project = yield* index.project;
              const commit = yield* GCP.Datastore.Commit(index);
              const lookup = yield* GCP.Datastore.Lookup(index);
              const runQuery = yield* GCP.Datastore.RunQuery(index);
              return Effect.fn(function* () {
                const key = {
                  partitionId: { projectId: yield* project },
                  path: [{ kind: yield* kind, name: "probe" }],
                };
                yield* commit({
                  body: {
                    mode: "NON_TRANSACTIONAL",
                    mutations: [
                      {
                        upsert: {
                          key,
                          properties: {
                            title: { stringValue: "hello" },
                          },
                        },
                      },
                    ],
                  },
                });
                const found = yield* lookup({
                  body: { keys: [key] },
                });
                const page = yield* runQuery({
                  body: { query: { kind: [{ name: yield* kind }] } },
                });
                return { found, page };
              });
            }),
          );
          return yield* Probe({});
        }),
      );

      expect((out.found.found ?? []).length).toBeGreaterThan(0);
      expect(
        out.found.found?.[0]?.entity?.properties?.title?.stringValue,
      ).toEqual("hello");
      expect((out.page.batch?.entityResults ?? []).length).toBeGreaterThan(0);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);
