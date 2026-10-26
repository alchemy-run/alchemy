import {
  Application,
  ApplicationActivation,
  ApplicationProvider,
} from "@alchemy.run/celld/Application";
import { makeCelldVirtualEntry } from "@alchemy.run/celld/FleetEntry";
import { FleetStorage } from "@alchemy.run/celld/FleetStorage";
import { Providers } from "@alchemy.run/celld/Providers";
import {
  Worker,
  type CelldWorker,
  type CelldWorkerAttributes,
  type CelldWorkerResourceProps,
} from "@alchemy.run/celld/Worker";
import { CelldWorkerProvider } from "@alchemy.run/celld/WorkerProvider";
import { expect } from "@alchemy.run/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { isResolved, stripEffects } from "alchemy/Diff";
import * as Output from "alchemy/Output";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { Stack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as Test from "alchemy/Test/Alchemy";
import { scratchStack } from "alchemy/Test/Core";
import type { DurableObjectExport } from "alchemy/Workers/DurableObject";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { makeStore } from "./DeploymentStore.ts";

const { test } = Test.make({ providers: Layer.empty });
const WorkerResource =
  Resource<
    Resource<
      CelldWorker["Type"],
      CelldWorker["Props"],
      CelldWorker["Attributes"],
      CelldWorker["Binding"],
      Providers
    >
  >("Celld.Worker");
const ApplicationResource =
  Resource<
    Resource<
      Application["Type"],
      Application["Props"],
      Application["Attributes"],
      Application["Binding"],
      Providers
    >
  >("Celld.Application");
const connection = {
  fleetId: "Cells",
  fleetUrl: "http://fleet.invalid",
  bucket: { uri: "s3://worker-diff-test" },
  fleetSecret: Redacted.make("worker-diff-test-secret"),
};
const exports = {
  Probe: {
    kind: "durableObject",
    constructor: Effect.die("Export constructors must not execute during diff"),
    services: Context.empty(),
  } satisfies DurableObjectExport,
};
test(
  "runtime export Effects do not change generated Durable Object and Workflow class metadata",
  Effect.sync(() => {
    const metadata = {
      ...exports,
      Job: { kind: "Celld.WorkflowExport", run: () => Effect.void },
    };
    const stack = { name: "WorkerDiff", stage: "test" };
    const normalized = stripEffects(metadata);
    expect(isResolved(normalized)).toBe(true);
    const entry = makeCelldVirtualEntry(normalized, stack)("./worker.ts");
    expect(entry).toBe(makeCelldVirtualEntry(metadata, stack)("./worker.ts"));
    expect(entry).toContain('fleet.durableObject("Probe")');
    expect(entry).toContain('fleet.workflow("Job")');
  }),
  { tags: ["unit", "local", "provider:celld"] },
);

const reference = (worker: CelldWorker) => ({
  workerName: worker.workerName,
  fleetId: worker.fleetId,
  stagedManifestKey: worker.stagedManifestKey,
  url: worker.url,
});

const output: CelldWorkerAttributes = {
  ...connection,
  workerName: "root",
  url: connection.fleetUrl,
  hostState: undefined,
  deploymentId: "first",
  versionId: "first",
  prefix: "deploy/root/first",
  stagedManifestKey: "candidate-first.json",
  durableObjectClasses: {},
  migrations: [],
  code: { hash: "first" },
};

test(
  "source-only Worker changes update the Application graph and unchanged sources stay noop",
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({
      prefix: "celld-worker-diff-",
    });
    yield* fs.writeFileString(path.join(directory, "package.json"), "{}");
    yield* fs.writeFileString(
      path.join(directory, "root.js"),
      'export default { fetch() { return new Response("root-first"); } };',
    );
    yield* fs.writeFileString(
      path.join(directory, "jobs.js"),
      'import value from "./value.js"; export default { fetch() { return new Response(value); } };',
    );
    yield* fs.writeFileString(path.join(directory, "value.js"), 'export default "jobs-first";');
    yield* fs.makeDirectory(path.join(directory, "public"));
    yield* fs.writeFileString(path.join(directory, "public", "hello.txt"), "asset-first");
    const fake = yield* makeStore;
    const activations: string[] = [];
    const services = Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(FleetStorage, () => Effect.succeed(fake.store)),
      Layer.succeed(ApplicationActivation, {
        activate: (_connection, _root, _workers, revision) =>
          Effect.sync(() => {
            activations.push(revision);
          }),
      }),
    );
    const providers = Layer.effect(Providers, Provider.collection([Worker, Application])).pipe(
      Layer.provide(Layer.mergeAll(CelldWorkerProvider(), ApplicationProvider())),
      Layer.provideMerge(services),
    );
    const stack = scratchStack({ providers }, "CelldWorkerSourceDiff");
    const rootProps: CelldWorkerResourceProps = {
      ...connection,
      main: path.join(directory, "root.js"),
      isExternal: true,
      assets: { directory: "public" },
      exports,
    };
    expect(isResolved(rootProps)).toBe(false);
    const program = (env?: Record<string, string>) =>
      Effect.gen(function* () {
        const root = yield* WorkerResource("Root", { ...rootProps, env });
        const jobs = yield* WorkerResource("Jobs", {
          ...connection,
          main: path.join(directory, "jobs.js"),
          isExternal: true,
          exports,
        });
        const application = yield* ApplicationResource("App", {
          ...connection,
          entrypoint: reference(root),
          workers: [reference(jobs)],
        });
        return { root, jobs, application };
      });
    yield* stack.destroy();
    const first = yield* stack.deploy(program());
    const unchanged = yield* stack.plan(program());
    for (const id of ["Root", "Jobs", "App"]) expect(unchanged.resources[id].action).toBe("noop");
    expect(activations).toHaveLength(1);

    yield* fs.writeFileString(path.join(directory, "value.js"), 'export default "jobs-second";');
    const importedChange = yield* stack.plan(program());
    expect(importedChange.resources.Root.action).toBe("noop");
    expect(importedChange.resources.Jobs.action).toBe("update");
    expect(importedChange.resources.App.action).toBe("update");
    const second = yield* stack.deploy(program());
    expect(second.root.code.hash).toBe(first.root.code.hash);
    expect(second.jobs.code.hash).not.toBe(first.jobs.code.hash);
    expect(second.application.revision).not.toBe(first.application.revision);
    expect(second.application.candidates).toEqual([
      second.root.stagedManifestKey,
      second.jobs.stagedManifestKey,
    ]);
    expect(activations).toHaveLength(2);
    const repeated = yield* stack.plan(program());
    for (const id of ["Root", "Jobs", "App"]) expect(repeated.resources[id].action).toBe("noop");

    yield* fs.writeFileString(
      path.join(directory, "root.js"),
      'export default { fetch() { return new Response("root-second"); } };',
    );
    const entryChange = yield* stack.plan(program());
    expect(entryChange.resources.Root.action).toBe("update");
    expect(entryChange.resources.Jobs.action).toBe("noop");
    expect(entryChange.resources.App.action).toBe("update");
    const third = yield* stack.deploy(program());
    expect(third.root.code.hash).not.toBe(second.root.code.hash);
    expect(third.application.revision).not.toBe(second.application.revision);

    yield* fs.writeFileString(path.join(directory, "public", "hello.txt"), "asset-second");
    const assetsChange = yield* stack.plan(program());
    expect(assetsChange.resources.Root.action).toBe("update");
    expect(assetsChange.resources.App.action).toBe("update");
    const fourth = yield* stack.deploy(program());
    expect(fourth.root.code.hash).toBe(third.root.code.hash);
    expect(fourth.root.code.assetsHash).not.toBe(third.root.code.assetsHash);
    expect(fourth.application.revision).not.toBe(third.application.revision);

    const propsChange = yield* stack.plan(program({ VALUE: "changed" }));
    expect(propsChange.resources.Root.action).toBe("update");
    expect(propsChange.resources.App.action).toBe("update");
    yield* stack.deploy(program({ VALUE: "changed" }));
    const final = yield* stack.plan(program({ VALUE: "changed" }));
    for (const id of ["Root", "Jobs", "App"]) expect(final.resources[id].action).toBe("noop");
    yield* stack.destroy();
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { tags: ["unit", "local", "provider:celld"], timeout: 120_000 },
);
