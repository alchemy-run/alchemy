import { PrismaApiError, type PrismaManagementClient } from "@alchemy.run/prisma/Client";
import type { CustomDomain as ApiCustomDomain } from "@alchemy.run/prisma/Types";
import * as Effect from "effect/Effect";
import {
  type Captured,
  data,
  failure,
  json,
  makeFakeManagementApi,
  noContent,
  notFound,
  page,
  unhandled,
} from "./FakeManagementApi.ts";

const createdAt = "2026-01-01T00:00:00.000Z";

export interface WireService {
  id: string;
  type: string;
  url: string;
  name: string;
  region: { id: string; name: string };
  projectId: string;
  branchId: string | null;
  latestDeploymentId: string | null;
  appEndpointDomain: string;
  createdAt: string;
  logicalId: string | null;
}

export interface WireDeployment {
  id: string;
  type: string;
  url: string;
  serviceId: string;
  foundryVersionId: string;
  status: string;
  previewDomain: string | null;
  createdAt: string;
}

export interface WireEnvironmentVariable {
  id: string;
  type: string;
  url: string;
  projectId: string;
  branchId: string | null;
  class: "production" | "preview";
  key: string;
  valueKid: string;
  isManagedBySystem: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Answers Prisma's edge gives for a host with no live service. */
const edgeServiceNotFound = () => new Response("There is no service on this URL", { status: 404 });

/**
 * An in-memory Prisma Compute: services, versions (the API's deployments),
 * promotion and rollback, artifact uploads, and the public preview and stable
 * URLs, served over the fake `HttpClient` the Management API operations and
 * the URL checks share.
 */
export const makeComputeCloud = () => {
  const services = new Map<string, WireService>();
  const deployments = new Map<string, WireDeployment>();
  const variables = new Map<string, WireEnvironmentVariable>();
  /** Plain values of the variables, which the real API never returns. */
  const values = new Map<string, string>();
  /** Role of each Branch; a Branch not listed is a production Branch. */
  const branchRoles = new Map<string, "production" | "preview">();
  /** The variables each version was created with, as the platform copies them in. */
  const versionEnvironment = new Map<string, Record<string, string | undefined>>();
  const environment = () =>
    Object.fromEntries(
      [...variables.values()].map((variable) => [variable.key, values.get(variable.id)]),
    );
  let nextService = 1;
  let nextDeployment = 1;
  let nextVariable = 1;

  const knobs = {
    /** Preview domains that never answer, so the version's own check fails. */
    failingPreviews: new Set<string>(),
    /** A stable domain fails its check while its service serves one of these versions. */
    failingActiveVersions: new Set<string>(),
    /** Rollback calls succeed but the service keeps serving what it serves. */
    rollbackIgnored: false,
    /** Rollback calls take effect but answer with a server error. */
    rollbackResponseLost: false,
  };

  const serviceFor = (domain: string) =>
    [...services.values()].find((service) => service.appEndpointDomain === domain);

  const respond = (request: Captured) => {
    const host = new URL(request.url).host;
    if (host.endsWith(".preview.prisma.test")) {
      return knobs.failingPreviews.has(host) ? edgeServiceNotFound() : json({ ok: true });
    }
    if (host.endsWith(".stable.prisma.test")) {
      const service = serviceFor(host);
      if (!service || service.latestDeploymentId === null) return edgeServiceNotFound();
      return knobs.failingActiveVersions.has(service.latestDeploymentId)
        ? edgeServiceNotFound()
        : json({ ok: true });
    }
    if (host === "upload.prisma.test") return new Response(null, { status: 200 });

    const [head, id, tail] = request.pathname
      .split("/")
      .filter((segment) => segment.length > 0)
      .slice(1);
    const body = request.bodyJson as Record<string, unknown> | undefined;

    if (head === "branches" && id !== undefined && request.method === "GET") {
      return data({
        id,
        type: "branch",
        url: "",
        gitName: id,
        isDefault: true,
        role: branchRoles.get(id) ?? "production",
        createdAt,
        updatedAt: createdAt,
        project: { id: "project-1", url: "", name: "project-1" },
      });
    }
    if (head === "environment-variables" && id === undefined && request.method === "GET") {
      const query = new URLSearchParams(request.search);
      return page(
        [...variables.values()].filter(
          (variable) =>
            (!query.has("projectId") || variable.projectId === query.get("projectId")) &&
            (!query.has("class") || variable.class === query.get("class")) &&
            (!query.has("key") || variable.key === query.get("key")) &&
            (!query.has("branchId") || variable.branchId === query.get("branchId")),
        ),
      );
    }
    if (head === "environment-variables" && id === undefined && request.method === "POST") {
      const projectId = String(body?.projectId);
      const branchId = (body?.branchId as string | undefined) ?? null;
      const cls = body?.class as "production" | "preview";
      const key = String(body?.key);
      const taken = [...variables.values()].some(
        (variable) =>
          variable.projectId === projectId &&
          variable.branchId === branchId &&
          variable.class === cls &&
          variable.key === key,
      );
      if (taken) return failure(409, "conflict", `variable '${key}' already exists`);
      const variable: WireEnvironmentVariable = {
        id: `env-${nextVariable++}`,
        type: "environment_variable",
        url: "",
        projectId,
        branchId,
        class: cls,
        key,
        valueKid: "kid-1",
        isManagedBySystem: false,
        createdAt,
        updatedAt: createdAt,
      };
      variables.set(variable.id, variable);
      values.set(variable.id, String(body?.value));
      return data(variable);
    }
    if (head === "environment-variables" && id !== undefined) {
      const variable = variables.get(id);
      if (!variable) return notFound();
      if (request.method === "GET") return data(variable);
      if (request.method === "PATCH") {
        values.set(id, String(body?.value));
        return data(variable);
      }
      if (request.method === "DELETE") {
        variables.delete(id);
        values.delete(id);
        return noContent();
      }
    }
    if (head === "services" && id === undefined && request.method === "GET") {
      const query = new URLSearchParams(request.search);
      return page(
        [...services.values()].filter(
          (service) =>
            (!query.has("projectId") || service.projectId === query.get("projectId")) &&
            (!query.has("logicalId") || service.logicalId === query.get("logicalId")) &&
            (!query.has("branchId") || service.branchId === query.get("branchId")),
        ),
      );
    }
    if (head === "services" && id === undefined && request.method === "POST") {
      const number = nextService++;
      const service: WireService = {
        id: `svc-${number}`,
        type: "service",
        url: "",
        name: String(body?.displayName),
        region: { id: "us-east-1", name: "us-east-1" },
        projectId: String(body?.projectId),
        branchId: (body?.branchId as string | undefined) ?? null,
        latestDeploymentId: null,
        appEndpointDomain: `svc-${number}.stable.prisma.test`,
        createdAt,
        logicalId: (body?.logicalId as string | undefined) ?? null,
      };
      services.set(service.id, service);
      return data(service);
    }
    if (head === "services" && id !== undefined) {
      const service = services.get(id);
      if (!service) return notFound();
      if (tail === undefined && request.method === "GET") return data(service);
      if (tail === undefined && request.method === "DELETE") {
        services.delete(id);
        // The platform deletes a service's versions with it.
        for (const deployment of [...deployments.values()]) {
          if (deployment.serviceId === id) deployments.delete(deployment.id);
        }
        return noContent();
      }
      if (tail === "deployments" && request.method === "GET") {
        return page([...deployments.values()].filter((d) => d.serviceId === id));
      }
      if (tail === "deployments" && request.method === "POST") {
        const number = nextDeployment++;
        const deployment: WireDeployment = {
          id: `dep-${number}`,
          type: "deployment",
          url: "",
          serviceId: id,
          foundryVersionId: `foundry-${number}`,
          status: "new",
          previewDomain: null,
          createdAt,
        };
        deployments.set(deployment.id, deployment);
        versionEnvironment.set(deployment.id, environment());
        return data({
          ...deployment,
          uploadUrl:
            body?.skipCodeUpload === true ? null : `https://upload.prisma.test/${deployment.id}`,
        });
      }
      if ((tail === "promote" || tail === "rollback") && request.method === "POST") {
        const target = String(body?.deploymentId);
        if (!deployments.has(target)) return notFound();
        if (tail === "promote" || !knobs.rollbackIgnored) service.latestDeploymentId = target;
        if (tail === "rollback" && knobs.rollbackResponseLost) {
          return failure(502, "bad_gateway", "upstream timed out");
        }
        return data({ appEndpointDomain: service.appEndpointDomain, reassignedDomains: 0 });
      }
    }
    if (head === "deployments" && id !== undefined) {
      const deployment = deployments.get(id);
      if (!deployment) return notFound();
      if (tail === "start" && request.method === "POST") {
        deployment.status = "running";
        deployment.previewDomain = `${id}.preview.prisma.test`;
        return data({ previewDomain: deployment.previewDomain });
      }
      if (tail === "stop" && request.method === "POST") {
        deployment.status = "stopped";
        return noContent();
      }
      if (tail === undefined && request.method === "GET") return data(deployment);
      if (tail === undefined && request.method === "DELETE") {
        deployments.delete(id);
        return noContent();
      }
    }
    return unhandled(request);
  };

  const domains = new Map<string, ApiCustomDomain>();
  /** `Prisma.CustomDomain` reaches custom domains through the hand-written client. */
  const domainClient = {
    listAppDomains: (serviceId: string) =>
      Effect.sync(() => [...domains.values()].filter((domain) => domain.appId === serviceId)),
    getCustomDomain: (id: string) =>
      Effect.suspend(() => {
        const domain = domains.get(id);
        return domain
          ? Effect.succeed(domain)
          : Effect.fail(
              new PrismaApiError({
                method: "GET",
                path: `/v1/domains/${id}`,
                status: 404,
                message: "not found",
              }),
            );
      }),
    createAppDomain: (serviceId: string, input: { hostname: string }) =>
      Effect.sync(() => {
        const id = `domain-${domains.size + 1}`;
        const domain: ApiCustomDomain = {
          id,
          type: "custom-domain",
          url: "",
          hostname: input.hostname,
          appId: serviceId,
          status: "active",
          foundryStatus: "active",
          failureReason: null,
          failureCategory: null,
          certExpiresAt: null,
          dnsRecords: [],
          createdAt,
          updatedAt: createdAt,
        };
        domains.set(id, domain);
        return { status: 201 as const, domain };
      }),
    retryCustomDomain: (id: string) => Effect.sync(() => domains.get(id)!),
    deleteCustomDomain: (id: string) =>
      Effect.sync(() => {
        domains.delete(id);
      }),
  } as unknown as PrismaManagementClient;

  const fake = makeFakeManagementApi(respond);
  return {
    fake,
    domains,
    domainClient,
    services,
    deployments,
    variables,
    values,
    branchRoles,
    knobs,
    versionEnvironment,
    /** Plain value of each variable by key, as the platform would hand a new version. */
    environment,
    /** `METHOD /path` of every Management API call that changes something. */
    writes: () =>
      fake.captured
        .filter(
          (request) =>
            request.method !== "GET" && new URL(request.url).host !== "upload.prisma.test",
        )
        .map((request) => `${request.method} ${request.pathname}`),
    /** Hosts of every public URL probe, in order. */
    probes: () =>
      fake.captured
        .map((request) => new URL(request.url).host)
        .filter(
          (host) => host.endsWith(".preview.prisma.test") || host.endsWith(".stable.prisma.test"),
        ),
  };
};

export type ComputeCloud = ReturnType<typeof makeComputeCloud>;
