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

const remoteUri =
  process.env.GCP_TEST_CLOUDBUILD_REPO ??
  "https://github.com/octocat/Hello-World.git";

const runLifecycle =
  hasGcpCreds && !!process.env.GCP_TEST_CLOUDBUILD_REPO && !process.env.FAST;

test.provider.skipIf(!runLifecycle)(
  "AccessReadToken, AccessReadWriteToken, and FetchGitRefs invoke HTTP bindings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const connection = yield* GCP.CloudBuild.Connection("Github", {
            githubConfig: {},
          });
          const repository = yield* GCP.CloudBuild.Repository("Source", {
            connection: connection.name,
            remoteUri,
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* repository.name;
              const accessReadToken =
                yield* GCP.CloudBuild.AccessReadToken(repository);
              const accessReadWriteToken =
                yield* GCP.CloudBuild.AccessReadWriteToken(repository);
              const fetchGitRefs =
                yield* GCP.CloudBuild.FetchGitRefs(repository);
              return Effect.fn(function* () {
                const read = yield* accessReadToken();
                const write = yield* accessReadWriteToken();
                const refs = yield* fetchGitRefs({ refType: "BRANCH" });
                return { read, write, refs };
              });
            }),
          );
          return yield* Probe({});
        }),
      );

      expect(out.read.token).toEqual(expect.any(String));
      expect(out.write.token).toEqual(expect.any(String));
      expect(Array.isArray(out.refs.refNames ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
