import {
  deleteServiceDomainById,
  findServiceDomainById,
} from "@/Railway/ServiceDomain.ts";
import {
  CredentialsFromToken,
  type DomainsResponseServiceDomainsItem,
} from "@distilled.cloud/railway";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

const domain = (
  id: string,
  serviceId = "service-1",
): DomainsResponseServiceDomainsItem => ({
  cdnMode: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
  domain: `${id}.up.railway.app`,
  edgeId: null,
  environmentId: "environment-1",
  id,
  newDomainName: null,
  newHostLabel: null,
  projectId: "project-1",
  serviceId,
  suffix: "up.railway.app",
  syncStatus: "ACTIVE",
  targetPort: 3000,
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const harness = (initial: DomainsResponseServiceDomainsItem[]) => {
  const domains = [...initial];
  const deletes: string[] = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const body = request.body as HttpBody.HttpBody;
      const text =
        body._tag === "Uint8Array" ? new TextDecoder().decode(body.body) : "";
      const payload = JSON.parse(text) as {
        operationName: string;
        variables: Record<string, unknown>;
      };
      if (payload.operationName === "domains") {
        return HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify({
              data: { domains: { customDomains: [], serviceDomains: domains } },
            }),
            { headers: { "content-type": "application/json" } },
          ),
        );
      }
      if (payload.operationName === "serviceDomainDelete") {
        const id = payload.variables.id as string;
        deletes.push(id);
        const index = domains.findIndex((candidate) => candidate.id === id);
        if (index !== -1) domains.splice(index, 1);
        return HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify({ data: { serviceDomainDelete: true } }),
            {
              headers: { "content-type": "application/json" },
            },
          ),
        );
      }
      throw new Error(`Unexpected operation ${payload.operationName}`);
    }),
  );
  const layer = Layer.mergeAll(
    CredentialsFromToken({ token: "test-token", apiBaseUrl: "https://test" }),
    Layer.succeed(HttpClient.HttpClient, client),
  );
  return { layer, domains, deletes };
};

const identity = {
  projectId: "project-1",
  environmentId: "environment-1",
  serviceId: "service-1",
};

describe("Railway Service generated-domain ownership", () => {
  it.effect("reads only the recorded generated domain", () => {
    const { layer } = harness([domain("owned"), domain("foreign")]);
    return Effect.gen(function* () {
      const owned = yield* findServiceDomainById({
        ...identity,
        domainId: "owned",
      });
      const missing = yield* findServiceDomainById({
        ...identity,
        domainId: "not-recorded",
      });
      expect(owned?.id).toEqual("owned");
      expect(owned?.url).toEqual("https://owned.up.railway.app");
      expect(missing).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.effect("deletes only the recorded generated domain", () => {
    const { layer, domains, deletes } = harness([
      domain("owned"),
      domain("foreign"),
    ]);
    return Effect.gen(function* () {
      yield* deleteServiceDomainById({ ...identity, domainId: "owned" });
      expect(deletes).toEqual(["owned"]);
      expect(domains.map((candidate) => candidate.id)).toEqual(["foreign"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not delete an unrecorded generated domain", () => {
    const { layer, domains, deletes } = harness([domain("foreign")]);
    return Effect.gen(function* () {
      yield* deleteServiceDomainById({
        ...identity,
        domainId: "not-recorded",
      });
      expect(deletes).toEqual([]);
      expect(domains.map((candidate) => candidate.id)).toEqual(["foreign"]);
    }).pipe(Effect.provide(layer));
  });
});
