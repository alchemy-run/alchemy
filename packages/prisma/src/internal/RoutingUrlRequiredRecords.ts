import {
  getProject,
  getService,
  getWorkspaceDomainOwnershipsVerification,
} from "@distilled.cloud/prisma/management";
import type * as DNS from "alchemy/DNS/Adapter";
import type { Input } from "alchemy/Input";
import * as Namespace from "alchemy/Namespace";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { App } from "../App.ts";
import type { Compute } from "../Compute.ts";
import type { Providers } from "../Providers.ts";
import { switchboardTarget } from "./Switchboard.ts";

export class RoutingUrlOperationFailed extends Data.TaggedError("RoutingUrlOperationFailed")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type AppReference = string | App | Compute;

export const normalizeHostname = (hostname: string) =>
  hostname.trim().replace(/\.$/, "").toLowerCase();

export const appIdValue = (app: AppReference | undefined) =>
  typeof app === "string" ? app : app?.appId;

export const resolveServiceId = (app: AppReference) => {
  const value = appIdValue(app);
  return typeof value === "string"
    ? Effect.succeed(value)
    : Effect.fail(
        new RoutingUrlOperationFailed({ message: "Unable to resolve the Prisma app id." }),
      );
};

export interface RoutingUrlRequiredRecordsProps {
  /** App ID or Compute output whose service the hostname serves. */
  app: AppReference;
  /** Hostname, normalized. */
  hostname: string;
}

/**
 * Every DNS record a RoutingUrl's hostname needs, met or not: the `TXT` with
 * the workspace's verification value and the `CNAME` to the app's regional
 * switchboard, read from Prisma. A RoutingUrl's `records` lists only those
 * still to publish, so it cannot drive a DNS host. It reads the same
 * verification endpoint as `Prisma.DomainVerification`, and also the app's
 * switchboard, from inside the provider so an app id from any source works.
 * It creates nothing in Prisma, so deleting it does nothing.
 */
export interface RoutingUrlRequiredRecords extends Resource<
  "Prisma.RoutingUrlRequiredRecords",
  RoutingUrlRequiredRecordsProps,
  {
    serviceId: string;
    workspaceId: string;
    hostname: string;
    records: DNS.DnsRecord[];
  },
  never,
  Providers
> {}

export const RoutingUrlRequiredRecords = Resource<RoutingUrlRequiredRecords>(
  "Prisma.RoutingUrlRequiredRecords",
);

/**
 * The required records for `hostname`, declared under the RoutingUrl `id`.
 * Each hostname gets its own resources, so a hostname change creates new ones
 * and removes the old ones only after the change is saved.
 */
export const requiredRecords = (id: string, app: Input<AppReference>, hostname: string) =>
  RoutingUrlRequiredRecords(`RequiredRecords-${hostname}`, { app, hostname }).pipe(
    Namespace.push(id),
  );

/** The id of the DNS host's record set for `hostname`, under the RoutingUrl `id`. */
export const publishedRecordsId = (hostname: string) => `Records-${hostname}`;

/** The `CNAME` value among the required records. */
export const cnameTarget = (records: ReadonlyArray<DNS.DnsRecord>) =>
  records.find((record) => record.type === "CNAME")?.value ?? "";

export const RoutingUrlRequiredRecordsProvider = () =>
  Provider.effect(
    RoutingUrlRequiredRecords,
    Effect.gen(function* () {
      return {
        read: Effect.fn(function* ({ output }) {
          return output;
        }),
        reconcile: Effect.fn(function* ({ news }) {
          const serviceId = yield* resolveServiceId(news.app);
          const service = (yield* getService({ serviceId })).data;
          if (!service.appEndpointDomain) {
            return yield* new RoutingUrlOperationFailed({
              message: `Prisma app '${serviceId}' has no endpoint domain, so '${news.hostname}' has no switchboard to point at; nothing was published.`,
            });
          }
          const workspaceId = (yield* getProject({ id: service.projectId })).data.workspace.id;
          const hostname = normalizeHostname(news.hostname);
          const verification = (yield* getWorkspaceDomainOwnershipsVerification({
            workspaceId,
            domain: hostname,
          })).data;
          return {
            serviceId,
            workspaceId,
            hostname,
            records: [
              { name: verification.name, type: "TXT" as const, value: verification.value },
              {
                name: hostname,
                type: "CNAME" as const,
                value: switchboardTarget(service.appEndpointDomain),
              },
            ],
          };
        }),
        delete: Effect.fn(function* () {}),
      };
    }),
  );
