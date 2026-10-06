import { type Credentials, fromApiToken } from "@distilled.cloud/prisma";
import * as Effect from "effect/Effect";
import type * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { AlchemyContext } from "@/AlchemyContext";
import { Compute, ComputeProvider } from "@/Prisma/Compute";
import * as Provider from "@/Provider";
import {
  type Captured,
  data,
  FAKE_API_BASE_URL,
  failure,
  noContent,
  notFound,
  page,
  unhandled,
} from "./FakeManagementApi.ts";

/**
 * A stateful in-memory Prisma Compute cloud served over a fake `HttpClient`,
 * for fault-injection suites that drive `Prisma.Compute` through the engine
 * (`stack.deploy` / `stack.plan` / `stack.destroy`).
 *
 * The same client answers the three kinds of traffic a Compute reconcile
 * makes: Management API calls (dispatched onto the maps below), artifact
 * uploads to `https://upload.prisma.test/...` (captured), and readiness /
 * health probes to `*.prisma.build` (answered from `previewStatus` /
 * `stableStatus`). Faults are injected per test through the knobs and the
 * `intercept` hook, which sees every Management API request first.
 */

export const CREATED_AT = "2026-01-01T00:00:00Z";
const REF = `${FAKE_API_BASE_URL}/v1`;

export type DeploymentStatus =
  | "new"
  | "provisioning"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";

export interface FakeService {
  id: string;
  name: string;
  projectId: string;
  regionId: string;
  branchId: string | null;
  latestDeploymentId: string | null;
  appEndpointDomain: string;
}

export interface FakeDeployment {
  id: string;
  serviceId: string;
  foundryVersionId: string;
  status: DeploymentStatus;
  previewDomain: string | null;
  portMapping: unknown;
  skipCodeUpload: boolean | undefined;
}

export interface FakeEnvironmentVariable {
  id: string;
  projectId: string;
  branchId: string | null;
  class: "production" | "preview";
  key: string;
  value: string;
  isManagedBySystem: boolean;
}

export interface FakeBranch {
  id: string;
  projectId: string;
  gitName: string;
  isDefault: boolean;
  role: "production" | "preview";
}

export interface Upload {
  readonly url: string;
  readonly contentType: string | undefined;
  readonly bytes: Uint8Array;
}

export interface FakeComputeCloud {
  /** Fake transport plus the credentials distilled resolves. */
  readonly layer: Layer.Layer<HttpClient.HttpClient | Credentials>;
  readonly services: Map<string, FakeService>;
  readonly deployments: Map<string, FakeDeployment>;
  readonly environmentVariables: Map<string, FakeEnvironmentVariable>;
  readonly branches: Map<string, FakeBranch>;
  /** Every Management API request, in order. */
  readonly captured: Captured[];
  /**
   * Every request in order: `METHOD /path` for the Management API,
   * `PROBE <url>` for readiness / health probes, `UPLOAD <url>` for uploads.
   */
  readonly log: string[];
  /** Every artifact upload, in order. */
  readonly uploads: Upload[];
  /** Every readiness / health probe URL, in order. */
  readonly probes: string[];
  /** Status answered for `*.preview.prisma.build` probes. */
  previewStatus: number;
  /** Status answered for stable `*.prisma.build` probes. */
  stableStatus: number;
  /** Status answered for artifact uploads. */
  uploadStatus: number;
  /** Omit `uploadUrl` from create-deployment responses. */
  omitUploadUrl: boolean;
  /** Create services with no branch attached (Prisma attaches later on PATCH). */
  createServicesDetached: boolean;
  /** Whether a successful promote moves `latestDeploymentId`. */
  promoteUpdatesLatest: boolean;
  /** Whether a successful rollback moves `latestDeploymentId`. */
  rollbackUpdatesLatest: boolean;
  /** Sees every Management API request first; return a response to short-circuit it. */
  intercept: ((request: Captured) => Response | undefined) | undefined;
  /** `log` entries since a `mark`. */
  readonly since: (mark: number) => string[];
  /** Position in `log`, for slicing one deploy's calls. */
  readonly mark: () => number;
  /** Restore the initial state (one project with a production and a preview branch). */
  readonly reset: () => void;
}

export const PROJECT_ID = "project-1";
export const MAIN_BRANCH_ID = "branch-main";
export const FEATURE_BRANCH_ID = "branch-feature";

const wireService = (service: FakeService) => ({
  id: service.id,
  type: "app",
  url: `${REF}/services/${service.id}`,
  name: service.name,
  region: { id: service.regionId, name: service.regionId },
  projectId: service.projectId,
  branchId: service.branchId,
  latestDeploymentId: service.latestDeploymentId,
  appEndpointDomain: service.appEndpointDomain,
  createdAt: CREATED_AT,
});

const wireDeployment = (deployment: FakeDeployment) => ({
  id: deployment.id,
  type: "deployment",
  serviceId: deployment.serviceId,
  url: `${REF}/deployments/${deployment.id}`,
  foundryVersionId: deployment.foundryVersionId,
  status: deployment.status,
  previewDomain: deployment.previewDomain,
  createdAt: CREATED_AT,
});

const wireDeploymentSummary = (deployment: FakeDeployment) => ({
  id: deployment.id,
  type: "deployment",
  serviceId: deployment.serviceId,
  url: `${REF}/deployments/${deployment.id}`,
  foundryVersionId: deployment.foundryVersionId,
  createdAt: CREATED_AT,
});

const wireEnvironmentVariable = (variable: FakeEnvironmentVariable) => ({
  id: variable.id,
  type: "environment-variable",
  url: `${REF}/environment-variables/${variable.id}`,
  projectId: variable.projectId,
  branchId: variable.branchId,
  class: variable.class,
  key: variable.key,
  valueKid: `kid-${variable.id}`,
  isManagedBySystem: variable.isManagedBySystem,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
});

const wireBranch = (branch: FakeBranch) => ({
  id: branch.id,
  type: "branch",
  url: `${REF}/branches/${branch.id}`,
  gitName: branch.gitName,
  isDefault: branch.isDefault,
  role: branch.role,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  project: { id: branch.projectId, url: `${REF}/projects/${branch.projectId}`, name: "project" },
});

const readBodyBytes = (body: HttpBody.HttpBody) =>
  Effect.gen(function* () {
    if (body._tag === "Uint8Array") return body.body;
    if (body._tag !== "Stream") return new Uint8Array();
    const chunks = yield* Stream.runCollect(body.stream);
    const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  });

const bodyContentType = (body: HttpBody.HttpBody) =>
  body._tag === "Uint8Array" || body._tag === "Stream" ? body.contentType : undefined;

export const makeFakeComputeCloud = (): FakeComputeCloud => {
  const services = new Map<string, FakeService>();
  const deployments = new Map<string, FakeDeployment>();
  const environmentVariables = new Map<string, FakeEnvironmentVariable>();
  const branches = new Map<string, FakeBranch>();
  const captured: Captured[] = [];
  const uploads: Upload[] = [];
  const probes: string[] = [];
  const log: string[] = [];
  let serviceCounter = 0;
  let deploymentCounter = 0;
  let variableCounter = 0;

  const knobs = {
    previewStatus: 204,
    stableStatus: 204,
    uploadStatus: 200,
    omitUploadUrl: false,
    createServicesDetached: false,
    promoteUpdatesLatest: true,
    rollbackUpdatesLatest: true,
    intercept: undefined as FakeComputeCloud["intercept"],
  };
  const cloud: FakeComputeCloud = Object.assign(knobs, {
    layer: Layer.suspend(() => layer),
    services,
    deployments,
    environmentVariables,
    branches,
    captured,
    log,
    uploads,
    probes,
    since: (mark: number) => log.slice(mark),
    mark: () => log.length,
    reset: () => {
      services.clear();
      deployments.clear();
      environmentVariables.clear();
      branches.clear();
      captured.length = 0;
      log.length = 0;
      uploads.length = 0;
      probes.length = 0;
      serviceCounter = 0;
      deploymentCounter = 0;
      variableCounter = 0;
      cloud.previewStatus = 204;
      cloud.stableStatus = 204;
      cloud.uploadStatus = 200;
      cloud.omitUploadUrl = false;
      cloud.createServicesDetached = false;
      cloud.promoteUpdatesLatest = true;
      cloud.rollbackUpdatesLatest = true;
      cloud.intercept = undefined;
      branches.set(MAIN_BRANCH_ID, {
        id: MAIN_BRANCH_ID,
        projectId: PROJECT_ID,
        gitName: "main",
        isDefault: true,
        role: "production",
      });
      branches.set(FEATURE_BRANCH_ID, {
        id: FEATURE_BRANCH_ID,
        projectId: PROJECT_ID,
        gitName: "feature",
        isDefault: false,
        role: "preview",
      });
    },
  });
  cloud.reset();

  const deploymentNotFound = () => notFound("deployment not found");

  const management = (request: Captured): Response => {
    const [head, id, tail] = request.pathname
      .split("/")
      .filter((segment) => segment.length > 0)
      .slice(1);
    const body = (request.bodyJson ?? {}) as Record<string, any>;
    const query = Object.fromEntries(new URLSearchParams(request.search));

    if (head === "services") {
      if (id === undefined && request.method === "GET") {
        return page(
          [...services.values()]
            .filter((service) => !query.projectId || service.projectId === query.projectId)
            .map(wireService),
        );
      }
      if (id === undefined && request.method === "POST") {
        serviceCounter += 1;
        const service: FakeService = {
          id: `service-${serviceCounter}`,
          name: body.displayName,
          projectId: body.projectId,
          regionId: body.regionId ?? "us-east-1",
          branchId: cloud.createServicesDetached ? null : (body.branchId ?? null),
          latestDeploymentId: null,
          appEndpointDomain: `${body.displayName}.prisma.build`,
        };
        services.set(service.id, service);
        return data(wireService(service), { status: 201 });
      }
      const service = id === undefined ? undefined : services.get(id);
      if (tail === undefined) {
        if (request.method === "GET") {
          return service ? data(wireService(service)) : notFound("service not found");
        }
        if (request.method === "PATCH") {
          if (!service) return notFound("service not found");
          if (body.displayName !== undefined) service.name = body.displayName;
          if (body.branchId !== undefined) service.branchId = body.branchId;
          return data(wireService(service));
        }
        if (request.method === "DELETE") {
          if (!service) return notFound("service not found");
          services.delete(service.id);
          for (const deployment of [...deployments.values()]) {
            if (deployment.serviceId === service.id) deployments.delete(deployment.id);
          }
          return noContent();
        }
      }
      if (!service) return notFound("service not found");
      if (tail === "deployments") {
        if (request.method === "GET") {
          return page(
            [...deployments.values()]
              .filter((deployment) => deployment.serviceId === service.id)
              .map(wireDeploymentSummary),
          );
        }
        deploymentCounter += 1;
        const deploymentId = `version-${deploymentCounter}`;
        const deployment: FakeDeployment = {
          id: deploymentId,
          serviceId: service.id,
          foundryVersionId: `foundry-${deploymentId}`,
          status: "new",
          previewDomain: null,
          portMapping: body.portMapping,
          skipCodeUpload: body.skipCodeUpload,
        };
        deployments.set(deploymentId, deployment);
        return data(
          {
            id: deploymentId,
            type: "deployment",
            url: `${REF}/deployments/${deploymentId}`,
            foundryVersionId: deployment.foundryVersionId,
            uploadUrl:
              cloud.omitUploadUrl || body.skipCodeUpload
                ? null
                : `https://upload.prisma.test/${deploymentId}.tar.gz`,
          },
          { status: 201 },
        );
      }
      if (tail === "promote" || tail === "rollback") {
        const target = deployments.get(body.deploymentId);
        if (!target || target.serviceId !== service.id) return deploymentNotFound();
        const moves = tail === "promote" ? cloud.promoteUpdatesLatest : cloud.rollbackUpdatesLatest;
        if (moves) service.latestDeploymentId = target.id;
        return data({ appEndpointDomain: service.appEndpointDomain, reassignedDomains: 0 });
      }
    }

    if (head === "deployments" && id !== undefined) {
      const deployment = deployments.get(id);
      if (!deployment) return deploymentNotFound();
      if (tail === "start") {
        deployment.status = "running";
        deployment.previewDomain = `${deployment.id}.preview.prisma.build`;
        return data({ previewDomain: deployment.previewDomain });
      }
      if (tail === "stop") {
        deployment.status = "stopped";
        return noContent();
      }
      if (request.method === "GET") return data(wireDeployment(deployment));
      if (request.method === "DELETE") {
        deployments.delete(deployment.id);
        return noContent();
      }
    }

    if (head === "branches" && id !== undefined && request.method === "GET") {
      const branch = branches.get(id);
      return branch ? data(wireBranch(branch)) : notFound("branch not found");
    }

    if (head === "projects" && id !== undefined && tail === "branches") {
      return page(
        [...branches.values()]
          .filter((branch) => branch.projectId === id)
          .filter((branch) => !query.gitName || branch.gitName === query.gitName)
          .map(wireBranch),
      );
    }

    if (head === "environment-variables") {
      if (id === undefined && request.method === "GET") {
        return page(
          [...environmentVariables.values()]
            .filter(
              (variable) =>
                (!query.projectId || variable.projectId === query.projectId) &&
                (!query.class || variable.class === query.class) &&
                (!query.key || variable.key === query.key) &&
                (!query.branchId || variable.branchId === query.branchId),
            )
            .map(wireEnvironmentVariable),
        );
      }
      if (id === undefined && request.method === "POST") {
        variableCounter += 1;
        const variable: FakeEnvironmentVariable = {
          id: `env-${variableCounter}`,
          projectId: body.projectId,
          branchId: body.branchId ?? null,
          class: body.class,
          key: body.key,
          value: body.value,
          isManagedBySystem: false,
        };
        environmentVariables.set(variable.id, variable);
        return data(wireEnvironmentVariable(variable), { status: 201 });
      }
      const variable = id === undefined ? undefined : environmentVariables.get(id);
      if (!variable) return notFound("environment variable not found");
      if (request.method === "GET") return data(wireEnvironmentVariable(variable));
      if (request.method === "PATCH") {
        if (body.value !== undefined) variable.value = body.value;
        return data(wireEnvironmentVariable(variable));
      }
      if (request.method === "DELETE") {
        environmentVariables.delete(variable.id);
        return noContent();
      }
    }

    return unhandled(request);
  };

  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      const url = new URL(request.url);
      const body = request.body as HttpBody.HttpBody;
      if (url.hostname === "upload.prisma.test") {
        log.push(`UPLOAD ${request.url}`);
        uploads.push({
          url: request.url,
          contentType: bodyContentType(body),
          bytes: yield* readBodyBytes(body).pipe(
            Effect.catch(() => Effect.succeed(new Uint8Array())),
          ),
        });
        return HttpClientResponse.fromWeb(
          request,
          new Response(cloud.uploadStatus < 300 ? null : "upload failed", {
            status: cloud.uploadStatus,
          }),
        );
      }
      if (url.hostname.endsWith(".prisma.build")) {
        probes.push(request.url);
        log.push(`PROBE ${request.url}`);
        const status = url.hostname.endsWith(".preview.prisma.build")
          ? cloud.previewStatus
          : cloud.stableStatus;
        return HttpClientResponse.fromWeb(request, new Response(null, { status }));
      }
      const bodyText = body._tag === "Uint8Array" ? new TextDecoder().decode(body.body) : "";
      const entry: Captured = {
        url: request.url,
        method: request.method,
        pathname: url.pathname,
        search: url.search,
        authorization: request.headers.authorization,
        bodyJson: bodyText ? JSON.parse(bodyText) : undefined,
      };
      captured.push(entry);
      log.push(`${request.method} ${url.pathname}`);
      return HttpClientResponse.fromWeb(request, cloud.intercept?.(entry) ?? management(entry));
    }),
  );

  const layer = Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, client),
    fromApiToken({ apiToken: Redacted.make("fake-service-token"), apiBaseUrl: FAKE_API_BASE_URL }),
  );
  return cloud;
};

/** A non-transient injected failure (a 5xx would be replayed by the retry policy). */
export const rejected = (message: string, status = 400) => failure(status, "error", message);

/** Match an intercepted request by method and path suffix. */
export const isRoute = (request: Captured, method: string, pathname: string) =>
  request.method === method && request.pathname === `/v1${pathname}`;

class FakeComputeProviders extends Provider.ProviderCollection<FakeComputeProviders>()("Prisma") {}

/** `Prisma.Compute`'s live provider over the fake cloud, for `Test.make({ providers })`. */
export const fakeComputeProviders = (cloud: FakeComputeCloud) =>
  Layer.effect(FakeComputeProviders, Provider.collection([Compute])).pipe(
    Layer.provideMerge(ComputeProvider()),
    Layer.provide(
      Layer.succeed(AlchemyContext, { dotAlchemy: ".alchemy-test", dev: false, adopt: false }),
    ),
    Layer.provideMerge(cloud.layer),
  );
