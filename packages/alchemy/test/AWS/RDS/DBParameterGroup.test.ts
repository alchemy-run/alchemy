import * as AWS from "@/AWS";
import { DBParameterGroup } from "@/AWS/RDS/DBParameterGroup.ts";
import * as Drift from "@/Drift.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as rds from "@distilled.cloud/aws/rds";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: AWS.providers() });

/** The parameters RDS reports as user-set, which is what the resource owns. */
const userParameters = Effect.fn(function* (name: string) {
  const pages = yield* rds.describeDBParameters
    .pages({ DBParameterGroupName: name, Source: "user" })
    .pipe(Stream.runCollect);
  return Object.fromEntries(
    Array.from(pages)
      .flatMap((page) => page.Parameters ?? [])
      .flatMap((p) =>
        p.ParameterName && p.ParameterValue !== undefined
          ? [[p.ParameterName, p.ParameterValue] as const]
          : [],
      ),
  );
});

const groupParameters = Effect.fn(function* (name: string) {
  const pages = yield* rds.describeDBParameters
    .pages({ DBParameterGroupName: name })
    .pipe(Stream.runCollect);
  return new Map(
    Array.from(pages).flatMap((page) =>
      (page.Parameters ?? []).flatMap((parameter) =>
        parameter.ParameterName === undefined
          ? []
          : [[parameter.ParameterName, parameter] as const],
      ),
    ),
  );
});

const waitForParameters = Effect.fn(function* (
  name: string,
  ready: (parameters: Map<string, rds.Parameter>) => boolean,
) {
  const parameters = yield* groupParameters(name).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      times: 8,
      until: ready,
    }),
  );
  expect(ready(parameters)).toBe(true);
  return parameters;
});

const modifyParameters = (name: string, parameters: rds.Parameter[]) =>
  rds
    .modifyDBParameterGroup({
      DBParameterGroupName: name,
      Parameters: parameters,
    })
    .pipe(
      Effect.retry({
        while: (error) => error._tag === "InvalidDBParameterGroupStateFault",
        schedule: Schedule.spaced("3 seconds"),
        times: 8,
      }),
    );

const resetParameters = (name: string, parameters: rds.Parameter[]) =>
  rds
    .resetDBParameterGroup({
      DBParameterGroupName: name,
      ResetAllParameters: false,
      Parameters: parameters,
    })
    .pipe(
      Effect.retry({
        while: (error) => error._tag === "InvalidDBParameterGroupStateFault",
        schedule: Schedule.spaced("3 seconds"),
        times: 8,
      }),
    );

const assertGroupGone = Effect.fn(function* (name: string) {
  const gone = yield* rds
    .describeDBParameterGroups({
      DBParameterGroupName: name,
    })
    .pipe(
      Effect.as(false),
      Effect.catchTag("DBParameterGroupNotFoundFault", () =>
        Effect.succeed(true),
      ),
      Effect.repeat({
        schedule: Schedule.spaced("3 seconds"),
        times: 8,
        until: (gone) => gone,
      }),
    );
  expect(gone).toBe(true);
});

// Canonical `list()` test (AWS account/region-scoped collection). Parameter
// groups create and delete fast (well within the 240s budget), so we deploy a
// real group, resolve the provider via the typed `Provider.findProvider(
// DBParameterGroup)` so `list()`'s element type is the exact
// `DBParameterGroup["Attributes"]` shape, call it, and assert the deployed
// group appears in the exhaustively-paginated result.
test.provider("list enumerates the deployed DB parameter group", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const group = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* DBParameterGroup("ListDBParameterGroup", {
          dbParameterGroupName: "alchemy-test-dbpg-list",
          family: "aurora-postgresql16",
          description: "Alchemy list() test parameter group",
        });
      }),
    );

    const provider = yield* Provider.findProvider(DBParameterGroup);
    const all = yield* provider.list();

    expect(Array.isArray(all)).toBe(true);
    expect(
      all.some((g) => g.dbParameterGroupName === group.dbParameterGroupName),
    ).toBe(true);

    for (const g of all) {
      expect(typeof g.dbParameterGroupName).toBe("string");
      expect(typeof g.family).toBe("string");
    }

    yield* stack.destroy();
  }),
);

// Parameters reconcile in place: a redeploy writes changed values and resets
// keys the props dropped, both diffed against live `Source=user` state rather
// than the prior props.
test.provider("parameters are written, updated and reset", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const name = "alchemy-test-dbpg-params";
    const deploy = (parameters: Record<string, string>) =>
      stack.deploy(
        Effect.gen(function* () {
          return yield* DBParameterGroup("ParamsDBParameterGroup", {
            dbParameterGroupName: name,
            family: "mysql8.4",
            description: "Alchemy parameters test parameter group",
            parameters,
          });
        }),
      );

    const created = yield* deploy({
      time_zone: "Australia/Sydney",
      max_connections: "150",
    });
    expect(created.parameters.time_zone).toBe("Australia/Sydney");

    const afterCreate = yield* userParameters(name);
    expect(afterCreate.time_zone).toBe("Australia/Sydney");
    expect(afterCreate.max_connections).toBe("150");

    // time_zone changes; max_connections is dropped and must go back to the
    // engine default, which removes it from Source=user entirely.
    yield* deploy({ time_zone: "UTC" });

    const afterUpdate = yield* userParameters(name);
    expect(afterUpdate.time_zone).toBe("UTC");
    expect(afterUpdate.max_connections).toBeUndefined();

    yield* stack.destroy();
  }),
);

test.provider(
  "PR1589 adoption resets undeclared overrides to the same defaults as creation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = "alchemy-test-pr1589-adopt-parameters";
      yield* rds.createDBParameterGroup({
        DBParameterGroupName: name,
        DBParameterGroupFamily: "postgres16",
        Description: "Desired-state adoption regression",
      });
      yield* modifyParameters(name, [
        {
          ParameterName: "work_mem",
          ParameterValue: "8192",
          ApplyMethod: "immediate",
        },
      ]);
      yield* waitForParameters(
        name,
        (parameters) => parameters.get("work_mem")?.ParameterValue === "8192",
      );
      const program = DBParameterGroup("AdoptedParameters1589", {
        dbParameterGroupName: name,
        family: "postgres16",
        description: "Desired-state adoption regression",
      });
      const adopted = yield* stack.deploy(program);
      expect(adopted.parameters).toEqual({});
      expect(yield* userParameters(name)).toEqual({});
      expect(
        (yield* stack.plan(program)).resources.AdoptedParameters1589?.action,
      ).toBe("noop");
      yield* stack.destroy();
      yield* assertGroupGone(name);
    }),
  { timeout: 120_000 },
);

test.provider(
  "PR1589 resets omitted overrides and observes settled modify/reset outputs",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const program = (parameters?: Record<string, string>) =>
        DBParameterGroup("ObservedParameters1589", {
          family: "postgres16",
          parameters,
        });
      const created = yield* stack.deploy(program());
      const name = created.dbParameterGroupName;
      const defaults = yield* groupParameters(name);
      expect(defaults.get("max_connections")?.ApplyType).toBe("static");
      expect(defaults.get("work_mem")?.ApplyType).toBe("dynamic");

      yield* modifyParameters(name, [
        {
          ParameterName: "work_mem",
          ParameterValue: "8192",
          ApplyMethod: "immediate",
        },
        {
          ParameterName: "max_connections",
          ParameterValue: "200",
          ApplyMethod: "pending-reboot",
        },
      ]);
      yield* waitForParameters(
        name,
        (parameters) =>
          parameters.get("work_mem")?.ParameterValue === "8192" &&
          parameters.get("max_connections")?.ParameterValue === "200",
      );
      const overrides = { work_mem: "8192", max_connections: "200" };
      expect(yield* userParameters(name)).toEqual(overrides);

      const plan = yield* stack.plan(program());
      expect(plan.resources.ObservedParameters1589?.action).toBe("update");
      const observed = yield* stack.deploy(program());
      expect(observed.parameters).toEqual({});
      expect(yield* userParameters(name)).toEqual({});
      const settled = yield* stack.plan(program());
      expect(settled.resources.ObservedParameters1589?.action).toBe("noop");
      const refreshed = yield* Drift.detect({
        name: stack.name,
        stage: stack.stage,
      }).pipe(Effect.provide(stack.state));
      expect(refreshed.resources.ObservedParameters1589).toMatchObject({
        action: "unchanged",
        attr: { parameters: {} },
      });

      const changed = yield* stack.deploy(
        program({ work_mem: "16384", max_connections: "250" }),
      );
      expect(changed.dbParameterGroupName).toBe(name);
      expect(changed.dbParameterGroupArn).toBe(created.dbParameterGroupArn);
      expect(changed.parameters).toEqual({
        work_mem: "16384",
        max_connections: "250",
      });
      // No test-side wait: reconcile must return observed, settled group values.
      expect(yield* userParameters(name)).toEqual(changed.parameters);
      const resetStatic = yield* stack.deploy(program({ work_mem: "16384" }));
      expect(resetStatic.parameters).toEqual({ work_mem: "16384" });
      expect(yield* userParameters(name)).toEqual(resetStatic.parameters);
      const afterReset = (yield* groupParameters(name)).get("max_connections");
      expect(afterReset?.Source).toBe(defaults.get("max_connections")?.Source);
      expect(afterReset?.ParameterValue).toBe(
        defaults.get("max_connections")?.ParameterValue,
      );

      const cleared = yield* stack.deploy(program());
      expect(cleared.parameters).toEqual({});
      expect(yield* userParameters(name)).toEqual({});
      expect(
        (yield* groupParameters(name)).get("work_mem")?.ParameterValue,
      ).toBe(defaults.get("work_mem")?.ParameterValue);
      yield* stack.destroy();
      yield* assertGroupGone(name);
    }),
  { timeout: 120_000 },
);

test.provider(
  "PR1589 refresh retains managed defaults after an out-of-band reset",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const program = (parameters?: Record<string, string>) =>
        DBParameterGroup("DefaultParameters1589", {
          family: "postgres16",
          parameters,
        });
      const created = yield* stack.deploy(program());
      const name = created.dbParameterGroupName;
      const defaults = yield* groupParameters(name);
      const parameter = defaults.get("log_autovacuum_min_duration");
      expect(parameter?.Source).toBe("engine-default");
      expect(parameter?.ApplyType).toBe("dynamic");
      expect(parameter?.IsModifiable).toBe(true);
      if (parameter?.ParameterValue === undefined) {
        return yield* Effect.fail(
          new Error(
            "RDS did not report the log_autovacuum_min_duration default",
          ),
        );
      }
      const desired = { log_autovacuum_min_duration: parameter.ParameterValue };
      const managed = yield* stack.deploy(program(desired));
      expect(managed.parameters).toEqual(desired);
      expect(
        (yield* groupParameters(name)).get("log_autovacuum_min_duration")
          ?.Source,
      ).toBe("engine-default");
      const initial = yield* Drift.detect({
        name: stack.name,
        stage: stack.stage,
      }).pipe(Effect.provide(stack.state));
      expect(initial.resources.DefaultParameters1589).toMatchObject({
        action: "unchanged",
        attr: { parameters: desired },
      });

      const driftedValue =
        parameter.ParameterValue === "8192" ? "16384" : "8192";
      yield* modifyParameters(name, [
        {
          ParameterName: "log_autovacuum_min_duration",
          ParameterValue: driftedValue,
          ApplyMethod: "immediate",
        },
        {
          ParameterName: "max_connections",
          ParameterValue: "200",
          ApplyMethod: "pending-reboot",
        },
      ]);
      yield* waitForParameters(
        name,
        (parameters) =>
          parameters.get("log_autovacuum_min_duration")?.ParameterValue ===
            driftedValue &&
          parameters.get("max_connections")?.ParameterValue === "200",
      );
      const drift = yield* Drift.detect({
        name: stack.name,
        stage: stack.stage,
      }).pipe(Effect.provide(stack.state));
      expect(drift.resources.DefaultParameters1589?.attr.parameters).toEqual({
        log_autovacuum_min_duration: driftedValue,
        max_connections: "200",
      });

      yield* resetParameters(name, [
        {
          ParameterName: "log_autovacuum_min_duration",
          ApplyMethod: "immediate",
        },
      ]);
      yield* waitForParameters(
        name,
        (parameters) =>
          parameters.get("log_autovacuum_min_duration")?.Source ===
            "engine-default" &&
          parameters.get("log_autovacuum_min_duration")?.ParameterValue ===
            desired.log_autovacuum_min_duration,
      );
      const reset = yield* Drift.detect({
        name: stack.name,
        stage: stack.stage,
      }).pipe(Effect.provide(stack.state));
      expect(reset.resources.DefaultParameters1589?.attr.parameters).toEqual({
        ...desired,
        max_connections: "200",
      });
      expect(yield* userParameters(name)).toEqual({ max_connections: "200" });
      yield* stack.destroy();
      yield* assertGroupGone(name);
    }),
  { timeout: 120_000 },
);
