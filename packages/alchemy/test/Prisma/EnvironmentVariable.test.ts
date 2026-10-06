import {
  createEnvironmentVariable,
  getEnvironmentVariables,
} from "@distilled.cloud/prisma/management";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { adopt, OwnedBySomeoneElse } from "@/AdoptPolicy";
import * as Prisma from "@/Prisma";
import * as Test from "@/Test/Alchemy";
import { expectProjectGone, failureOf, forgetState, patchStateAttr } from "./fixtures/Live.ts";
import {
  expectBranchGone,
  expectEnvironmentVariableGone,
  observeEnvironmentVariable,
} from "./fixtures/ResourcesLive.ts";

const { test } = Test.make({ providers: Prisma.providers() });

const tags = [
  "provider:prisma",
  "provider:prisma:environmentvariable",
  "provider:prisma:project",
  "live",
];

const variableStack = (
  value: string,
  props: { key?: string; class?: "production" | "preview" } = {},
) =>
  Effect.gen(function* () {
    const project = yield* Prisma.Project("Project", { createDatabase: false });
    const variable = yield* Prisma.EnvironmentVariable("Token", {
      project,
      class: props.class ?? "production",
      key: props.key ?? "TOKEN",
      value: Redacted.make(value),
    });
    return { project, variable };
  });

const listVariables = (projectId: string) =>
  getEnvironmentVariables({ projectId }).pipe(Effect.map((response) => response.data));

/** Prisma creates the system-managed DATABASE_URL alongside a default database. */
const systemDatabaseUrl = (projectId: string) =>
  listVariables(projectId).pipe(
    Effect.map((variables) =>
      variables.find((variable) => variable.key === "DATABASE_URL" && variable.isManagedBySystem),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      times: 10,
      until: (variable) => variable !== undefined,
    }),
    Effect.flatMap((variable) =>
      variable === undefined
        ? Effect.die(new Error("Prisma did not create the system-managed DATABASE_URL"))
        : Effect.succeed(variable),
    ),
  );

test.provider(
  "creates a project variable, re-applies and updates its write-only value, and deletes it",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const initial = yield* stack.deploy(variableStack("first-secret"));
    expect(initial.variable.projectId).toBe(initial.project.projectId);
    expect(initial.variable.branchId).toBeNull();
    expect(initial.variable.isManagedBySystem).toBe(false);
    expect(Redacted.value(initial.variable.value)).toBe("first-secret");
    expect(JSON.stringify(initial.variable)).not.toContain("first-secret");
    const observed = yield* observeEnvironmentVariable(initial.variable.environmentVariableId);
    expect(observed.key).toBe("TOKEN");
    expect(observed.class).toBe("production");
    expect(observed.branchId).toBeNull();
    expect(observed.valueKid).toBe(initial.variable.valueKid);

    // The API never returns plaintext, so an unchanged value is still re-applied.
    const reapply = yield* stack.plan(variableStack("first-secret"));
    expect(reapply.resources["Token"]).toMatchObject({ action: "update" });

    const updated = yield* stack.deploy(variableStack("second-secret"));
    expect(updated.variable.environmentVariableId).toBe(initial.variable.environmentVariableId);
    expect(Redacted.value(updated.variable.value)).toBe("second-secret");
    expect(JSON.stringify(updated.variable)).not.toContain("second-secret");

    const rekey = yield* stack.plan(variableStack("second-secret", { key: "OTHER_TOKEN" }));
    expect(rekey.resources["Token"]).toMatchObject({ action: "replace" });
    const reclass = yield* stack.plan(variableStack("second-secret", { class: "preview" }));
    expect(reclass.resources["Token"]).toMatchObject({ action: "replace" });

    yield* stack.destroy();
    yield* expectEnvironmentVariableGone(initial.variable.environmentVariableId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags, timeout: 180_000 },
);

test.provider(
  "adopts the project variable after lost state without matching a branch override",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const resources = (adoptToken: boolean) =>
      Effect.gen(function* () {
        const project = yield* Prisma.Project("Project", { createDatabase: false });
        const branch = yield* Prisma.Branch("Preview", { project, gitName: "feature/env" });
        const override = yield* Prisma.EnvironmentVariable("Override", {
          project,
          branchId: branch.branchId,
          class: "preview",
          key: "TOKEN",
          value: Redacted.make("branch-secret"),
        });
        const token = Prisma.EnvironmentVariable("Token", {
          project,
          class: "preview",
          key: "TOKEN",
          value: Redacted.make("project-secret"),
        });
        const variable = yield* adoptToken ? token.pipe(adopt(true)) : token;
        return { project, branch, override, variable };
      });

    const initial = yield* stack.deploy(resources(false));
    expect(initial.override.branchId).toBe(initial.branch.branchId);
    expect(initial.variable.branchId).toBeNull();
    expect(initial.variable.environmentVariableId).not.toBe(initial.override.environmentVariableId);

    yield* forgetState(stack, "Token");
    const refused = yield* failureOf(stack.deploy(resources(false)));
    expect(refused.errors.some((error) => error instanceof OwnedBySomeoneElse)).toBe(true);

    const adopted = yield* stack.deploy(resources(true));
    expect(adopted.variable.environmentVariableId).toBe(initial.variable.environmentVariableId);
    expect(adopted.variable.branchId).toBeNull();
    expect(adopted.override.environmentVariableId).toBe(initial.override.environmentVariableId);
    expect(
      (yield* observeEnvironmentVariable(initial.override.environmentVariableId)).branchId,
    ).toBe(initial.branch.branchId);

    yield* stack.destroy();
    yield* expectEnvironmentVariableGone(initial.variable.environmentVariableId);
    yield* expectEnvironmentVariableGone(initial.override.environmentVariableId);
    yield* expectBranchGone(initial.branch.branchId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: [...tags, "provider:prisma:branch"], timeout: 180_000 },
);

test.provider(
  "refuses to manage a Prisma system-managed variable",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const { project } = yield* stack.deploy(
      Effect.gen(function* () {
        const project = yield* Prisma.Project("Project", {});
        return { project };
      }),
    );
    const system = yield* systemDatabaseUrl(project.projectId);

    const resources = (adoptIt: boolean) =>
      Effect.gen(function* () {
        const project = yield* Prisma.Project("Project", {});
        const variable = Prisma.EnvironmentVariable("DatabaseUrl", {
          project,
          class: "production",
          key: "DATABASE_URL",
          value: Redacted.make("postgres://not-yours"),
        });
        return { project, variable: yield* adoptIt ? variable.pipe(adopt(true)) : variable };
      });

    const unowned = yield* failureOf(stack.deploy(resources(false)));
    expect(unowned.errors.some((error) => error instanceof OwnedBySomeoneElse)).toBe(true);
    const refused = yield* failureOf(stack.deploy(resources(true)));
    expect(refused.text).toContain("is managed by Prisma and cannot be managed by Alchemy");

    const after = yield* observeEnvironmentVariable(system.id);
    expect(after.isManagedBySystem).toBe(true);
    expect(after.valueKid).toBe(system.valueKid);
    expect(after.updatedAt).toBe(system.updatedAt);

    yield* stack.destroy();
    yield* expectProjectGone(project.projectId);
  }),
  { tags: [...tags, "provider:prisma:database"], timeout: 180_000 },
);

test.provider(
  "checks the live system-managed flag before deleting a variable",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        const project = yield* Prisma.Project("Project", {});
        const token = yield* Prisma.EnvironmentVariable("Token", {
          project,
          class: "production",
          key: "TOKEN",
          value: Redacted.make("token-secret"),
        });
        const stale = yield* Prisma.EnvironmentVariable("Stale", {
          project,
          class: "production",
          key: "STALE",
          value: Redacted.make("stale-secret"),
        });
        return { project, token, stale };
      }),
    );
    const system = yield* systemDatabaseUrl(initial.project.projectId);

    // "Token" state now points at the system variable but still claims it is
    // user-managed; "Stale" state claims a user variable is system-managed.
    yield* patchStateAttr(stack, "Token", {
      environmentVariableId: system.id,
      key: "DATABASE_URL",
      valueKid: system.valueKid,
      isManagedBySystem: false,
    });
    yield* patchStateAttr(stack, "Stale", { isManagedBySystem: true });

    yield* stack.deploy(
      Effect.gen(function* () {
        const project = yield* Prisma.Project("Project", {});
        return { project };
      }),
    );
    const survivor = yield* observeEnvironmentVariable(system.id);
    expect(survivor.isManagedBySystem).toBe(true);
    yield* expectEnvironmentVariableGone(initial.stale.environmentVariableId);

    yield* stack.destroy();
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: [...tags, "provider:prisma:database"], timeout: 180_000 },
);

test.provider(
  "validates variable keys, values, and branch class before calling Prisma",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const badKey = yield* failureOf(stack.deploy(variableStack("secret", { key: "bad-key" })));
    expect(badKey.text).toContain("must match POSIX env-var key shape");

    const emptyValue = yield* failureOf(stack.deploy(variableStack("")));
    expect(emptyValue.text).toContain("value must be non-empty");

    const branchProduction = yield* failureOf(
      stack.deploy(
        Effect.gen(function* () {
          const project = yield* Prisma.Project("Project", { createDatabase: false });
          const branch = yield* Prisma.Branch("Preview", { project, gitName: "feature/env" });
          const variable = yield* Prisma.EnvironmentVariable("Token", {
            project,
            branchId: branch.branchId,
            class: "production",
            key: "TOKEN",
            value: Redacted.make("secret"),
          });
          return { project, branch, variable };
        }),
      ),
    );
    expect(branchProduction.text).toContain('must use class: "preview"');

    const { project } = yield* stack.deploy(
      Effect.gen(function* () {
        const project = yield* Prisma.Project("Project", { createDatabase: false });
        return { project };
      }),
    );
    expect(yield* listVariables(project.projectId)).toEqual([]);

    yield* stack.destroy();
    yield* expectProjectGone(project.projectId);
  }),
  { tags: [...tags, "provider:prisma:branch"], timeout: 180_000 },
);

test.provider(
  "refuses to overwrite a variable created out of band before the deploy",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const { project } = yield* stack.deploy(
      Effect.gen(function* () {
        const project = yield* Prisma.Project("Project", { createDatabase: false });
        return { project };
      }),
    );
    const foreign = (yield* createEnvironmentVariable({
      projectId: project.projectId,
      class: "production",
      key: "TOKEN",
      value: "foreign-secret",
    })).data;

    const refused = yield* failureOf(stack.deploy(variableStack("secret")));
    expect(refused.errors.some((error) => error instanceof OwnedBySomeoneElse)).toBe(true);
    // The foreign secret was not overwritten.
    const untouched = yield* observeEnvironmentVariable(foreign.id);
    expect(untouched.valueKid).toBe(foreign.valueKid);
    expect(untouched.updatedAt).toBe(foreign.updatedAt);
    expect((yield* listVariables(project.projectId)).map((variable) => variable.id)).toEqual([
      foreign.id,
    ]);

    // Project deletion removes the foreign variable with it.
    yield* stack.destroy();
    yield* expectEnvironmentVariableGone(foreign.id);
    yield* expectProjectGone(project.projectId);
  }),
  { tags, timeout: 180_000 },
);
