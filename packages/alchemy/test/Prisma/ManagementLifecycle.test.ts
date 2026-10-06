import {
  createEnvironmentVariable,
  createProject,
  createProjectBranch,
  createProjectDatabase,
  getBranch,
  getDatabase,
  getEnvironmentVariable,
  getProject,
  getProjectBranches,
  getProjectDatabases,
  updateBranch,
  updateEnvironmentVariable,
} from "@distilled.cloud/prisma/management";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { adopt, OwnedBySomeoneElse } from "@/AdoptPolicy";
import * as Prisma from "@/Prisma";
import { Branch as PrismaBranch } from "@/Prisma/Branch";
import { Database as PrismaDatabase } from "@/Prisma/Database";
import { EnvironmentVariable as PrismaEnvironmentVariable } from "@/Prisma/EnvironmentVariable";
import { Project as PrismaProject } from "@/Prisma/Project";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import {
  expectGone,
  expectProjectGone,
  failureOf,
  forgetState,
  markCreating,
  patchStateAttr,
} from "./fixtures/Live.ts";

const live = Test.make({ providers: Prisma.providers() });

const liveTags = (...resources: string[]) => [
  "provider:prisma",
  ...resources.map((resource) => `provider:prisma:${resource}`),
  "live",
];

const projectDatabases = (projectId: string) =>
  getProjectDatabases({ projectId }).pipe(Effect.map((response) => response.data));

const projectBranches = (projectId: string) =>
  getProjectBranches({ projectId, limit: 100 }).pipe(Effect.map((response) => response.data));

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

const expectEnvironmentVariableGone = (envVarId: string) =>
  expectGone(
    getEnvironmentVariable({ envVarId }).pipe(
      Effect.as(false),
      Effect.catchTag("NotFound", () => Effect.succeed(true)),
    ),
  );

const isOwnedBySomeoneElse = (failure: { errors: unknown[] }) =>
  failure.errors.some((error) => error instanceof OwnedBySomeoneElse);

live.test.provider(
  "refuses cold adoption of a named project after lost state, then adopts it explicitly",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = `alchemy-lifecycle-adopt-${stack.stage}`;
      const project = PrismaProject("Project", { name, createDatabase: false });

      const initial = yield* stack.deploy(project);
      yield* forgetState(stack, "Project");

      const refused = yield* failureOf(stack.deploy(project));
      expect(isOwnedBySomeoneElse(refused)).toBe(true);
      expect((yield* getProject({ id: initial.projectId })).data.name).toBe(name);

      const adopted = yield* stack.deploy(project.pipe(adopt(true)));
      expect(adopted.projectId).toBe(initial.projectId);
      expect(adopted.projectName).toBe(name);

      yield* stack.destroy();
      yield* expectProjectGone(initial.projectId);
    }),
  { tags: liveTags("project"), timeout: 240_000 },
);

live.test.provider(
  "adds a missing default database in place and refuses an in-place region change",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const bare = yield* stack.deploy(PrismaProject("Project", { createDatabase: false }));
      expect(bare.databaseId).toBeUndefined();

      const withDefault = yield* stack.deploy(PrismaProject("Project", { createDatabase: true }));
      expect(withDefault.projectId).toBe(bare.projectId);
      expect(withDefault.databaseId).toBeDefined();
      expect(withDefault.defaultRegion).toBe("us-east-1");
      expect(withDefault.directConnectionString).toBeDefined();
      const defaults = (yield* projectDatabases(bare.projectId)).filter((db) => db.isDefault);
      expect(defaults.map((db) => db.id)).toEqual([withDefault.databaseId]);

      const moved = yield* failureOf(
        stack.deploy(PrismaProject("Project", { createDatabase: true, region: "eu-central-1" })),
      );
      expect(moved.text).toContain("Cannot safely change");
      expect(moved.text).toContain("explicit data migration");
      const after = yield* projectDatabases(bare.projectId);
      expect(after.map((db) => db.id)).toEqual([withDefault.databaseId]);
      expect(after[0]?.region?.id).toBe("us-east-1");

      yield* stack.destroy();
      yield* expectProjectGone(bare.projectId);
    }),
  { tags: liveTags("database", "project"), timeout: 240_000 },
);

live.test.provider(
  "replaces a named project delete-first when its last default database is removed",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = `alchemy-lifecycle-replace-${stack.stage}`;

      const first = yield* stack.deploy(PrismaProject("Project", { name, createDatabase: true }));
      expect(first.databaseId).toBeDefined();

      const without = PrismaProject("Project", { name, createDatabase: false });
      const node = (yield* stack.plan(without)).resources.Project;
      expect(node?.action).toBe("replace");
      if (node?.action === "replace") {
        expect(node.deleteFirst).toBe(true);
      }

      const second = yield* stack.deploy(without);
      expect(second.projectId).not.toBe(first.projectId);
      expect(second.databaseId).toBeUndefined();
      yield* expectProjectGone(first.projectId);

      yield* stack.destroy();
      yield* expectProjectGone(second.projectId);
    }),
  { tags: liveTags("database", "project"), timeout: 240_000 },
);

live.test.provider(
  "an out-of-band default database blocks reconciling a project as createDatabase: false",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const bare = yield* stack.deploy(PrismaProject("Project", { createDatabase: false }));
      yield* createProjectDatabase({
        projectId: bare.projectId,
        region: "us-east-1",
        isDefault: true,
      });

      // A rename forces a reconcile of the createDatabase: false project.
      const refused = yield* failureOf(
        stack.deploy(
          PrismaProject("Project", {
            name: `alchemy-lifecycle-default-${stack.stage}`,
            createDatabase: false,
          }),
        ),
      );
      expect(refused.text).toContain("cannot be removed in place");
      expect((yield* getProject({ id: bare.projectId })).data.name).toBe(bare.projectName);

      yield* stack.destroy();
      yield* expectProjectGone(bare.projectId);
    }),
  { tags: liveTags("database", "project"), timeout: 240_000 },
);

live.test.provider(
  "interrupted creates of generated projects and databases recover as owned with fresh credentials",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const resources = Effect.gen(function* () {
        const project = yield* PrismaProject("Project", {});
        const database = yield* PrismaDatabase("Database", { project });
        return { project, database };
      });

      const initial = yield* stack.deploy(resources);
      expect(initial.project.directConnectionString).toBeDefined();
      expect(initial.database.directConnectionString).toBeDefined();

      // markCreating drops the attributes, including the write-only secrets.
      yield* markCreating(stack, "Project");
      yield* markCreating(stack, "Database");
      const recovered = yield* stack.deploy(resources);
      expect(recovered.project.projectId).toBe(initial.project.projectId);
      expect(recovered.project.databaseId).toBe(initial.project.databaseId);
      expect(recovered.project.directConnectionString).toBeDefined();
      expect(recovered.database.databaseId).toBe(initial.database.databaseId);
      expect(recovered.database.directConnectionString).toBeDefined();

      yield* stack.destroy();
      yield* expectDatabaseGone(initial.database.databaseId);
      yield* expectProjectGone(initial.project.projectId);
    }),
  { tags: liveTags("database", "project"), timeout: 240_000 },
);

live.test.provider(
  "refuses a standalone default database before creating anything",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const project = PrismaProject("Project", { createDatabase: false });
      const created = yield* stack.deploy(project);
      const refused = yield* failureOf(
        stack.deploy(
          Effect.gen(function* () {
            const owner = yield* project;
            // `isDefault: true` is not in DatabaseProps; this pins the guard
            // for untyped callers.
            return yield* PrismaDatabase("Primary", {
              project: owner,
              isDefault: true,
            } as unknown as Prisma.DatabaseProps);
          }),
        ),
      );
      expect(refused.text).toContain("could never be destroyed");
      expect(yield* projectDatabases(created.projectId)).toEqual([]);

      yield* stack.destroy();
      yield* expectProjectGone(created.projectId);
    }),
  { tags: liveTags("database", "project"), timeout: 240_000 },
);

type AdoptedDatabaseProps = Pick<
  Prisma.DatabaseProps,
  "isDefault" | "region" | "rotateCredentialsOnAdopt"
>;

live.test.provider(
  "adopting a named database refuses default and region mismatches and rotates credentials only on request",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const resources = (props: AdoptedDatabaseProps = {}, adopted = false) =>
        Effect.gen(function* () {
          const project = yield* PrismaProject("Project", { createDatabase: false });
          const declared = PrismaDatabase("Main", { project, name: "explicit", ...props });
          const database = yield* adopted ? declared.pipe(adopt(true)) : declared;
          return { project, database };
        });

      const initial = yield* stack.deploy(resources());
      expect(initial.database.directConnectionString).toBeDefined();

      yield* forgetState(stack, "Main");
      const refused = yield* failureOf(stack.deploy(resources()));
      expect(isOwnedBySomeoneElse(refused)).toBe(true);

      yield* forgetState(stack, "Main");
      const asDefault = yield* failureOf(
        stack.deploy(resources({ isDefault: true } as unknown as AdoptedDatabaseProps, true)),
      );
      expect(asDefault.text).toContain("cannot manage a default database");
      expect((yield* getDatabase({ databaseId: initial.database.databaseId })).data.isDefault).toBe(
        false,
      );

      yield* forgetState(stack, "Main");
      const adopted = yield* stack.deploy(resources({}, true));
      expect(adopted.database.databaseId).toBe(initial.database.databaseId);
      expect(adopted.database.directConnectionString).toBeUndefined();

      yield* forgetState(stack, "Main");
      const rotated = yield* stack.deploy(resources({ rotateCredentialsOnAdopt: true }, true));
      expect(rotated.database.databaseId).toBe(initial.database.databaseId);
      expect(rotated.database.directConnectionString).toBeDefined();

      yield* forgetState(stack, "Main");
      const wrongRegion = yield* failureOf(
        stack.deploy(resources({ region: "eu-central-1" }, true)),
      );
      expect(wrongRegion.text).toContain("immutable region");
      expect(
        (yield* getDatabase({ databaseId: initial.database.databaseId })).data.region?.id,
      ).toBe("us-east-1");

      yield* stack.destroy();
      yield* expectDatabaseGone(initial.database.databaseId);
      yield* expectProjectGone(initial.project.projectId);
    }),
  { tags: liveTags("database", "project"), timeout: 240_000 },
);

live.test.provider(
  "branch promotion records the displaced default, heals demotion, and restores it on delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const resources = (withPreview: boolean) =>
        Effect.gen(function* () {
          const project = yield* PrismaProject("Project", { createDatabase: false });
          const preview = withPreview
            ? yield* PrismaBranch("Preview", { project, gitName: "preview", isDefault: true })
            : undefined;
          return { project, preview };
        });

      const initial = yield* stack.deploy(resources(true));
      const preview = initial.preview!;
      expect(preview.isDefault).toBe(true);
      expect(preview.role).toBe("preview");
      expect(preview.previousDefaultBranchId).toBeDefined();
      const mainId = preview.previousDefaultBranchId!;
      const main = (yield* getBranch({ branchId: mainId })).data;
      expect(main.isDefault).toBe(false);
      expect(main.role).toBe("production");
      expect((yield* stack.plan(resources(true))).resources.Preview?.action).toBe("noop");

      // Another client promotes main, atomically demoting the desired default.
      // The engine plans from persisted attributes, so record the demotion.
      yield* updateBranch({ branchId: mainId, isDefault: true });
      yield* patchStateAttr(stack, "Preview", { isDefault: false });
      expect((yield* stack.plan(resources(true))).resources.Preview?.action).toBe("update");
      const healed = yield* stack.deploy(resources(true));
      expect(healed.preview?.branchId).toBe(preview.branchId);
      expect(healed.preview?.isDefault).toBe(true);
      expect(healed.preview?.previousDefaultBranchId).toBe(mainId);
      expect((yield* getBranch({ branchId: preview.branchId })).data.isDefault).toBe(true);
      expect((yield* getBranch({ branchId: mainId })).data.isDefault).toBe(false);

      // Deleting the promoted branch restores the default it displaced.
      yield* stack.deploy(resources(false));
      expect((yield* getBranch({ branchId: mainId })).data.isDefault).toBe(true);
      yield* expectBranchGone(preview.branchId);

      yield* stack.destroy();
      yield* expectProjectGone(initial.project.projectId);
    }),
  { tags: liveTags("branch", "project"), timeout: 240_000 },
);

live.test.provider(
  "adopts a foreign environment variable and re-applies its write-only value on every deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const project = yield* stack.deploy(PrismaProject("Project", { createDatabase: false }));
      const foreign = (yield* createEnvironmentVariable({
        projectId: project.projectId,
        class: "production",
        key: "TOKEN",
        value: "foreign",
      })).data;

      const resources = (adopted: boolean) =>
        Effect.gen(function* () {
          const owner = yield* PrismaProject("Project", { createDatabase: false });
          const declared = PrismaEnvironmentVariable("Token", {
            project: owner,
            class: "production",
            key: "TOKEN",
            value: Redacted.make("desired"),
          });
          return yield* adopted ? declared.pipe(adopt(true)) : declared;
        });

      const refused = yield* failureOf(stack.deploy(resources(false)));
      expect(isOwnedBySomeoneElse(refused)).toBe(true);

      // Values are write-only, so a newer `updatedAt` is the observable proof
      // that each deploy rewrote the secret.
      const adopted = yield* stack.deploy(resources(true));
      expect(adopted.environmentVariableId).toBe(foreign.id);
      const afterAdoption = (yield* getEnvironmentVariable({ envVarId: foreign.id })).data;
      expect(Date.parse(afterAdoption.updatedAt)).toBeGreaterThan(Date.parse(foreign.updatedAt));

      const drifted = (yield* updateEnvironmentVariable({
        envVarId: foreign.id,
        value: "externally-drifted",
      })).data;
      expect((yield* stack.plan(resources(true))).resources.Token?.action).toBe("update");
      const healed = yield* stack.deploy(resources(true));
      expect(healed.environmentVariableId).toBe(foreign.id);
      const afterHeal = (yield* getEnvironmentVariable({ envVarId: foreign.id })).data;
      expect(Date.parse(afterHeal.updatedAt)).toBeGreaterThan(Date.parse(drifted.updatedAt));

      yield* stack.destroy();
      yield* expectEnvironmentVariableGone(foreign.id);
      yield* expectProjectGone(project.projectId);
    }),
  { tags: liveTags("environmentvariable", "project"), timeout: 240_000 },
);

live.test.provider(
  "explicitly adopts a foreign project with a default database and re-applies write-only settings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = `alchemy-lifecycle-settings-${stack.stage}`;
      const foreign = (yield* createProject({ name, createDatabase: true, region: "us-east-1" }))
        .data;
      const foreignDatabaseId = foreign.database?.id;
      expect(foreignDatabaseId).toBeDefined();

      const project = (settings: Record<string, unknown> | undefined) =>
        PrismaProject("Project", { name, createDatabase: true, region: "us-east-1", settings });

      const refused = yield* failureOf(stack.deploy(project({ tier: "dev" })));
      expect(isOwnedBySomeoneElse(refused)).toBe(true);

      const adopted = yield* stack.deploy(project({ tier: "dev" }).pipe(adopt(true)));
      expect(adopted.projectId).toBe(foreign.id);
      expect(adopted.databaseId).toBe(foreignDatabaseId);
      expect(adopted.defaultRegion).toBe("us-east-1");
      expect((yield* projectDatabases(foreign.id)).map((db) => db.id)).toEqual([foreignDatabaseId]);

      // Settings are write-only: an explicit value is re-applied every
      // deploy, and removing it clears it once.
      expect((yield* stack.plan(project({ tier: "dev" }))).resources.Project?.action).toBe(
        "update",
      );
      const reapplied = yield* stack.deploy(project({ tier: "dev" }));
      expect(reapplied.projectId).toBe(foreign.id);
      expect((yield* stack.plan(project(undefined))).resources.Project?.action).toBe("update");
      yield* stack.deploy(project(undefined));
      expect((yield* stack.plan(project(undefined))).resources.Project?.action).toBe("noop");
      expect((yield* getProject({ id: foreign.id })).data.name).toBe(name);

      yield* stack.destroy();
      yield* expectProjectGone(foreign.id);
    }),
  { tags: liveTags("database", "project"), timeout: 240_000 },
);

live.test.provider(
  "adds a default database in a non-default region, then a database inheriting that region",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const resources = (options: { createDatabase: boolean; inherited: boolean }) =>
        Effect.gen(function* () {
          const project = yield* PrismaProject("Project", {
            createDatabase: options.createDatabase,
            ...(options.createDatabase ? { region: "us-west-1" as const } : {}),
          });
          const inherited = options.inherited
            ? yield* PrismaDatabase("Inherited", { project, name: "inherited", region: "inherit" })
            : undefined;
          return { project, inherited };
        });

      const bare = yield* stack.deploy(resources({ createDatabase: false, inherited: false }));
      const projectId = bare.project.projectId;

      // No default database: there is no region to inherit.
      const orphan = yield* failureOf(
        stack.deploy(resources({ createDatabase: false, inherited: true })),
      );
      expect(orphan.text).toContain("has no default database region");
      expect(yield* projectDatabases(projectId)).toEqual([]);

      const withDefault = yield* stack.deploy(
        resources({ createDatabase: true, inherited: false }),
      );
      expect(withDefault.project.projectId).toBe(projectId);
      expect(withDefault.project.defaultRegion).toBe("us-west-1");
      expect(withDefault.project.directConnectionString).toBeDefined();
      expect((yield* getProject({ id: projectId })).data.defaultRegion).toBe("us-west-1");
      const defaults = (yield* projectDatabases(projectId)).filter((db) => db.isDefault);
      expect(defaults.map((db) => [db.id, db.region?.id])).toEqual([
        [withDefault.project.databaseId, "us-west-1"],
      ]);

      const inherited = yield* stack.deploy(resources({ createDatabase: true, inherited: true }));
      const databaseId = inherited.inherited!.databaseId;
      expect(inherited.inherited?.region).toBe("us-west-1");
      expect((yield* getDatabase({ databaseId })).data.region?.id).toBe("us-west-1");

      const settled = yield* stack.plan(resources({ createDatabase: true, inherited: true }));
      expect(settled.resources.Project?.action).toBe("noop");
      expect(settled.resources.Inherited?.action).toBe("noop");
      const again = yield* stack.deploy(resources({ createDatabase: true, inherited: true }));
      expect(again.inherited?.databaseId).toBe(databaseId);

      yield* stack.destroy();
      yield* expectDatabaseGone(databaseId);
      yield* expectProjectGone(projectId);
    }),
  { tags: liveTags("database", "project"), timeout: 300_000 },
);

live.test.provider(
  "Branch list omits the project's default and production-role branches",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { projectId } = yield* stack.deploy(
        PrismaProject("Project", { createDatabase: false }),
      );
      const main = (yield* projectBranches(projectId)).find((branch) => branch.isDefault)!;
      expect(main.role).toBe("production");

      // Promoting a preview branch demotes main but keeps its production role.
      const promoted = (yield* createProjectBranch({ projectId, gitName: "promoted" })).data;
      yield* updateBranch({ branchId: promoted.id, isDefault: true });
      const feature = (yield* createProjectBranch({ projectId, gitName: "feature" })).data;
      const observed = yield* projectBranches(projectId);
      expect(observed.find((branch) => branch.id === main.id)?.isDefault).toBe(false);
      expect(observed.find((branch) => branch.id === promoted.id)?.isDefault).toBe(true);

      const provider = yield* Provider.findProvider(PrismaBranch);
      const listed = (yield* provider.list!())
        .filter((branch) => branch.projectId === projectId)
        .map((branch) => branch.branchId);
      expect(listed).toEqual([feature.id]);

      yield* stack.destroy();
      yield* expectProjectGone(projectId);
      yield* expectBranchGone(feature.id);
    }),
  { tags: liveTags("branch", "project"), timeout: 240_000 },
);
