import {
  activateVersion,
  ComputeService,
  ComputeServiceProvider,
} from "@alchemy.run/prisma/ComputeService";
import { ComputeVersion, ComputeVersionProvider } from "@alchemy.run/prisma/ComputeVersion";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { isActionState, State } from "alchemy/State/State";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { type ComputeCloud, makeComputeCloud } from "./fixtures/ComputeCloud.ts";

const tags = [
  "unit",
  "local",
  "provider:prisma",
  "provider:prisma:computeservice",
  "provider:prisma:computeversion",
];

const artifactV1 = `${import.meta.dirname}/fixtures/artifact-v1.bin`;
const artifactV2 = `${import.meta.dirname}/fixtures/artifact-v2.bin`;

/** Reads one attribute of another resource, as a downstream consumer would. */
interface Reader extends Resource<"Test.Prisma.Reader", { value: unknown }, { value: unknown }> {}
const Reader = Resource<Reader>("Test.Prisma.Reader");
/** Logical IDs of every Reader reconcile, in order. */
const readerReconciles: string[] = [];
const ReaderProvider = () =>
  Provider.succeed(Reader, {
    list: () => Effect.succeed([]),
    reconcile: Effect.fn(function* ({ id, news }) {
      readerReconciles.push(id);
      return { value: news.value };
    }),
    delete: Effect.fn(function* () {}),
  });

class ActiveVersionTestProviders extends Provider.ProviderCollection<ActiveVersionTestProviders>()(
  "Prisma",
) {}

/** One fake platform per test, so tests that run at the same time never share calls. */
const harness = (options: { dev?: boolean } = {}) => {
  const cloud = makeComputeCloud();
  const dev = options.dev ?? false;
  const providers = Layer.effect(
    ActiveVersionTestProviders,
    Provider.collection([ComputeService, ComputeVersion, Reader]),
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(ComputeServiceProvider(), ComputeVersionProvider(), ReaderProvider()),
    ),
    Layer.provide(
      Layer.succeed(AlchemyContext, { dotAlchemy: ".alchemy-test", dev, adopt: false }),
    ),
    Layer.provideMerge(cloud.fake.layer),
  );
  return { cloud, test: Test.make({ providers, dev, sidecar: false }).test };
};

const checks = { urlReadinessTimeoutSeconds: 0.2, timeoutSeconds: 2, pollIntervalMs: 1 } as const;

const app = (
  options: {
    artifactPath?: string;
    activate?: boolean;
    reader?: boolean;
    start?: boolean;
    domainReader?: string;
  } = {},
) =>
  Effect.gen(function* () {
    const service = yield* ComputeService("Service", {
      project: "project-1",
      branchId: "branch-1",
      ...checks,
    });
    const version = yield* ComputeVersion("Version", {
      service: service.serviceId,
      artifactPath: options.artifactPath ?? artifactV1,
      ...(options.start === undefined ? {} : { start: options.start }),
      ...checks,
    });
    if (options.activate ?? true) yield* activateVersion(service, version);
    const reader = options.reader
      ? yield* Reader("Reader", { value: service.activeVersionId })
      : undefined;
    const domainReader = options.domainReader
      ? yield* Reader(options.domainReader, { value: service.serviceEndpointDomain })
      : undefined;
    return { service, version, reader, domainReader };
  });

const rows = (stack: Test.ScratchStack) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const fqns = yield* state.list({ stack: stack.name, stage: stack.stage });
    const result: Record<string, { resourceType: string; attr: any; props: any }> = {};
    for (const fqn of fqns) {
      const row = yield* state.get({ stack: stack.name, stage: stack.stage, fqn });
      if (row && !isActionState(row)) {
        result[fqn] = { resourceType: row.resourceType, attr: row.attr, props: row.props };
      }
    }
    return result;
  }).pipe(Effect.provide(stack.state));

const clearCalls = (cloud: ComputeCloud) =>
  Effect.sync(() => {
    cloud.fake.captured.length = 0;
  });

const firstDeploy = harness();
firstDeploy.test.provider(
  "creates the service, then the version under it, then promotes it and checks the stable URL",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = firstDeploy;
      yield* stack.destroy();

      const out = yield* stack.deploy(app());

      expect(cloud.writes()).toEqual([
        "POST /v1/services",
        "POST /v1/services/svc-1/deployments",
        "POST /v1/deployments/dep-1/start",
        "POST /v1/services/svc-1/promote",
      ]);
      expect(cloud.probes()).toEqual(["dep-1.preview.prisma.test", "svc-1.stable.prisma.test"]);
      expect(out.version.serviceId).toBe(out.service.serviceId);
      expect(out.service.activeVersionId).toBe(out.version.versionId);
      expect(out.service.url).toBe("https://svc-1.stable.prisma.test");
      expect(out.version.url).toBe("https://dep-1.preview.prisma.test");
      expect(cloud.services.get("svc-1")?.latestDeploymentId).toBe("dep-1");

      yield* stack.destroy();
      expect(cloud.services.size).toBe(0);
      expect(cloud.deployments.size).toBe(0);
    }),
  { tags },
);

const newArtifact = harness();
newArtifact.test.provider(
  "creates and checks a new version, then promotes it, and keeps the old one",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = newArtifact;
      yield* stack.destroy();

      const first = yield* stack.deploy(app({ reader: true }));
      expect(first.reader?.value).toBe("dep-1");
      yield* clearCalls(cloud);

      const second = yield* stack.deploy(app({ artifactPath: artifactV2, reader: true }));

      expect(cloud.writes()).toEqual([
        "POST /v1/services/svc-1/deployments",
        "POST /v1/deployments/dep-2/start",
        "POST /v1/services/svc-1/promote",
      ]);
      expect(cloud.probes()).toEqual(["dep-2.preview.prisma.test", "svc-1.stable.prisma.test"]);
      expect(second.service.serviceId).toBe(first.service.serviceId);
      expect(second.service.activeVersionId).toBe("dep-2");
      expect(second.reader?.value).toBe("dep-2");
      expect([...cloud.deployments.keys()].sort()).toEqual(["dep-1", "dep-2"]);
      const state = yield* rows(stack);
      expect(state.Version?.attr.versionId).toBe("dep-2");

      yield* stack.destroy();
      expect(cloud.writes()).not.toContain("DELETE /v1/deployments/dep-1");
      expect(cloud.services.size).toBe(0);
      expect(cloud.deployments.size).toBe(0);
    }),
  { tags },
);

const redeploy = harness();
redeploy.test.provider(
  "promotes the active version again on a deploy that changes nothing",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = redeploy;
      yield* stack.destroy();

      yield* stack.deploy(app());
      yield* clearCalls(cloud);
      const again = yield* stack.deploy(app());

      expect(cloud.writes()).toEqual(["POST /v1/services/svc-1/promote"]);
      expect(again.service.activeVersionId).toBe("dep-1");
      expect(cloud.deployments.size).toBe(1);

      yield* stack.destroy();
    }),
  { tags },
);

const ownUrl = harness();
ownUrl.test.provider(
  "deletes a new version whose preview URL never answers, and leaves the active version alone",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = ownUrl;
      yield* stack.destroy();

      yield* stack.deploy(app());
      cloud.knobs.failingPreviews.add("dep-2.preview.prisma.test");
      yield* clearCalls(cloud);

      const result = yield* stack.deploy(app({ artifactPath: artifactV2 })).pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      expect(cloud.writes()).toEqual([
        "POST /v1/services/svc-1/deployments",
        "POST /v1/deployments/dep-2/start",
        "POST /v1/deployments/dep-2/stop",
        "DELETE /v1/deployments/dep-2",
      ]);
      expect(cloud.services.get("svc-1")?.latestDeploymentId).toBe("dep-1");
      expect([...cloud.deployments.keys()]).toEqual(["dep-1"]);

      yield* stack.destroy();
    }),
  { tags },
);

const stableCheck = harness();
stableCheck.test.provider(
  "rolls the service back to the earlier version when the stable URL fails after a promotion",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = stableCheck;
      yield* stack.destroy();

      yield* stack.deploy(app());
      cloud.knobs.failingActiveVersions.add("dep-2");
      yield* clearCalls(cloud);

      const result = yield* stack.deploy(app({ artifactPath: artifactV2 })).pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(String(result.failure)).toContain("ComputeServiceEndpointCheckFailed");
        expect(String(result.failure)).toContain("rolled back to version 'dep-1'");
      }
      expect(cloud.writes()).toEqual([
        "POST /v1/services/svc-1/deployments",
        "POST /v1/deployments/dep-2/start",
        "POST /v1/services/svc-1/promote",
        "POST /v1/services/svc-1/rollback",
      ]);
      expect(cloud.services.get("svc-1")?.latestDeploymentId).toBe("dep-1");
      expect([...cloud.deployments.keys()].sort()).toEqual(["dep-1", "dep-2"]);
      const state = yield* rows(stack);
      expect(state.Service?.attr.activeVersionId).toBe("dep-1");

      // The next deploy points the service at the declared version again
      // without creating a third one.
      cloud.knobs.failingActiveVersions.clear();
      yield* clearCalls(cloud);
      const recovered = yield* stack.deploy(app({ artifactPath: artifactV2 }));
      expect(cloud.writes()).toEqual(["POST /v1/services/svc-1/promote"]);
      expect(recovered.service.activeVersionId).toBe("dep-2");

      yield* stack.destroy();
    }),
  { tags },
);

const rollbackStuck = harness();
rollbackStuck.test.provider(
  "fails without further changes when the rollback does not converge",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = rollbackStuck;
      yield* stack.destroy();

      yield* stack.deploy(app());
      cloud.knobs.failingActiveVersions.add("dep-2");
      cloud.knobs.rollbackIgnored = true;
      yield* clearCalls(cloud);

      const result = yield* stack.deploy(app({ artifactPath: artifactV2 })).pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(String(result.failure)).toContain("ComputeServiceRollbackNotConverged");
      }
      expect(cloud.writes()).toEqual([
        "POST /v1/services/svc-1/deployments",
        "POST /v1/deployments/dep-2/start",
        "POST /v1/services/svc-1/promote",
        "POST /v1/services/svc-1/rollback",
      ]);
      expect([...cloud.deployments.keys()].sort()).toEqual(["dep-1", "dep-2"]);

      cloud.knobs.rollbackIgnored = false;
      cloud.knobs.failingActiveVersions.clear();
      yield* stack.destroy();
    }),
  { tags },
);

const twoActiveOnCreate = harness();
twoActiveOnCreate.test.provider(
  "refuses two active versions on a first deploy before any version is created",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = twoActiveOnCreate;
      yield* stack.destroy();

      const result = yield* stack
        .deploy(
          Effect.gen(function* () {
            const service = yield* ComputeService("Service", {
              project: "project-1",
              branchId: "branch-1",
              ...checks,
            });
            const one = yield* ComputeVersion("One", {
              service: service.serviceId,
              artifactPath: artifactV1,
              start: true,
              ...checks,
            });
            const two = yield* ComputeVersion("Two", {
              service: service.serviceId,
              artifactPath: artifactV2,
              start: true,
              ...checks,
            });
            yield* activateVersion(service, one);
            yield* activateVersion(service, two);
          }),
        )
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(String(result.failure)).toContain("ComputeServiceTooManyActiveVersions");
      }
      expect(cloud.writes()).toEqual([]);
      expect(cloud.deployments.size).toBe(0);

      yield* stack.destroy();
    }),
  { tags },
);

const twoActiveOnUpdate = harness();
twoActiveOnUpdate.test.provider(
  "refuses a second active version on an existing service while planning",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = twoActiveOnUpdate;
      yield* stack.destroy();

      yield* stack.deploy(app());
      yield* clearCalls(cloud);

      const result = yield* stack
        .deploy(
          Effect.gen(function* () {
            const { service, version } = yield* app();
            const two = yield* ComputeVersion("Two", {
              service: service.serviceId,
              artifactPath: artifactV2,
              start: true,
              ...checks,
            });
            yield* activateVersion(service, two);
            return version;
          }),
        )
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(String(result.failure)).toContain("ComputeServiceTooManyActiveVersions");
      }
      expect(cloud.writes()).toEqual([]);
      expect(cloud.deployments.size).toBe(1);

      yield* stack.destroy();
    }),
  { tags },
);

const noActive = harness();
noActive.test.provider(
  "leaves a service with no attached version serving what it serves, and keeps removed versions",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = noActive;
      yield* stack.destroy();

      const alone = yield* stack.deploy(
        ComputeService("Service", { project: "project-1", branchId: "branch-1", ...checks }),
      );
      expect(alone.activeVersionId).toBeNull();
      expect(cloud.writes()).toEqual(["POST /v1/services"]);

      yield* stack.deploy(app());
      yield* clearCalls(cloud);

      // The version leaves the program: it is forgotten, not deleted, and the
      // service keeps serving it.
      const after = yield* stack.deploy(
        ComputeService("Service", { project: "project-1", branchId: "branch-1", ...checks }),
      );
      expect(cloud.writes()).toEqual([]);
      expect(after.activeVersionId).toBe("dep-1");
      expect([...cloud.deployments.keys()]).toEqual(["dep-1"]);
      expect((yield* rows(stack)).Version).toBeUndefined();

      yield* stack.destroy();
      expect(cloud.services.size).toBe(0);
    }),
  { tags },
);

const savedWithPromote = harness();
savedWithPromote.test.provider(
  "carries over a version row saved with promote before the service held the active version",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = savedWithPromote;
      yield* stack.destroy();

      yield* stack.deploy(app());
      yield* Effect.gen(function* () {
        const state = yield* yield* State;
        const address = { stack: stack.name, stage: stack.stage, fqn: "Version" };
        const stored = yield* state.get(address);
        if (!stored || isActionState(stored) || stored.status !== "created") {
          return yield* Effect.die(new Error("Expected a created Version row"));
        }
        const { url: _url, ...attr } = stored.attr as Record<string, unknown>;
        yield* state.set({
          ...address,
          value: {
            ...stored,
            attr: { ...attr, serviceEndpointDomain: "svc-1.stable.prisma.test" },
            props: { ...(stored.props as object), promote: true },
          },
        });
      }).pipe(Effect.provide(stack.state));
      yield* clearCalls(cloud);

      const out = yield* stack.deploy(app());

      expect(cloud.writes()).toEqual(["POST /v1/services/svc-1/promote"]);
      expect(out.version.versionId).toBe("dep-1");
      const state = yield* rows(stack);
      expect(state.Version?.attr.url).toBe("https://dep-1.preview.prisma.test");
      expect(state.Version?.attr).not.toHaveProperty("serviceEndpointDomain");
      expect(state.Version?.props).not.toHaveProperty("promote");

      yield* stack.destroy();
    }),
  { tags },
);

const local = harness({ dev: true });
local.test.provider(
  "attaches an active version in alchemy dev without calling the platform",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = local;
      yield* stack.destroy();

      const out = yield* stack.deploy(app());

      expect(out.service.serviceId).toBe("dev:app:Service");
      expect(out.service.activeVersionId).toBe(out.version.versionId);
      expect(cloud.fake.captured).toEqual([]);

      yield* stack.destroy();
    }),
  { tags },
);

const staleRecord = harness();
staleRecord.test.provider(
  "rolls back to the version the platform served before the promotion, not the one the row recorded",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = staleRecord;
      yield* stack.destroy();

      yield* stack.deploy(app());
      // The row records no active version, as a row written before the
      // service held one does. The platform serves dep-1.
      yield* Effect.gen(function* () {
        const state = yield* yield* State;
        const address = { stack: stack.name, stage: stack.stage, fqn: "Service" };
        const stored = yield* state.get(address);
        if (!stored || isActionState(stored) || stored.status !== "created") {
          return yield* Effect.die(new Error("Expected a created Service row"));
        }
        yield* state.set({
          ...address,
          value: { ...stored, attr: { ...(stored.attr as object), activeVersionId: null } },
        });
      }).pipe(Effect.provide(stack.state));
      cloud.knobs.failingActiveVersions.add("dep-2");
      yield* clearCalls(cloud);

      const result = yield* stack.deploy(app({ artifactPath: artifactV2 })).pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(String(result.failure)).toContain("rolled back to version 'dep-1'");
      }
      expect(cloud.writes()).toContain("POST /v1/services/svc-1/rollback");
      expect(cloud.services.get("svc-1")?.latestDeploymentId).toBe("dep-1");

      cloud.knobs.failingActiveVersions.clear();
      yield* stack.destroy();
    }),
  { tags },
);

const deletedTarget = harness();
deletedTarget.test.provider(
  "fails at once and names the version now live when the rollback target no longer exists",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = deletedTarget;
      yield* stack.destroy();

      yield* stack.deploy(app());
      cloud.deployments.delete("dep-1");
      cloud.knobs.failingActiveVersions.add("dep-2");
      yield* clearCalls(cloud);

      const result = yield* stack.deploy(app({ artifactPath: artifactV2 })).pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        const message = String(result.failure);
        expect(message).toContain("ComputeServiceRollbackFailed");
        expect(message).toContain("The rollback to version 'dep-1'");
        expect(message).toContain("was refused");
        expect(message).toContain("The service now serves 'dep-2'");
      }
      // A refused rollback is not waited out: the service is observed once
      // more for the message, and not polled for the refused version.
      const observationsAfterRollback = cloud.fake.captured
        .slice(
          cloud.fake.captured.findIndex(
            (request) => request.pathname === "/v1/services/svc-1/rollback",
          ),
        )
        .filter((request) => request.method === "GET" && request.pathname === "/v1/services/svc-1");
      expect(observationsAfterRollback.length).toBe(1);

      cloud.knobs.failingActiveVersions.clear();
      yield* stack.destroy();
    }),
  { tags },
);

const alreadyActive = harness();
alreadyActive.test.provider(
  "says there is nothing to roll back to when the service already served the failing version",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = alreadyActive;
      yield* stack.destroy();

      yield* stack.deploy(app());
      cloud.knobs.failingActiveVersions.add("dep-1");
      yield* clearCalls(cloud);

      const result = yield* stack.deploy(app()).pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(String(result.failure)).toContain(
          "already served this version before this deploy, so there is nothing to roll back to",
        );
      }
      expect(cloud.writes()).toEqual(["POST /v1/services/svc-1/promote"]);

      cloud.knobs.failingActiveVersions.clear();
      yield* stack.destroy();
    }),
  { tags },
);

const notStarted = harness();
notStarted.test.provider(
  "refuses to promote an attached version that is not running",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = notStarted;
      yield* stack.destroy();

      const result = yield* stack.deploy(app({ start: false })).pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(String(result.failure)).toContain("ComputeServiceVersionNotRunning");
        expect(String(result.failure)).toContain("not running");
      }
      expect(cloud.writes()).not.toContain("POST /v1/services/svc-1/promote");

      yield* stack.destroy();
    }),
  { tags },
);

const domainReader = harness();
domainReader.test.provider(
  "does not replan a reader of the stable endpoint domain on every deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      yield* stack.deploy(app({ domainReader: "DomainReader" }));
      const before = readerReconciles.filter((id) => id === "DomainReader").length;
      expect(before).toBe(1);

      const again = yield* stack.deploy(app({ domainReader: "DomainReader" }));

      expect(readerReconciles.filter((id) => id === "DomainReader").length).toBe(before);
      expect(again.domainReader?.value).toBe("svc-1.stable.prisma.test");

      yield* stack.destroy();
    }),
  { tags },
);

/** Rewrite the service and version rows as a release before the rename wrote them. */
const writeRowsAsBeforeRename = (stack: Test.ScratchStack) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const rewrite = (
      fqn: string,
      resourceType: string,
      attr: (saved: Record<string, unknown>) => Record<string, unknown>,
      props: (saved: Record<string, unknown>) => Record<string, unknown> = (saved) => saved,
    ) =>
      Effect.gen(function* () {
        const address = { stack: stack.name, stage: stack.stage, fqn };
        const stored = yield* state.get(address);
        if (!stored || isActionState(stored) || stored.status !== "created") {
          return yield* Effect.die(new Error(`Expected a created ${fqn} row`));
        }
        yield* state.set({
          ...address,
          value: {
            ...stored,
            resourceType,
            attr: attr(stored.attr as Record<string, unknown>),
            props: props(stored.props as Record<string, unknown>),
          },
        });
      });
    yield* rewrite(
      "Service",
      "Prisma.App",
      ({ serviceId, activeVersionId: _active, url: _url, serviceEndpointDomain, ...rest }) => ({
        ...rest,
        appId: serviceId,
        latestDeploymentId: null,
        appEndpointDomain: serviceEndpointDomain,
      }),
    );
    yield* rewrite(
      "Version",
      "Prisma.Deployment",
      ({ versionId, serviceId, url: _url, ...rest }) => ({
        ...rest,
        deploymentId: versionId,
        appId: serviceId,
        appEndpointDomain: undefined,
      }),
      ({ service, ...rest }) => ({ ...rest, app: service, promote: true }),
    );
  }).pipe(Effect.provide(stack.state));

const twoStepUpgrade = harness();
twoStepUpgrade.test.provider(
  "stops with a clear error when activateVersion meets a service saved before the rename, and upgrades in two deploys",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = twoStepUpgrade;
      yield* stack.destroy();

      yield* stack.deploy(app({ activate: false }));
      yield* writeRowsAsBeforeRename(stack);
      yield* clearCalls(cloud);

      // The program renames the resources and adds activateVersion at once.
      const direct = yield* stack.deploy(app({ artifactPath: artifactV2 })).pipe(Effect.result);
      expect(Result.isFailure(direct)).toBe(true);
      if (Result.isFailure(direct)) {
        const message = String(direct.failure);
        expect(message).toContain("ComputeServiceIdUnavailable");
        expect(message).toContain("Deploy once with the renamed resources and without");
      }
      expect(cloud.writes()).toEqual([]);

      // First deploy: renamed resources, no activateVersion.
      yield* stack.deploy(app({ activate: false }));
      const rewritten = yield* rows(stack);
      expect(rewritten.Service?.resourceType).toBe("Prisma.ComputeService");
      expect(rewritten.Service?.attr.serviceId).toBe("svc-1");
      expect(rewritten.Version?.resourceType).toBe("Prisma.ComputeVersion");
      yield* clearCalls(cloud);

      // Second deploy: add activateVersion with the new artifact.
      // (The failed attempt left a replacement of the version in state, so the
      // first deploy created a version from the v1 artifact again.)
      const upgraded = yield* stack.deploy(app({ artifactPath: artifactV2 }));
      const created = upgraded.version.versionId;
      expect(cloud.writes()).toEqual([
        "POST /v1/services/svc-1/deployments",
        `POST /v1/deployments/${created}/start`,
        "POST /v1/services/svc-1/promote",
      ]);
      expect(upgraded.service.serviceId).toBe("svc-1");
      expect(upgraded.service.activeVersionId).toBe(created);
      expect(cloud.services.get("svc-1")?.latestDeploymentId).toBe(created);

      yield* stack.destroy();
      expect(cloud.services.size).toBe(0);
    }),
  { tags },
);

const afterFailedRecovery = harness();
afterFailedRecovery.test.provider(
  "restores the recorded version on the next deploy after a rollback that did not converge",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = afterFailedRecovery;
      yield* stack.destroy();

      yield* stack.deploy(app());
      cloud.knobs.failingActiveVersions.add("dep-2");
      cloud.knobs.rollbackIgnored = true;
      const failed = yield* stack.deploy(app({ artifactPath: artifactV2 })).pipe(Effect.result);
      expect(Result.isFailure(failed)).toBe(true);
      // The platform serves the broken dep-2; the service's row records dep-1.
      expect(cloud.services.get("svc-1")?.latestDeploymentId).toBe("dep-2");
      expect((yield* rows(stack)).Service?.attr.activeVersionId).toBe("dep-1");

      cloud.knobs.rollbackIgnored = false;
      yield* clearCalls(cloud);
      const again = yield* stack.deploy(app({ artifactPath: artifactV2 })).pipe(Effect.result);

      expect(Result.isFailure(again)).toBe(true);
      if (Result.isFailure(again)) {
        expect(String(again.failure)).toContain("rolled back to version 'dep-1'");
      }
      expect(cloud.writes()).toEqual([
        "POST /v1/services/svc-1/promote",
        "POST /v1/services/svc-1/rollback",
      ]);
      expect(cloud.services.get("svc-1")?.latestDeploymentId).toBe("dep-1");

      cloud.knobs.failingActiveVersions.clear();
      yield* stack.destroy();
    }),
  { tags },
);

const lostRollbackResponse = harness();
lostRollbackResponse.test.provider(
  "keeps observing after a rollback whose response was lost, and reports the restored version",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = lostRollbackResponse;
      yield* stack.destroy();

      yield* stack.deploy(app());
      cloud.knobs.failingActiveVersions.add("dep-2");
      cloud.knobs.rollbackResponseLost = true;
      yield* clearCalls(cloud);

      const result = yield* stack.deploy(app({ artifactPath: artifactV2 })).pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        const message = String(result.failure);
        expect(message).toContain("ComputeServiceEndpointCheckFailed");
        expect(message).toContain("rolled back to version 'dep-1'");
        expect(message).not.toContain("was refused");
      }
      expect(cloud.services.get("svc-1")?.latestDeploymentId).toBe("dep-1");

      cloud.knobs.rollbackResponseLost = false;
      cloud.knobs.failingActiveVersions.clear();
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
