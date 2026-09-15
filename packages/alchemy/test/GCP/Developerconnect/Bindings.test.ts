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

const cloneUri =
  process.env.GCP_DEVELOPERCONNECT_CLONE_URI ??
  "https://github.com/octocat/Hello-World.git";

test.provider.skipIf(
  !hasGcpCreds ||
    !!process.env.FAST ||
    process.env.GCP_TEST_DEVELOPERCONNECT !== "1",
)(
  "FetchReadToken, FetchReadWriteToken, and FetchGitRefs invoke HTTP bindings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const github = yield* GCP.Developerconnect.Connection("Github", {
            githubConfig: { githubApp: "DEVELOPER_CONNECT" },
          });
          const source =
            yield* GCP.Developerconnect.ConnectionsGitRepositoryLink("Source", {
              connection: github.name,
              cloneUri,
            });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* source.name;
              const fetchReadToken =
                yield* GCP.Developerconnect.FetchReadToken(source);
              const fetchReadWriteToken =
                yield* GCP.Developerconnect.FetchReadWriteToken(source);
              const fetchGitRefs =
                yield* GCP.Developerconnect.FetchGitRefs(source);
              return Effect.fn(function* () {
                const read = yield* fetchReadToken();
                const write = yield* fetchReadWriteToken();
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
