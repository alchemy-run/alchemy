import { AlchemyContext } from "@/AlchemyContext.ts";
import { Service } from "@/Railway/Service.ts";
import { ServiceProvider } from "@/Railway/ServiceProvider.ts";
import { Stack } from "@/Stack.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import { CredentialsFromToken } from "@distilled.cloud/railway";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

const PROJECT_ID = "project-1";
const ENVIRONMENT_ID = "environment-1";
const SERVICE_ID = "service-1";
const NOW = "2026-01-01T00:00:00.000Z";

const service = {
  createdAt: NOW,
  deletedAt: null,
  featureFlags: [],
  groupId: null,
  hasHiddenRegistryCredentialsFromTemplate: false,
  icon: null,
  id: SERVICE_ID,
  isRestricted: false,
  name: "test-service",
  projectId: PROJECT_ID,
  templateId: null,
  templateServiceId: null,
  templateThreadSlug: null,
  updatedAt: NOW,
};

const serviceResponse = {
  ...service,
  project: {
    baseEnvironmentId: null,
    botPrEnvironments: false,
    createdAt: NOW,
    deletedAt: null,
    description: null,
    expiredAt: null,
    featureFlags: [],
    focusedPrEnvironments: false,
    id: PROJECT_ID,
    isPublic: false,
    isTempProject: false,
    name: "test-project",
    prDeploys: false,
    primaryEnvironmentId: ENVIRONMENT_ID,
    subscriptionPlanLimit: null,
    subscriptionType: "free",
    teamId: null,
    updatedAt: NOW,
    workspaceId: null,
  },
};

const successfulDeployment = {
  canRedeploy: true,
  canRollback: false,
  createdAt: NOW,
  deploymentStopped: false,
  diagnosis: null,
  environmentId: ENVIRONMENT_ID,
  id: "deployment-1",
  meta: null,
  projectId: PROJECT_ID,
  serviceId: SERVICE_ID,
  snapshotId: null,
  staticUrl: null,
  status: "SUCCESS",
  statusUpdatedAt: NOW,
  suggestAddServiceDomain: false,
  updatedAt: NOW,
  url: null,
};

const contextInstance = {
  activeDeployments: [successfulDeployment],
  buildCommand: null,
  builder: "RAILPACK",
  createdAt: NOW,
  cronSchedule: null,
  deletedAt: null,
  dockerfilePath: "docker/context.Dockerfile",
  drainingSeconds: null,
  edgeConfig: null,
  environmentId: ENVIRONMENT_ID,
  healthcheckPath: null,
  healthcheckTimeout: null,
  id: "instance-1",
  ipv6EgressEnabled: null,
  isUpdatable: false,
  latestDeployment: successfulDeployment,
  nextCronRunAt: null,
  nixpacksPlan: null,
  numReplicas: 3,
  overlapSeconds: null,
  preDeployCommand: null,
  railpackInfo: null,
  railwayConfigFile: null,
  region: null,
  restartPolicyMaxRetries: 10,
  restartPolicyType: "ON_FAILURE",
  rootDirectory: null,
  service,
  serviceId: SERVICE_ID,
  serviceName: service.name,
  sleepApplication: null,
  source: null,
  startCommand: null,
  updatedAt: NOW,
  upstreamUrl: null,
  watchPatterns: [],
};

const domain = {
  cdnMode: null,
  createdAt: NOW,
  deletedAt: null,
  domain: "test-service.up.railway.app",
  edgeId: null,
  environmentId: ENVIRONMENT_ID,
  id: "domain-1",
  newDomainName: null,
  newHostLabel: null,
  projectId: PROJECT_ID,
  serviceId: SERVICE_ID,
  suffix: "up.railway.app",
  syncStatus: "ACTIVE",
  targetPort: null,
  updatedAt: NOW,
};

const environment = {
  canAccess: true,
  canvasGroupRefs: [],
  config: {},
  configEtag: "etag-1",
  createdAt: NOW,
  deletedAt: null,
  id: ENVIRONMENT_ID,
  isEphemeral: false,
  meta: null,
  name: "production",
  projectId: PROJECT_ID,
  unmergedChangesCount: null,
  updatedAt: NOW,
  volumeInstances: { edges: [] },
};

interface GraphqlRequest {
  operationName: string;
  variables: Record<string, unknown>;
}

const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const responseFor = (request: GraphqlRequest) => {
  const value = (() => {
    switch (request.operationName) {
      case "service":
        return serviceResponse;
      case "serviceInstance":
        return contextInstance;
      case "domains":
        return { customDomains: [], serviceDomains: [domain] };
      case "environment":
        return environment;
      case "serviceInstanceUpdate":
        return true;
      case "variables":
        return { ALCHEMY_RPC_TOKEN: "test-rpc-token" };
      case "serviceInstanceDeployV2":
        return successfulDeployment.id;
      default:
        throw new Error(
          `Unexpected Railway operation ${request.operationName}`,
        );
    }
  })();
  return json({ data: { [request.operationName]: value } });
};

const reconcile = (source: { image: string } | { repo: string }) =>
  Effect.gen(function* () {
    const requests: GraphqlRequest[] = [];
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        const body = request.body as HttpBody.HttpBody;
        const bodyText =
          body._tag === "Uint8Array" ? new TextDecoder().decode(body.body) : "";
        const graphql = JSON.parse(bodyText) as GraphqlRequest;
        requests.push(graphql);
        return HttpClientResponse.fromWeb(request, responseFor(graphql));
      }),
    );
    const dependencies = Layer.mergeAll(
      PlatformServices,
      Layer.succeed(Stack, {
        name: "test-stack",
        stage: "test-stage",
        resources: {},
        bindings: {},
        actions: {},
      }),
      Layer.succeed(AlchemyContext, {
        dotAlchemy: "/tmp/.alchemy-railway-service-provider-test",
        dev: false,
        adopt: false,
      }),
      CredentialsFromToken({
        token: "credential-free-test-token",
        apiBaseUrl: "https://railway.test",
      }),
      Layer.succeed(HttpClient.HttpClient, client),
    );

    return yield* Service.Provider.pipe(
      Effect.flatMap((provider) =>
        provider.reconcile({
          id: "Service",
          fqn: "Service",
          instanceId: "Service",
          news: {
            project: { projectId: PROJECT_ID },
            environment: { environmentId: ENVIRONMENT_ID },
            name: service.name,
            ...source,
          } as any,
          olds: {
            project: { projectId: PROJECT_ID },
            environment: { environmentId: ENVIRONMENT_ID },
            name: service.name,
            context: "unused-context",
            dockerfilePath: contextInstance.dockerfilePath,
          } as any,
          output: {
            serviceId: SERVICE_ID,
            name: service.name,
            projectId: PROJECT_ID,
            environmentId: ENVIRONMENT_ID,
            image: undefined,
            repo: undefined,
            healthcheckPath: undefined,
            healthcheckTimeout: undefined,
            replicas: 3,
            buildCommand: undefined,
            startCommand: undefined,
            cronSchedule: undefined,
            rootDirectory: undefined,
            region: undefined,
            port: undefined,
            url: undefined,
            domain: domain.domain,
            dnsName: `${service.name}.railway.internal`,
            rpcToken: "test-rpc-token",
            domainId: domain.id,
            deploymentId: successfulDeployment.id,
            deploymentStatus: successfulDeployment.status,
            code: { hash: "" },
          },
          session: undefined as any,
          bindings: [],
        }),
      ),
      Effect.as(requests),
      Effect.provide(ServiceProvider().pipe(Layer.provideMerge(dependencies))),
    );
  });

const updateInput = (requests: GraphqlRequest[]) => {
  const request = requests.find(
    ({ operationName }) => operationName === "serviceInstanceUpdate",
  );
  expect(request).toBeDefined();
  return request!.variables.input;
};

describe("Railway ServiceProvider source transitions", () => {
  it.effect(
    "clears a prior context dockerfilePath when switching to an image",
    () =>
      reconcile({ image: "hashicorp/http-echo" }).pipe(
        Effect.map((requests) => {
          expect(updateInput(requests)).toEqual({
            source: { image: "hashicorp/http-echo" },
            dockerfilePath: null,
            numReplicas: 3,
          });
        }),
      ),
  );

  it.effect(
    "clears a prior context dockerfilePath when switching to a repo with no path",
    () =>
      reconcile({ repo: "alchemy-run/example" }).pipe(
        Effect.map((requests) => {
          expect(updateInput(requests)).toEqual({
            source: { repo: "alchemy-run/example" },
            dockerfilePath: null,
            numReplicas: 3,
          });
        }),
      ),
  );
});
