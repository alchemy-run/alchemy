import {
  getBranch,
  getDatabase,
  getProject,
  getProjectBranches,
  getProjectDatabases,
  updateDatabase,
} from "@distilled.cloud/prisma/management";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { adopt, OwnedBySomeoneElse } from "@/AdoptPolicy";
import * as Prisma from "@/Prisma";
import * as Test from "@/Test/Alchemy";
import { failureOf, forgetState, markCreating, patchStateAttr } from "./fixtures/Live.ts";
import { fakeCloudProviders, makeFakeCloud } from "./fixtures/ResourcesFake.ts";

const { test } = Test.make({ providers: Prisma.providers() });

const expectDatabase = Effect.fn(function* (
  database: Prisma.Database["Attributes"],
  branchId: string,
) {
  const observed = yield* getDatabase({ databaseId: database.databaseId });
  expect(observed.data.id).toBe(database.databaseId);
  expect(observed.data.project.id).toBe(database.projectId);
  expect(observed.data.name).toBe(database.databaseName);
  expect(observed.data.branchId).toBe(branchId);
  expect(database.branchId).toBe(branchId);
});

const expectGone = <E, R>(read: Effect.Effect<boolean, E, R>) =>
  read.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      times: 8,
      until: (gone) => gone,
    }),
    Effect.tap((gone) => Effect.sync(() => expect(gone).toBe(true))),
  );

const expectDatabaseGone = (databaseId: string) =>
  expectGone(
    getDatabase({ databaseId }).pipe(
      Effect.as(false),
      Effect.catchTag("NotFound", () => Effect.succeed(true)),
    ),
  );

const expectBranchGone = (branchId: string) =>
  expectGone(
    getBranch({ branchId }).pipe(
      Effect.as(false),
      Effect.catchTag("NotFound", () => Effect.succeed(true)),
    ),
  );

const expectProjectGone = (id: string) =>
  expectGone(
    getProject({ id }).pipe(
      Effect.as(false),
      Effect.catchTag("NotFound", () => Effect.succeed(true)),
    ),
  );

test.provider(
  "attaches named and generated databases to the default branch and preserves it on updates",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const resources = (updated = false) =>
      Effect.gen(function* () {
        const project = yield* Prisma.Project("Project", {
          createDatabase: false,
        });
        const generated = yield* Prisma.Database("Generated", {
          project,
          name: updated ? "generated-updated" : undefined,
        });
        const named = yield* Prisma.Database("Named", {
          project,
          name: updated ? "named-updated" : "named-database",
        });
        return { project, generated, named };
      });

    const initial = yield* stack.deploy(resources());
    const branches = yield* getProjectBranches({
      projectId: initial.project.projectId,
    });
    const defaults = branches.data.filter((branch) => branch.isDefault);
    expect(defaults).toHaveLength(1);
    const defaultBranch = defaults[0]!;
    yield* expectDatabase(initial.generated, defaultBranch.id);
    yield* expectDatabase(initial.named, defaultBranch.id);

    const updated = yield* stack.deploy(resources(true));
    expect(updated.generated.databaseId).toBe(initial.generated.databaseId);
    expect(updated.named.databaseId).toBe(initial.named.databaseId);
    expect(updated.generated.databaseName).toBe("generated-updated");
    expect(updated.named.databaseName).toBe("named-updated");
    yield* expectDatabase(updated.generated, defaultBranch.id);
    yield* expectDatabase(updated.named, defaultBranch.id);

    const repeated = yield* stack.deploy(resources(true));
    expect(repeated.generated.databaseId).toBe(initial.generated.databaseId);
    expect(repeated.named.databaseId).toBe(initial.named.databaseId);
    yield* expectDatabase(repeated.generated, defaultBranch.id);
    yield* expectDatabase(repeated.named, defaultBranch.id);

    yield* stack.destroy();
    yield* expectDatabaseGone(initial.generated.databaseId);
    yield* expectDatabaseGone(initial.named.databaseId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  {
    tags: ["provider:prisma", "provider:prisma:database", "provider:prisma:project", "live"],
    timeout: 120_000,
  },
);

test.provider(
  "preserves a non-default branch when explicit branch props are removed or the attachment changes out of band",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const resources = (attachment: "id" | "gitName" | "omitted", name?: string) =>
      Effect.gen(function* () {
        const project = yield* Prisma.Project("Project", {
          createDatabase: false,
        });
        const first = yield* Prisma.Branch("First", {
          project,
          gitName: "feature/first",
        });
        const second = yield* Prisma.Branch("Second", {
          project,
          gitName: "feature/second",
        });
        const database = yield* Prisma.Database("Database", {
          project,
          name,
          ...(attachment === "id"
            ? { branchId: first.branchId }
            : attachment === "gitName"
              ? { branchGitName: second.gitName }
              : {}),
        });
        return { project, first, second, database };
      });

    const initial = yield* stack.deploy(resources("id"));
    expect(initial.first.isDefault).toBe(false);
    expect(initial.second.isDefault).toBe(false);
    yield* expectDatabase(initial.database, initial.first.branchId);

    const byName = yield* stack.deploy(resources("gitName"));
    expect(byName.database.databaseId).toBe(initial.database.databaseId);
    yield* expectDatabase(byName.database, initial.second.branchId);

    const omitted = yield* stack.deploy(resources("omitted", "renamed"));
    expect(omitted.database.databaseId).toBe(initial.database.databaseId);
    expect(omitted.database.databaseName).toBe("renamed");
    yield* expectDatabase(omitted.database, initial.second.branchId);

    yield* updateDatabase({
      databaseId: initial.database.databaseId,
      branchId: initial.first.branchId,
    });
    const drifted = yield* stack.deploy(resources("omitted", "renamed-again"));
    expect(drifted.database.databaseId).toBe(initial.database.databaseId);
    expect(drifted.database.databaseName).toBe("renamed-again");
    yield* expectDatabase(drifted.database, initial.first.branchId);

    const explicit = yield* stack.deploy(resources("gitName", "renamed-again"));
    expect(explicit.database.databaseId).toBe(initial.database.databaseId);
    yield* expectDatabase(explicit.database, initial.second.branchId);

    yield* stack.destroy();
    yield* expectDatabaseGone(initial.database.databaseId);
    yield* expectBranchGone(initial.first.branchId);
    yield* expectBranchGone(initial.second.branchId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  {
    tags: [
      "provider:prisma",
      "provider:prisma:branch",
      "provider:prisma:database",
      "provider:prisma:project",
      "live",
    ],
    timeout: 120_000,
  },
);

const logicalIdTags = [
  "provider:prisma",
  "provider:prisma:database",
  "provider:prisma:project",
  "live",
];

const observeDatabase = (databaseId: string) =>
  getDatabase({ databaseId }).pipe(Effect.map((response) => response.data));

const databaseStack = (props: { name?: string; logicalId?: string } = {}) =>
  Effect.gen(function* () {
    const project = yield* Prisma.Project("Project", { createDatabase: false });
    const database = yield* Prisma.Database("Main", { project, ...props });
    return { project, database };
  });

test.provider(
  "creates a database under its fqn logical ID and rebinds the logical ID in place",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const initial = yield* stack.deploy(databaseStack());
    expect(initial.database.logicalId).toBe("Main");
    expect((yield* observeDatabase(initial.database.databaseId)).logicalId).toBe("Main");

    const overridden = yield* stack.deploy(databaseStack({ logicalId: "main-db" }));
    expect(overridden.database.databaseId).toBe(initial.database.databaseId);
    expect((yield* observeDatabase(initial.database.databaseId)).logicalId).toBe("main-db");

    const reverted = yield* stack.deploy(databaseStack());
    expect(reverted.database.databaseId).toBe(initial.database.databaseId);
    expect((yield* observeDatabase(initial.database.databaseId)).logicalId).toBe("Main");

    yield* stack.destroy();
    yield* expectDatabaseGone(initial.database.databaseId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: logicalIdTags, timeout: 180_000 },
);

test.provider(
  "after lost state, adoption finds the database by its logical ID despite a Console rename",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const initial = yield* stack.deploy(databaseStack({ name: "main-db" }));
    yield* updateDatabase({ databaseId: initial.database.databaseId, name: "renamed-in-console" });
    yield* forgetState(stack, "Main");

    const refused = yield* failureOf(stack.deploy(databaseStack({ name: "main-db" })));
    expect(refused.errors.some((error) => error instanceof OwnedBySomeoneElse)).toBe(true);

    const adopted = yield* stack.deploy(
      Effect.gen(function* () {
        const project = yield* Prisma.Project("Project", { createDatabase: false });
        const database = yield* Prisma.Database("Main", { project, name: "main-db" }).pipe(
          adopt(true),
        );
        return { project, database };
      }),
    );
    expect(adopted.database.databaseId).toBe(initial.database.databaseId);
    const observed = yield* observeDatabase(initial.database.databaseId);
    expect(observed.name).toBe("main-db");
    expect(observed.logicalId).toBe("Main");

    yield* stack.destroy();
    yield* expectDatabaseGone(initial.database.databaseId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: logicalIdTags, timeout: 180_000 },
);

test.provider(
  "recovers an interrupted database create as owned",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const initial = yield* stack.deploy(databaseStack());
    yield* markCreating(stack, "Main");

    const recovered = yield* stack.deploy(databaseStack());
    expect(recovered.database.databaseId).toBe(initial.database.databaseId);
    expect((yield* observeDatabase(initial.database.databaseId)).logicalId).toBe("Main");

    yield* stack.destroy();
    yield* expectDatabaseGone(initial.database.databaseId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: logicalIdTags, timeout: 180_000 },
);

test.provider(
  "sets the logical ID on a database deployed before logical IDs existed",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const initial = yield* stack.deploy(databaseStack());
    yield* updateDatabase({ databaseId: initial.database.databaseId, logicalId: null });
    yield* patchStateAttr(stack, "Main", { logicalId: null });
    expect((yield* observeDatabase(initial.database.databaseId)).logicalId).toBeNull();

    const stamped = yield* stack.deploy(databaseStack());
    expect(stamped.database.databaseId).toBe(initial.database.databaseId);
    expect((yield* observeDatabase(initial.database.databaseId)).logicalId).toBe("Main");

    yield* stack.destroy();
    yield* expectDatabaseGone(initial.database.databaseId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: logicalIdTags, timeout: 180_000 },
);

test.provider(
  "creates a database on a git branch that does not exist yet, then sets its logical ID",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const resources = Effect.gen(function* () {
      const project = yield* Prisma.Project("Project", { createDatabase: false });
      const database = yield* Prisma.Database("Preview", {
        project,
        branchGitName: "feature/preview",
      });
      return { project, database };
    });

    const initial = yield* stack.deploy(resources);
    const branches = yield* getProjectBranches({
      projectId: initial.project.projectId,
      gitName: "feature/preview",
    });
    expect(branches.data).toHaveLength(1);
    const observed = yield* observeDatabase(initial.database.databaseId);
    expect(observed.branchId).toBe(branches.data[0]!.id);
    expect(observed.logicalId).toBe("Preview");

    const repeated = yield* stack.deploy(resources);
    expect(repeated.database.databaseId).toBe(initial.database.databaseId);

    yield* stack.destroy();
    yield* expectDatabaseGone(initial.database.databaseId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: logicalIdTags, timeout: 180_000 },
);

test.provider(
  "rejects a logical ID that another database on the branch holds",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const resources = (secondLogicalId: string) =>
      Effect.gen(function* () {
        const project = yield* Prisma.Project("Project", { createDatabase: false });
        const first = yield* Prisma.Database("First", { project, logicalId: "shared" });
        const second = yield* Prisma.Database("Second", { project, logicalId: secondLogicalId });
        return { project, first, second };
      });

    const initial = yield* stack.deploy(resources("second"));
    const failure = yield* failureOf(stack.deploy(resources("shared")));
    expect(failure.text).toContain("logical ID 'shared'");
    expect((yield* observeDatabase(initial.first.databaseId)).logicalId).toBe("shared");

    yield* stack.destroy();
    yield* expectDatabaseGone(initial.first.databaseId);
    yield* expectDatabaseGone(initial.second.databaseId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: logicalIdTags, timeout: 180_000 },
);

const databaseStackOn = (props: { name?: string; branchGitName?: string }) =>
  Effect.gen(function* () {
    const project = yield* Prisma.Project("Project", { createDatabase: false });
    const database = yield* Prisma.Database("Main", { project, ...props });
    return { project, database };
  });

test.provider(
  "rejects conflicting branch inputs and a named database with a branch attachment before creating",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const conflicting = yield* failureOf(
      stack.deploy(
        Effect.gen(function* () {
          const project = yield* Prisma.Project("Project", { createDatabase: false });
          const branch = yield* Prisma.Branch("Preview", { project, gitName: "feature/db" });
          const database = yield* Prisma.Database("Main", {
            project,
            branchId: branch.branchId,
            branchGitName: "feature/db",
          });
          return { project, branch, database };
        }),
      ),
    );
    expect(conflicting.text).toContain("branchId and branchGitName are mutually exclusive");

    // The Management API creates before it attaches and has no idempotency
    // key, so an explicitly named create with a branch is not recoverable.
    const named = yield* failureOf(
      stack.deploy(databaseStackOn({ name: "named-db", branchGitName: "feature/named" })),
    );
    expect(named.text).toContain("cannot be distinguished from a foreign database");

    const { project } = yield* stack.deploy(
      Effect.gen(function* () {
        const project = yield* Prisma.Project("Project", { createDatabase: false });
        return { project };
      }),
    );
    const databases = (yield* getProjectDatabases({ projectId: project.projectId })).data;
    expect(databases).toEqual([]);

    yield* stack.destroy();
    yield* expectProjectGone(project.projectId);
  }),
  { tags: [...logicalIdTags, "provider:prisma:branch"], timeout: 180_000 },
);

test.provider(
  "keeps a branchGitName attachment stable and forces reconcile for adoption rotation",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const initial = yield* stack.deploy(databaseStackOn({ branchGitName: "feature/stable" }));
    const branches = yield* getProjectBranches({
      projectId: initial.project.projectId,
      gitName: "feature/stable",
    });
    expect(initial.database.branchId).toBe(branches.data[0]!.id);

    // Observed branch ids already match: no update is planned.
    const stable = yield* stack.plan(databaseStackOn({ branchGitName: "feature/stable" }));
    expect(stable.resources["Main"]).toMatchObject({ action: "noop" });

    const rotate = yield* stack.plan(
      Effect.gen(function* () {
        const project = yield* Prisma.Project("Project", { createDatabase: false });
        const database = yield* Prisma.Database("Main", {
          project,
          branchGitName: "feature/stable",
          rotateCredentialsOnAdopt: true,
        });
        return { project, database };
      }),
    );
    expect(rotate.resources["Main"]).toMatchObject({ action: "update" });

    yield* stack.destroy();
    yield* expectDatabaseGone(initial.database.databaseId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: [...logicalIdTags, "provider:prisma:branch"], timeout: 180_000 },
);

test.provider(
  "deletes a database whose stale state says default and refuses one observed as default",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const resources = (names: ReadonlyArray<"Main" | "Stale">) =>
      Effect.gen(function* () {
        const project = yield* Prisma.Project("Project", {});
        const databases = yield* Effect.forEach(names, (name) =>
          Prisma.Database(name, { project }),
        );
        return { project, databases };
      });

    const initial = yield* stack.deploy(resources(["Main", "Stale"]));
    const [main, stale] = initial.databases;
    const defaultDatabaseId = initial.project.databaseId!;
    expect(main!.isDefault).toBe(false);

    // Stale state claims default; the live database is not, so delete proceeds.
    yield* patchStateAttr(stack, "Stale", { isDefault: true });
    yield* stack.deploy(resources(["Main"]));
    yield* expectDatabaseGone(stale!.databaseId);

    // State now points at the project's default database while claiming it is
    // not default; delete must observe the live flag and refuse.
    yield* patchStateAttr(stack, "Main", { databaseId: defaultDatabaseId });
    const refused = yield* failureOf(stack.deploy(resources([])));
    expect(refused.text).toContain("Cannot delete default Prisma database");
    const survivor = yield* observeDatabase(defaultDatabaseId);
    expect(survivor.isDefault).toBe(true);

    // Project deletion owns the default database (and the real "Main").
    yield* forgetState(stack, "Main");
    yield* stack.destroy();
    yield* expectDatabaseGone(main!.databaseId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: logicalIdTags, timeout: 180_000 },
);

// Creating a clone live fails: `POST /v1/databases` with
// `source: { type: "database", databaseId }` answers HTTP 500 for both the
// `db_`-prefixed and the bare ID. Set PRISMA_TEST_DATABASE_CLONE=1 to run it.
test.provider.skipIf(!process.env.PRISMA_TEST_DATABASE_CLONE)(
  "creates a clone database and keeps its source stable",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const resources = Effect.gen(function* () {
      const project = yield* Prisma.Project("Project", { createDatabase: false });
      const source = yield* Prisma.Database("Source", { project });
      const clone = yield* Prisma.Database("Clone", {
        project,
        source: { type: "database", databaseId: source.databaseId },
      });
      return { project, source, clone };
    });

    const initial = yield* stack.deploy(resources);
    const plan = yield* stack.plan(resources);
    expect(plan.resources["Clone"]).toMatchObject({ action: "noop" });

    yield* stack.destroy();
    yield* expectDatabaseGone(initial.clone.databaseId);
    yield* expectDatabaseGone(initial.source.databaseId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: logicalIdTags, timeout: 240_000 },
);

// Fault injection the real API cannot produce on demand: source shapes it
// reports for a clone, and creates whose response is lost as a 409.
const fakeTags = ["unit", "provider:prisma", "provider:prisma:database", "local"];

const fakeDatabaseStack = (props: {
  name?: string;
  source?: { type: "database"; databaseId: string };
}) =>
  Effect.gen(function* () {
    const project = yield* Prisma.Project("Project", { createDatabase: false });
    const database = yield* Prisma.Database("Database", { project, ...props });
    return { project, database };
  });

const cloneCloud = makeFakeCloud();
const clone = Test.make({ providers: fakeCloudProviders(cloneCloud) });

clone.test.provider(
  "normalizes Management API clone source ids before comparing immutable state",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    // The API reports the source database without its `db_` prefix.
    cloneCloud.faults.databaseSource = (requested) => {
      const source = requested as { type: string; databaseId: string };
      return { type: source.type, databaseId: source.databaseId.replace(/^db_/, "") };
    };
    const resources = fakeDatabaseStack({
      source: { type: "database", databaseId: "db_source" },
    });
    const initial = yield* stack.deploy(resources);
    expect(cloneCloud.databases.get(initial.database.databaseId)?.source).toEqual({
      type: "database",
      databaseId: "source",
    });

    const plan = yield* stack.plan(resources);
    expect(plan.resources["Database"]).toMatchObject({ action: "noop" });
    const repeated = yield* stack.deploy(resources);
    expect(repeated.database.databaseId).toBe(initial.database.databaseId);
    expect(
      cloneCloud.api.captured.filter(
        (request) => request.method === "PATCH" && request.pathname.startsWith("/v1/databases/"),
      ),
    ).toEqual([]);

    yield* stack.destroy();
    cloneCloud.faults.databaseSource = undefined;
  }),
  { tags: fakeTags },
);

const exoticCloud = makeFakeCloud();
const exotic = Test.make({ providers: fakeCloudProviders(exoticCloud) });

exotic.test.provider(
  "refuses convergence when the observed source shape is unrecognized",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    exoticCloud.faults.databaseSource = () => ({ type: "replica", replicaOf: "db_source" });
    const failure = yield* failureOf(stack.deploy(fakeDatabaseStack({})));
    exoticCloud.faults.databaseSource = undefined;
    expect(failure.text).toContain("immutable source");
    expect(failure.text).toContain('"replica"');
    expect(
      exoticCloud.api.captured.filter(
        (request) => request.method === "PATCH" && request.pathname.startsWith("/v1/databases/"),
      ),
    ).toEqual([]);

    // The refused database cannot be adopted for cleanup either; remove it
    // out of band so destroy only drains the project.
    exoticCloud.databases.clear();
    yield* stack.destroy();
    expect(exoticCloud.projects.size).toBe(0);
  }),
  { tags: fakeTags },
);

const raceCloud = makeFakeCloud();
const race = Test.make({ providers: fakeCloudProviders(raceCloud) });

race.test.provider(
  "recovers a generated database after a create conflict and refuses a named one",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    raceCloud.faults.race.add("database");
    const recovered = yield* stack.deploy(fakeDatabaseStack({}));
    const raced = raceCloud.databases.get(recovered.database.databaseId);
    expect(raced?.name).toBe(recovered.database.databaseName);
    expect(raced?.name).toContain("-Database-");
    // Recovery stamps the logical ID and rotates the write-only credentials.
    expect(raced?.logicalId).toBe("Database");
    expect(Redacted.value(recovered.database.directConnectionString!)).toContain(
      recovered.database.databaseId,
    );
    expect(
      raceCloud.api.captured.some(
        (request) =>
          request.method === "POST" &&
          request.pathname === `/v1/connections/connection-${recovered.database.databaseId}/rotate`,
      ),
    ).toBe(true);
    yield* stack.destroy();
    expect(raceCloud.databases.size).toBe(0);

    raceCloud.faults.race.add("database");
    const named = yield* failureOf(stack.deploy(fakeDatabaseStack({ name: "main" })));
    expect(named.text).toContain("appeared after the adoption check");

    yield* stack.destroy();
  }),
  { tags: fakeTags },
);
