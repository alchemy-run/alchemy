import * as organizations from "@distilled.cloud/daytona/organizations";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isOwnedName, resolveName } from "./internal/Names.ts";
import type { Providers } from "./Providers.ts";

export interface RegionProps {
  /** Region name. If omitted, generated from the stack, stage and logical ID. Changing it replaces the region. */
  name?: string;
  /** URL of the region's sandbox proxy. */
  proxyUrl?: string;
  /** URL of the region's SSH gateway. */
  sshGatewayUrl?: string;
  /** URL of the region's snapshot manager (image registry). */
  snapshotManagerUrl?: string;
  /** OTLP endpoint the region's runners export to. */
  otelEndpoint?: string;
  /** S3 bucket for Dockerfile build contexts. */
  buildContextBucket?: string;
  /** Region of that bucket. */
  buildContextBucketRegion?: string;
  /** IAM role Daytona assumes to use the bucket. */
  buildContextRoleArn?: string;
  /**
   * Bump a counter to rotate that credential on the next deploy.
   */
  rotate?: { proxyApiKey?: number; sshGatewayApiKey?: number; snapshotManagerCredentials?: number };
}

export interface RegionAttributes {
  /** Region ID; what runners, snapshots and sandboxes take. */
  regionId: string;
  /** Region name. */
  name: string;
  /** API key the region's proxy authenticates with. */
  proxyApiKey: Redacted.Redacted<string> | undefined;
  /** API key the region's SSH gateway authenticates with. */
  sshGatewayApiKey: Redacted.Redacted<string> | undefined;
  /** Snapshot manager user name. */
  snapshotManagerUsername: string | undefined;
  /** Snapshot manager password. */
  snapshotManagerPassword: Redacted.Redacted<string> | undefined;
  /** Rotation counters applied. */
  rotated: { proxyApiKey: number; sshGatewayApiKey: number; snapshotManagerCredentials: number };
}

export type Region = Resource<"Daytona.Region", RegionProps, RegionAttributes, never, Providers>;

/**
 * A custom region: your own compute (see {@link Runner}) registered with
 * Daytona, so sandboxes run on machines you operate while Daytona runs
 * the control plane. Needs an organization allowed to bring its own
 * compute.
 *
 * Daytona shows the region's API keys only when they are created or
 * rotated, so alchemy keeps them in state as `Redacted` values. Bump a
 * `rotate` counter to rotate one.
 * @see https://www.daytona.io/docs/en/regions/
 *
 * ### Bringing Your Own Compute
 * **Example:** A region with its own proxy and SSH gateway
 * ```typescript
 * export const Home = Daytona.Region("Home", {
 *   proxyUrl: "https://proxy.daytona.example.com",
 *   sshGatewayUrl: "ssh.daytona.example.com:2222",
 * });
 * ```
 *
 * @resource
 * @product Region
 */
export const Region = Resource<Region>("Daytona.Region");

const redact = (value: string | Redacted.Redacted<string> | null | undefined) =>
  value === null || value === undefined
    ? undefined
    : Redacted.isRedacted(value)
      ? value
      : Redacted.make(value);

const getById = (id: string) =>
  organizations.getRegion({ id }).pipe(Effect.catchTag("RegionNotFound", () => Effect.undefined));

const findByName = (name: string) =>
  organizations
    .listAvailableRegions({})
    .pipe(Effect.map((all) => all.find((r) => r.name === name)));

export const RegionProvider = () =>
  Provider.effect(
    Region,
    Effect.succeed({
      stables: ["regionId"],
      list: Effect.fn(function* () {
        const all = yield* organizations.listAvailableRegions({});
        return all
          .filter((r) => r.organizationId)
          .map((r) => ({
            regionId: r.id,
            name: r.name,
            proxyApiKey: undefined,
            sshGatewayApiKey: undefined,
            snapshotManagerUsername: undefined,
            snapshotManagerPassword: undefined,
            rotated: { proxyApiKey: 0, sshGatewayApiKey: 0, snapshotManagerCredentials: 0 },
          }));
      }),
      diff: Effect.fn(function* ({ id, news, output }) {
        if (!isResolved(news) || output === undefined) return undefined;
        const name = yield* resolveName(
          id,
          news.name,
          news.name === undefined ? output.name : undefined,
        );
        if (name !== output.name) return { action: "replace", deleteFirst: true } as const;
      }),
      read: Effect.fn(function* ({ id, olds, output }) {
        const name = yield* resolveName(id, olds?.name, output?.name);
        const found =
          (output ? yield* getById(output.regionId) : undefined) ?? (yield* findByName(name));
        if (found === undefined) return undefined;
        const attrs: RegionAttributes = output ?? {
          regionId: found.id,
          name: found.name,
          proxyApiKey: undefined,
          sshGatewayApiKey: undefined,
          snapshotManagerUsername: undefined,
          snapshotManagerPassword: undefined,
          rotated: { proxyApiKey: 0, sshGatewayApiKey: 0, snapshotManagerCredentials: 0 },
        };
        return (yield* isOwnedName(id, found.name, output !== undefined)) ? attrs : Unowned(attrs);
      }),
      reconcile: Effect.fn(function* ({ id, news, output }) {
        const name = yield* resolveName(id, news.name, output?.name);
        const settings = {
          proxyUrl: news.proxyUrl ?? null,
          sshGatewayUrl: news.sshGatewayUrl ?? null,
          snapshotManagerUrl: news.snapshotManagerUrl ?? null,
          otelEndpoint: news.otelEndpoint ?? null,
          buildContextBucket: news.buildContextBucket ?? null,
          buildContextBucketRegion: news.buildContextBucketRegion ?? null,
          buildContextRoleArn: news.buildContextRoleArn ?? null,
        };
        // Observe
        const current =
          (output ? yield* getById(output.regionId) : undefined) ?? (yield* findByName(name));
        let attrs: RegionAttributes;
        // Ensure
        if (current === undefined) {
          const created = yield* organizations.createRegion({ name, ...settings });
          attrs = {
            regionId: created.id,
            name,
            proxyApiKey: redact(created.proxyApiKey),
            sshGatewayApiKey: redact(created.sshGatewayApiKey),
            snapshotManagerUsername: created.snapshotManagerUsername ?? undefined,
            snapshotManagerPassword: redact(created.snapshotManagerPassword),
            rotated: {
              proxyApiKey: news.rotate?.proxyApiKey ?? 0,
              sshGatewayApiKey: news.rotate?.sshGatewayApiKey ?? 0,
              snapshotManagerCredentials: news.rotate?.snapshotManagerCredentials ?? 0,
            },
          };
        } else {
          attrs = output ?? {
            regionId: current.id,
            name,
            proxyApiKey: undefined,
            sshGatewayApiKey: undefined,
            snapshotManagerUsername: undefined,
            snapshotManagerPassword: undefined,
            rotated: { proxyApiKey: 0, sshGatewayApiKey: 0, snapshotManagerCredentials: 0 },
          };
          // Sync settings against the observed region.
          const drift = (Object.keys(settings) as (keyof typeof settings)[]).some(
            (k) => (current[k] ?? null) !== settings[k],
          );
          if (drift) yield* organizations.updateRegion({ id: current.id, ...settings });
        }
        // Sync rotations.
        const want = news.rotate ?? {};
        if ((want.proxyApiKey ?? 0) !== attrs.rotated.proxyApiKey) {
          const { apiKey } = yield* organizations.regenerateProxyApiKey({ id: attrs.regionId });
          attrs = {
            ...attrs,
            proxyApiKey: redact(apiKey),
            rotated: { ...attrs.rotated, proxyApiKey: want.proxyApiKey ?? 0 },
          };
        }
        if ((want.sshGatewayApiKey ?? 0) !== attrs.rotated.sshGatewayApiKey) {
          const { apiKey } = yield* organizations.regenerateSshGatewayApiKey({
            id: attrs.regionId,
          });
          attrs = {
            ...attrs,
            sshGatewayApiKey: redact(apiKey),
            rotated: { ...attrs.rotated, sshGatewayApiKey: want.sshGatewayApiKey ?? 0 },
          };
        }
        if ((want.snapshotManagerCredentials ?? 0) !== attrs.rotated.snapshotManagerCredentials) {
          const creds = yield* organizations.regenerateSnapshotManagerCredentials({
            id: attrs.regionId,
          });
          attrs = {
            ...attrs,
            snapshotManagerUsername: creds.username,
            snapshotManagerPassword: redact(creds.password),
            rotated: {
              ...attrs.rotated,
              snapshotManagerCredentials: want.snapshotManagerCredentials ?? 0,
            },
          };
        }
        return attrs;
      }),
      delete: Effect.fn(function* ({ output }) {
        yield* organizations
          .deleteRegion({ id: output.regionId })
          .pipe(Effect.catchTag("RegionNotFound", () => Effect.void));
      }),
    }),
  );
