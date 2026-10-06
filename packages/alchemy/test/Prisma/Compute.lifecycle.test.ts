import {
  createEnvironmentVariable,
  createService,
  deleteService,
  getDeployment,
  getProject,
  getServiceDeployments,
  getServices,
} from "@distilled.cloud/prisma/management";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { adopt, OwnedBySomeoneElse } from "@/AdoptPolicy";
import * as Prisma from "@/Prisma";
import type { ComputeProps } from "@/Prisma/Compute";
import * as Test from "@/Test/Alchemy";
import { Api, ComputeBuildProject } from "./fixtures/ComputeEffectApp.ts";
import EffectDefaultApp from "./fixtures/ComputeEffectDefaultApp.ts";
import {
  environmentKeys,
  expectDeploymentGone,
  expectServes,
  expectServiceGone,
  restoreState,
  snapshotState,
  writeServerApp,
  writeServerArtifact,
} from "./fixtures/ComputeLive.ts";
import { expectProjectGone, failureOf, forgetState } from "./fixtures/Live.ts";

const { test } = Test.make({ providers: Prisma.providers() });

const liveTags = [
  "provider:prisma",
  "provider:prisma:compute",
  "provider:prisma:branch",
  "provider:prisma:project",
  "live",
];

const effectApp = `${import.meta.dirname}/fixtures/ComputeEffectApp.ts`;

type AppProps = Omit<ComputeProps, "project">;

test.provider(
  "rejects invalid Compute props before any cloud mutation",
  Effect.fn(function* (stack: Test.ScratchStack) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* stack.destroy();

    const project = Prisma.Project("Project", { createDatabase: false });
    const { projectId } = yield* stack.deploy(project);

    const external = (props: AppProps) =>
      Effect.gen(function* () {
        yield* Prisma.Compute("App", { project: yield* project, appName: "invalid", ...props });
      });
    const effectNative = (props: AppProps) =>
      Effect.gen(function* () {
        yield* Prisma.Compute(
          "App",
          { project: yield* project, appName: "invalid", ...props },
          Effect.void,
        );
      });
    const expectRejected = (program: Effect.Effect<void, never, any>, message: string) =>
      failureOf(stack.deploy(program)).pipe(
        Effect.tap((failed) => Effect.sync(() => expect(failed.text).toContain(message))),
      );

    const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-prisma-compute-invalid-" });

    yield* expectRejected(
      external({ skipPromote: true, destroyOldDeployment: true }),
      "destroyOldDeployment cannot be combined with skipPromote",
    );
    yield* expectRejected(
      external({ start: false, skipPromote: true, healthCheck: { path: "/health" } }),
      "healthCheck requires start to be enabled",
    );
    yield* expectRejected(external({ start: false }), "start: false requires skipPromote: true");
    yield* expectRejected(
      external({ branchId: "branch-1", branchGitName: "main" }),
      "branchId and branchGitName are mutually exclusive",
    );
    for (const props of [
      { port: 0 },
      { port: 65_536 },
      { port: 1.5 },
      { dev: { port: Number.NaN } },
    ]) {
      yield* expectRejected(external(props), "must be an integer between 1 and 65535");
    }
    // `null` is outside the declared prop types; it reaches the provider from
    // untyped configuration.
    for (const props of [{ branchId: null }, { branchGitName: null }]) {
      yield* expectRejected(external(props as unknown as AppProps), "requires an attached branch");
    }
    yield* expectRejected(
      external({ skipCodeUpload: true, start: false, skipPromote: true }),
      "skipCodeUpload requires an existing Prisma deployment",
    );
    yield* expectRejected(effectNative({}), "Effect-native Prisma Compute apps require `main`");
    yield* expectRejected(
      effectNative({ main: effectApp, build: { command: "bun run build", outdir: "dist" } }),
      "Effect-native Prisma Compute apps cannot use build",
    );
    yield* expectRejected(
      effectNative({ main: effectApp, handler: "Api;console.log('nope')" }),
      "handler must be `default` or a valid JavaScript export identifier",
    );
    yield* expectRejected(
      external({ path: root, entrypoint: "server.ts", env: { "bad-key": "secret" } }),
      "must match POSIX env-var key shape",
    );
    yield* expectRejected(
      external({
        path: root,
        build: {
          command: "mkdir -p dist; printf '123456789'",
          outdir: "dist",
          entrypoint: "server.js",
          outputLimitBytes: 8,
        },
      }),
      "Build stdout exceeded the 8 byte output safety limit",
    );
    // Artifact resolution fails before the App or any variable is written.
    const missing = yield* failureOf(
      stack.deploy(
        external({
          artifactPath: path.join(root, "missing-artifact.tar.gz"),
          env: { TOKEN: "secret" },
        }),
      ),
    );
    expect(missing.errors.length).toBeGreaterThan(0);

    expect((yield* getServices({ projectId, limit: 100 })).data).toEqual([]);
    expect(yield* environmentKeys(projectId, "production")).toEqual([]);

    yield* stack.destroy();
    yield* expectProjectGone(projectId);
  }),
  { tags: liveTags, timeout: 180_000 },
);

test.provider(
  "deploys a prebuilt artifact, plans updates, refuses foreign env and lost state, and deletes its env on removal",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();
    const artifactPath = yield* writeServerArtifact("alchemy-prisma-compute-artifact-");
    const secret = "artifact-secret-value";

    const program = (
      options: {
        app?: false | AppProps;
        target?: "Project" | "Other";
        adoptApp?: boolean;
      } = {},
    ) =>
      Effect.gen(function* () {
        const project = yield* Prisma.Project("Project", { createDatabase: false });
        const other = yield* Prisma.Project("Other", { createDatabase: false });
        const preview = yield* Prisma.Branch("Preview", { project });
        if (options.app === false) return { project, other, preview, app: undefined };
        // A fixed App name: a generated one embeds the instance ID, which
        // lost state does not keep, so the App could never be found again.
        const app = yield* Prisma.Compute("App", {
          project: options.target === "Other" ? other : project,
          artifactPath,
          appName: "artifact-app",
          env: { GREETING: "from-artifact", TOKEN: Redacted.make(secret) },
          healthCheck: { path: "/health" },
          timeoutSeconds: 240,
          ...options.app,
        }).pipe(adopt(options.adoptApp ?? false));
        return { project, other, preview, app };
      });

    const deployed = yield* stack.deploy(program());
    const app = deployed.app!;
    const projectId = deployed.project.projectId;
    expect(app.projectId).toBe(projectId);
    expect(app.promoted).toBe(true);
    expect(app.environmentKeys).toEqual(["GREETING", "TOKEN"]);
    expect(JSON.stringify(app)).not.toContain(secret);
    yield* expectServes(`${app.url}/`, "from-artifact");
    yield* expectServes(`${app.url}/env?key=TOKEN`, secret);
    expect(yield* environmentKeys(projectId, "production")).toEqual(["GREETING", "TOKEN"]);

    // Source can change without a prop change, so unchanged props update.
    const unchanged = yield* stack.plan(program());
    expect(unchanged.resources.App).toMatchObject({ action: "update" });
    // The App region is immutable and cannot move in place.
    const region = app.regionId === "us-east-1" ? "eu-central-1" : "us-east-1";
    const moved = yield* failureOf(stack.plan(program({ app: { regionId: region } })));
    expect(moved.text).toContain("cannot be changed atomically");
    // A different project is a separate uniqueness scope: replace.
    const rehomed = yield* stack.plan(program({ target: "Other" }));
    expect(rehomed.resources.App).toMatchObject({ action: "replace" });

    // A foreign variable in the same scope is refused before any write.
    yield* createEnvironmentVariable({
      projectId,
      class: "production",
      key: "FOREIGN_KEY",
      value: "foreign",
    });
    const foreign = yield* failureOf(
      stack.deploy(
        program({
          app: { env: { GREETING: "changed", TOKEN: Redacted.make(secret), FOREIGN_KEY: "mine" } },
        }),
      ),
    );
    expect(foreign.text).toContain("is not owned by this Compute resource");
    expect(yield* environmentKeys(projectId, "production")).toEqual([
      "FOREIGN_KEY",
      "GREETING",
      "TOKEN",
    ]);
    expect(
      (yield* getServiceDeployments({ serviceId: app.appId })).data.map(({ id }) => id),
    ).toEqual([app.deploymentId]);

    // Lost state: the App is found by name on the desired branch only.
    const row = yield* snapshotState(stack, "App");
    const decoy = (yield* createService({
      projectId,
      displayName: app.appName,
      branchId: deployed.preview.branchId,
    })).data;
    yield* forgetState(stack, "App");
    const refused = yield* failureOf(stack.plan(program()));
    expect(refused.errors.some((error) => error instanceof OwnedBySomeoneElse)).toBe(true);
    const adopted = yield* stack.plan(program({ adoptApp: true }));
    expect(adopted.resources.App).toMatchObject({
      state: {
        attr: {
          appId: app.appId,
          deploymentId: app.deploymentId,
          promoted: true,
          url: app.url,
        },
      },
    });
    yield* deleteService({ serviceId: decoy.id });
    yield* restoreState(stack, "App", row);

    // Removing the App deletes it and the variables it owns, not foreign ones.
    yield* stack.deploy(program({ app: false }));
    yield* expectServiceGone(app.appId);
    expect(yield* environmentKeys(projectId, "production")).toEqual(["FOREIGN_KEY"]);
    expect((yield* getProject({ id: projectId })).data.id).toBe(projectId);

    yield* stack.destroy();
    yield* expectProjectGone(projectId);
    yield* expectProjectGone(deployed.other.projectId);
  }),
  { tags: liveTags, timeout: 240_000 },
);

test.provider(
  "syncs env through new versions, destroys old deployments, and previews unpromoted versions",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();
    const appDir = yield* writeServerApp("alchemy-prisma-compute-versions-");

    const program = (props: AppProps) =>
      Effect.gen(function* () {
        const project = yield* Prisma.Project("Project", { createDatabase: false });
        const app = yield* Prisma.Compute("App", {
          project,
          path: appDir,
          entrypoint: "server.ts",
          healthCheck: { path: "/health" },
          timeoutSeconds: 240,
          ...props,
        });
        return { project, app };
      });

    const first = yield* stack.deploy(program({ env: { GREETING: "one", REMOVE_ME: "soon" } }));
    const projectId = first.project.projectId;
    const stableUrl = first.app.url!;
    expect(first.app.promoted).toBe(true);
    expect(first.app.previousDeploymentId).toBeNull();
    yield* expectServes(`${stableUrl}/`, "one");
    expect(yield* environmentKeys(projectId, "production")).toEqual(["GREETING", "REMOVE_ME"]);

    // An env-only change forks the live code into a new version; unpromoted,
    // it is reachable only at its preview URL.
    const preview = yield* stack.deploy(
      program({ env: { GREETING: "two" }, skipCodeUpload: true, skipPromote: true }),
    );
    expect(preview.app.appId).toBe(first.app.appId);
    expect(preview.app.deploymentId).not.toBe(first.app.deploymentId);
    expect(preview.app.promoted).toBe(false);
    expect(preview.app.url).toBe(preview.app.deploymentUrl);
    expect(preview.app.url).not.toBe(stableUrl);
    expect(preview.app.previousDeploymentId).toBe(first.app.deploymentId);
    expect(preview.app.previousDeploymentAction).toBe("still-active");
    expect(preview.app.environmentKeys).toEqual(["GREETING"]);
    expect(yield* environmentKeys(projectId, "production")).toEqual(["GREETING"]);
    yield* expectServes(`${preview.app.url}/`, "two");
    yield* expectServes(`${preview.app.url}/env?key=REMOVE_ME`, "missing");
    // The promoted version keeps the environment it was created with.
    yield* expectServes(`${stableUrl}/`, "one");

    // Promoting the next fork destroys the version it displaces. (Forking
    // again after that would fail: Prisma returns HTTP 500 for a
    // skipCodeUpload create once the uploaded source deployment is deleted.)
    const promoted = yield* stack.deploy(
      program({ env: { GREETING: "three" }, skipCodeUpload: true, destroyOldDeployment: true }),
    );
    expect(promoted.app.promoted).toBe(true);
    expect(promoted.app.url).toBe(stableUrl);
    expect(promoted.app.previousDeploymentId).toBe(first.app.deploymentId);
    expect(promoted.app.previousDeploymentAction).toBe("destroyed");
    yield* expectDeploymentGone(first.app.deploymentId!);
    yield* expectServes(`${stableUrl}/`, "three");

    yield* stack.destroy();
    yield* expectServiceGone(first.app.appId);
    yield* expectProjectGone(projectId);
  }),
  { tags: liveTags, timeout: 240_000 },
);

test.provider(
  "merges binding env, moves the env scope with the branch, and deletes it on removal",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();
    const appDir = yield* writeServerApp("alchemy-prisma-compute-branch-");

    const program = (options: { app: boolean; onPreview?: boolean; binding?: boolean }) =>
      Effect.gen(function* () {
        const project = yield* Prisma.Project("Project", { createDatabase: false });
        const preview = yield* Prisma.Branch("Preview", { project });
        if (!options.app) return { project, preview, app: undefined };
        const app = yield* Prisma.Compute("App", {
          project,
          path: appDir,
          entrypoint: "server.ts",
          timeoutSeconds: 240,
          destroyOldDeployment: true,
          env: { EXPLICIT: "explicit", OVERRIDE: "explicit", DROPPED: null },
          ...(options.onPreview ? { branchId: preview.branchId } : {}),
        });
        if (options.binding) {
          yield* app.bind("Extra", {
            env: { OVERRIDE: "binding", BOUND: "bound", DROPPED: "binding" },
          });
        }
        return { project, preview, app };
      });

    const first = yield* stack.deploy(program({ app: true, binding: true }));
    const app = first.app!;
    const projectId = first.project.projectId;
    const previewId = first.preview.branchId;
    expect(app.environmentClass).toBe("production");
    expect(app.environmentBranchId).toBeNull();
    // Explicit env wins over bindings, including a null tombstone.
    expect(app.environmentKeys).toEqual(["BOUND", "EXPLICIT", "OVERRIDE"]);
    expect(yield* environmentKeys(projectId, "production")).toEqual([
      "BOUND",
      "EXPLICIT",
      "OVERRIDE",
    ]);
    yield* expectServes(`${app.url}/env?key=OVERRIDE`, "explicit");
    yield* expectServes(`${app.url}/env?key=BOUND`, "bound");

    // Same code on another branch is a new version with a preview env scope.
    const moved = yield* stack.deploy(program({ app: true, onPreview: true }));
    expect(moved.app!.appId).toBe(app.appId);
    expect(moved.app!.deploymentId).not.toBe(app.deploymentId);
    expect(moved.app!.environmentClass).toBe("preview");
    expect(moved.app!.environmentBranchId).toBe(previewId);
    expect(moved.app!.environmentKeys).toEqual(["EXPLICIT", "OVERRIDE"]);
    expect(yield* environmentKeys(projectId, "production")).toEqual([]);
    expect(yield* environmentKeys(projectId, "preview", previewId)).toEqual([
      "EXPLICIT",
      "OVERRIDE",
    ]);

    // Removing the App deletes the preview-scoped variables it owns.
    yield* stack.deploy(program({ app: false }));
    yield* expectServiceGone(app.appId);
    expect(yield* environmentKeys(projectId, "preview", previewId)).toEqual([]);

    yield* stack.destroy();
    yield* expectProjectGone(projectId);
  }),
  { tags: liveTags, timeout: 240_000 },
);

test.provider(
  "builds with a command, auto-builds a Bun app, and serves effect-native named and default exports",
  Effect.fn(function* (stack: Test.ScratchStack) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* stack.destroy();
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-prisma-compute-build-" });
    yield* fs.writeFileString(
      path.join(root, "build.sh"),
      [
        "mkdir -p dist",
        "cat > dist/server.js <<EOF",
        'Bun.serve({ port: 4567, fetch: () => new Response("$BUILD_GREETING") });',
        "EOF",
        "",
      ].join("\n"),
    );
    yield* fs.makeDirectory(path.join(root, "src"));
    yield* fs.writeFileString(
      path.join(root, "package.json"),
      JSON.stringify({ type: "module", main: "src/server.ts" }),
    );
    yield* fs.writeFileString(
      path.join(root, "src", "server.ts"),
      'Bun.serve({ port: 8080, fetch: () => new Response("auto app") });\n',
    );

    const program = (build: ComputeProps["build"], port?: number) =>
      Effect.gen(function* () {
        const project = yield* ComputeBuildProject;
        const built = yield* Prisma.Compute("Built", {
          project,
          path: root,
          build,
          ...(port === undefined ? {} : { port }),
          timeoutSeconds: 240,
          destroyOldDeployment: true,
        });
        const effect = yield* Api;
        const effectDefault = yield* EffectDefaultApp;
        return { project, built, effect, effectDefault };
      });

    const first = yield* stack.deploy(
      program(
        {
          command: "sh build.sh",
          outdir: "dist",
          entrypoint: "server.js",
          env: { BUILD_GREETING: "hello-build" },
        },
        4567,
      ),
    );
    yield* expectServes(`${first.built.url}/`, "hello-build");
    yield* expectServes(`${first.effect.url}/`, `effect-native-ok ${stack.name}/${stack.stage}`);
    // The default export is bundled and served on its declared port.
    expect(
      (yield* getDeployment({ deploymentId: first.effectDefault.deploymentId! })).data.portMapping,
    ).toEqual({ http: 4555 });
    yield* expectServes(`${first.effectDefault.url}/`, "effect-native-default-ok");

    const second = yield* stack.deploy(program("auto"));
    expect(second.built.appId).toBe(first.built.appId);
    expect(second.built.deploymentId).not.toBe(first.built.deploymentId);
    yield* expectServes(`${second.built.url}/`, "auto app");

    yield* stack.destroy();
    yield* expectServiceGone(first.built.appId);
    yield* expectServiceGone(first.effect.appId);
    yield* expectServiceGone(first.effectDefault.appId);
    yield* expectProjectGone(first.project.projectId);
  }),
  { tags: liveTags, timeout: 240_000 },
);
