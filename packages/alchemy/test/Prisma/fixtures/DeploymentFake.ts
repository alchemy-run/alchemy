import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { AlchemyContext } from "@/AlchemyContext";
import { Deployment as PrismaDeployment, DeploymentProvider } from "@/Prisma/Deployment";
import { PrismaUploadClient } from "@/Prisma/Internal/HttpClient";
import * as Provider from "@/Provider";
import { PlatformServices } from "@/Util/PlatformServices";
import {
  data,
  FAKE_API_BASE_URL,
  failure,
  makeFakeManagementApi,
  noContent,
  notFound,
  page,
  unhandled,
} from "./FakeManagementApi.ts";

/**
 * An in-memory Prisma App/deployment cloud served over the fake Management
 * API, with switches for the faults the real API cannot produce on demand.
 */

export const SIGNED_URL_SECRET = "SIGNED_QUERY_SECRET_SENTINEL";
export const UPLOAD_HOST = "upload.prisma.test";
export const UPLOAD_ERROR_BODY = "SIGNED_UPLOAD_SECRET_SENTINEL";

const createdAt = "2026-01-01T00:00:00.000Z";

export interface FakeDeployment {
  id: string;
  serviceId: string;
  foundryVersionId: string;
  status: string;
  previewDomain: string | null;
}

export interface FakeApp {
  latestDeploymentId: string | null;
}

export type UploadMode =
  /** Accept the upload and record it. */
  | "accept"
  /** Answer HTTP 500 with a body. */
  | "status500"
  /** Fail in transport, with the signed URL in the error. */
  | "transportError"
  /** Rewrite the artifact on disk, then stream the (now stale) body. */
  | "mutateFile";

export interface DeploymentCloudOptions {
  /** `null` makes the create route omit the upload URL. */
  uploadUrl?: null;
  upload?: UploadMode;
  /** File rewritten by the `mutateFile` upload mode. */
  mutatePath?: string;
  startFails?: boolean;
  deleteFails?: boolean;
  /** Promote and the canonical rollback recovery both fail. */
  promotionFails?: boolean;
  /** A stop leaves the deployment in `stopping` until released. */
  stickyStop?: boolean;
}

export interface Upload {
  readonly url: string;
  readonly contentType: string | undefined;
  readonly bytes: Uint8Array;
}

export const makeDeploymentCloud = (options: DeploymentCloudOptions = {}) => {
  const knobs = { ...options };
  const apps = new Map<string, FakeApp>([["service-1", { latestDeploymentId: null }]]);
  const deployments = new Map<string, FakeDeployment>();
  const createBodies: unknown[] = [];
  const uploads: Upload[] = [];
  const uploadFailures: string[] = [];
  /** Hook run on every deployment read, e.g. to advance a patched clock. */
  const onGetDeployment: Array<(deployment: FakeDeployment) => void> = [];
  let next = 0;

  const appOf = (id: string) => {
    let app = apps.get(id);
    if (!app) {
      app = { latestDeploymentId: null };
      apps.set(id, app);
    }
    return app;
  };

  const wireDeployment = (deployment: FakeDeployment) => ({
    id: deployment.id,
    type: "deployment",
    url: `${FAKE_API_BASE_URL}/v1/deployments/${deployment.id}`,
    serviceId: deployment.serviceId,
    foundryVersionId: deployment.foundryVersionId,
    status: deployment.status,
    previewDomain: deployment.previewDomain,
    createdAt,
  });

  const wireApp = (id: string) => ({
    id,
    type: "app",
    url: `${FAKE_API_BASE_URL}/v1/services/${id}`,
    name: "api",
    region: { id: "us-east-1", name: "US East" },
    projectId: "project-1",
    branchId: null,
    latestDeploymentId: appOf(id).latestDeploymentId,
    appEndpointDomain: `${id}.prisma.build`,
    createdAt,
    logicalId: null,
  });

  const fake = makeFakeManagementApi((request) => {
    // segments[0] is the "v1" prefix.
    const [head, id, tail] = request.pathname
      .split("/")
      .filter((segment) => segment.length > 0)
      .slice(1);
    const body = request.bodyJson as Record<string, unknown> | undefined;

    if (head === "services" && id !== undefined) {
      if (tail === "deployments" && request.method === "GET") {
        return page(
          Array.from(deployments.values())
            .filter((deployment) => deployment.serviceId === id)
            .map(({ id, serviceId, foundryVersionId }) => ({
              id,
              type: "deployment",
              url: `${FAKE_API_BASE_URL}/v1/deployments/${id}`,
              serviceId,
              foundryVersionId,
              createdAt,
            })),
        );
      }
      if (tail === "deployments" && request.method === "POST") {
        createBodies.push(body);
        next += 1;
        const deployment: FakeDeployment = {
          id: `version-${next}`,
          serviceId: id,
          foundryVersionId: `foundry-${next}`,
          status: "new",
          previewDomain: null,
        };
        deployments.set(deployment.id, deployment);
        return data({
          id: deployment.id,
          type: "deployment",
          url: `${FAKE_API_BASE_URL}/v1/deployments/${deployment.id}`,
          foundryVersionId: deployment.foundryVersionId,
          uploadUrl:
            knobs.uploadUrl === null
              ? null
              : `https://${UPLOAD_HOST}/${deployment.id}.tar.gz?signature=${SIGNED_URL_SECRET}`,
        });
      }
      if ((tail === "promote" || tail === "rollback") && request.method === "POST") {
        if (knobs.promotionFails) {
          return failure(400, "error", `${tail} failed`);
        }
        const deploymentId = body?.deploymentId as string;
        appOf(id).latestDeploymentId = deploymentId;
        return data({ appEndpointDomain: `${id}.prisma.build`, reassignedDomains: 0 });
      }
      if (tail === undefined && request.method === "GET") {
        return data(wireApp(id));
      }
    }

    if (head === "deployments" && id !== undefined) {
      const deployment = deployments.get(id);
      if (!deployment) return notFound("deployment not found");
      if (tail === "start" && request.method === "POST") {
        if (knobs.startFails) return failure(400, "error", "start failed");
        deployment.status = "running";
        deployment.previewDomain = `${deployment.id}.preview.prisma.build`;
        return data({ previewDomain: deployment.previewDomain });
      }
      if (tail === "stop" && request.method === "POST") {
        deployment.status = knobs.stickyStop ? "stopping" : "stopped";
        return noContent();
      }
      if (tail === undefined && request.method === "GET") {
        for (const hook of onGetDeployment) hook(deployment);
        return data(wireDeployment(deployment));
      }
      if (tail === undefined && request.method === "DELETE") {
        if (knobs.deleteFails) return failure(400, "error", "cleanup failed");
        deployments.delete(id);
        return noContent();
      }
    }
    return unhandled(request);
  });

  const transportError =
    (request: Parameters<Parameters<typeof HttpClient.make>[0]>[0]) => (cause: unknown) =>
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({
          request,
          cause,
          description: `transport failed for ${request.url}`,
        }),
      });

  const collect = (body: HttpBody.HttpBody): Effect.Effect<Uint8Array, unknown> =>
    body._tag === "Uint8Array"
      ? Effect.succeed(body.body)
      : body._tag === "Stream"
        ? Stream.runCollect(body.stream).pipe(
            Effect.map((chunks) => {
              const output = new Uint8Array(
                chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
              );
              let offset = 0;
              for (const chunk of chunks) {
                output.set(chunk, offset);
                offset += chunk.byteLength;
              }
              return output;
            }),
          )
        : Effect.succeed(new Uint8Array());

  const uploadLayer = Layer.effect(
    PrismaUploadClient,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return HttpClient.make((request) =>
        Effect.gen(function* () {
          const body = request.body as HttpBody.HttpBody;
          const mode = knobs.upload ?? "accept";
          if (mode === "transportError") {
            return yield* Effect.fail(transportError(request)(new Error(request.url)));
          }
          if (mode === "mutateFile") {
            yield* fs
              .writeFileString(knobs.mutatePath!, "changed after validation")
              .pipe(Effect.mapError(transportError(request)));
          }
          const bytes = yield* collect(body).pipe(
            Effect.tapError((cause) =>
              Effect.sync(() => {
                uploadFailures.push(cause instanceof Error ? cause.message : String(cause));
              }),
            ),
            Effect.mapError(transportError(request)),
          );
          if (mode === "status500") {
            return HttpClientResponse.fromWeb(
              request,
              new Response(UPLOAD_ERROR_BODY, { status: 500 }),
            );
          }
          uploads.push({
            url: request.url,
            contentType:
              body._tag === "Uint8Array" || body._tag === "Stream" ? body.contentType : undefined,
            bytes,
          });
          return HttpClientResponse.fromWeb(request, new Response(null));
        }),
      );
    }),
  ).pipe(Layer.provide(PlatformServices));

  return {
    fake,
    knobs,
    apps,
    deployments,
    createBodies,
    uploads,
    uploadFailures,
    onGetDeployment,
    uploadLayer,
    appOf,
  };
};

export type DeploymentCloud = ReturnType<typeof makeDeploymentCloud>;

class TestPrismaProviders extends Provider.ProviderCollection<TestPrismaProviders>()("Prisma") {}

const liveProviderContext = Layer.succeed(AlchemyContext, {
  dotAlchemy: ".alchemy-test",
  dev: false,
  adopt: false,
});

/** The live Deployment provider over the fake cloud, for `Test.make({ providers })`. */
export const deploymentLayer = (cloud: DeploymentCloud) =>
  Layer.effect(TestPrismaProviders, Provider.collection([PrismaDeployment])).pipe(
    Layer.provideMerge(DeploymentProvider()),
    Layer.provide(liveProviderContext),
    Layer.provideMerge(Layer.mergeAll(cloud.fake.layer, cloud.uploadLayer)),
  );
