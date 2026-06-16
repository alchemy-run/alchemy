import * as Neon from "@/Neon";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Neon.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Canonical `list()` test (parent fan-out): branches are scoped to a project
// and there is no account-wide branch enumeration API, so `list()` enumerates
// every project and lists+hydrates the branches of each. Deploy a project +
// branch, then assert the deployed branch appears in the exhaustive result.
test.provider("list enumerates the deployed branch", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const { project, branch } = yield* stack.deploy(
      Effect.gen(function* () {
        const project = yield* Neon.Project("ListBranchProject");
        const branch = yield* Neon.Branch("ListBranch", { project });
        return { project, branch };
      }),
    );

    const provider = yield* Provider.findProvider(Neon.Branch);
    const all = yield* provider.list();

    const found = all.find((b) => b.branchId === branch.branchId);
    expect(found).toBeDefined();
    expect(found?.projectId).toEqual(project.projectId);
    expect(found?.branchName).toEqual(branch.branchName);
    expect(found?.connectionUri).toContain("postgres");

    yield* stack.destroy();
  }).pipe(logLevel),
);
