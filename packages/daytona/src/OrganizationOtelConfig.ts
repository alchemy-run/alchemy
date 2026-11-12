import * as organizations from "@distilled.cloud/daytona/organizations";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { declarable } from "./internal/Declared.ts";
import {
  currentOrganizationId,
  movesOrganization,
  organizationIdFor,
  type OrganizationRef,
} from "./internal/Organization.ts";
import type { Ref } from "./internal/Ref.ts";
import type { Providers } from "./Providers.ts";

export interface OrganizationOtelConfigProps {
  /**
   * Organization to act on, e.g. a `Daytona.Organization`. Defaults to the
   * credentials' organization. Changing it replaces the resource.
   */
  organization?: Ref<OrganizationRef>;
  /** OTLP/HTTP endpoint sandboxes export telemetry to. */
  endpoint: string;
  /** Headers sent with every export, e.g. an API key. */
  headers?: Record<string, string | Redacted.Redacted<string>>;
}

export interface OrganizationOtelConfigAttributes {
  /** Organization ID. */
  organizationId: string;
  /** OTLP endpoint. */
  endpoint: string;
  /** Header names configured (values are not returned). */
  headerNames: string[];
}

export type OrganizationOtelConfig = Resource<
  "Daytona.OrganizationOtelConfig",
  OrganizationOtelConfigProps,
  OrganizationOtelConfigAttributes,
  never,
  Providers
>;

/**
 * Export the organization's sandbox telemetry (logs, traces, metrics) to
 * your own OpenTelemetry backend. One per organization; destroying it
 * stops the export.
 *
 * ### Exporting Telemetry
 * **Example:** Send sandbox telemetry to Axiom
 * ```typescript
 * export const Telemetry = Daytona.OrganizationOtelConfig("Telemetry", {
 *   endpoint: "https://api.axiom.co",
 *   headers: {
 *     Authorization: Config.Redacted("AXIOM_TOKEN"),
 *     "X-Axiom-Dataset": "daytona",
 *   },
 * });
 * ```
 *
 * @resource
 * @product Organization
 */
export const OrganizationOtelConfig = declarable<OrganizationOtelConfig>()(
  Resource<OrganizationOtelConfig>("Daytona.OrganizationOtelConfig"),
);

const plainHeaders = (headers: OrganizationOtelConfigProps["headers"]) =>
  headers === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(headers).map(([k, v]) => [
          k,
          Redacted.isRedacted(v) ? Redacted.value(v) : v,
        ]),
      );

// Daytona stores the endpoint normalized (`https://host` -> `https://host/`).
const sameEndpoint = (observed: string | undefined, desired: string) =>
  observed !== undefined && URL.canParse(observed) && URL.canParse(desired)
    ? new URL(observed).href === new URL(desired).href
    : observed === desired;

// getOrganizationOtelConfig is for Daytona's runners and proxy (users get
// 401); the organization itself carries the config.
const observeOtelConfig = (organizationId: string) =>
  Effect.map(organizations.getOrganization({ organizationId }), (o) => o.otelConfig);

export const OrganizationOtelConfigProvider = () =>
  Provider.effect(
    OrganizationOtelConfig,
    Effect.succeed({
      stables: ["organizationId"],
      nuke: { singleton: true },
      list: () => Effect.succeed([]),
      diff: Effect.fn(function* ({ news, output }) {
        if (!isResolved(news) || output === undefined) return undefined;
        if (yield* movesOrganization(news.organization, output))
          return { action: "replace" } as const;
      }),
      read: Effect.fn(function* ({ output }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        const config = yield* observeOtelConfig(organizationId);
        if (!config?.endpoint) return undefined;
        return {
          organizationId,
          endpoint: config.endpoint,
          headerNames: Object.keys(config.headers ?? {}),
        };
      }),
      reconcile: Effect.fn(function* ({ news, olds }) {
        const organizationId = yield* organizationIdFor(news.organization);
        // Observe — header values aren't returned, so they are written
        // whenever they changed since the last deploy (or on first deploy).
        const current = yield* observeOtelConfig(organizationId);
        const headers = plainHeaders(news.headers);
        if (
          !sameEndpoint(current?.endpoint, news.endpoint) ||
          olds === undefined ||
          !deepEqual(plainHeaders(olds.headers), headers)
        ) {
          yield* organizations.updateOrganizationOtelConfig({
            organizationId,
            endpoint: news.endpoint,
            headers,
          });
        }
        return { organizationId, endpoint: news.endpoint, headerNames: Object.keys(headers ?? {}) };
      }),
      delete: Effect.fn(function* ({ output }) {
        yield* organizations
          .deleteOrganizationOtelConfig({ organizationId: output.organizationId })
          .pipe(Effect.catchTag("OrganizationNotFound", () => Effect.void));
      }),
    }),
  );
