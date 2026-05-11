import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { Stack } from "../../Stack.ts";
import { Stage } from "../../Stage.ts";
import * as api from "../api.ts";
import type { Providers } from "../Providers.ts";

/**
 * Common shared-CPU plan slugs. The list is non-exhaustive — any string
 * accepted by the Vultr API works at runtime; this union is here purely
 * for editor autocomplete on the most common picks.
 *
 * @see https://api.vultr.com/v2/plans
 */
export type SharedCpuPlan =
  | "vc2-1c-1gb"
  | "vc2-1c-2gb"
  | "vc2-2c-4gb"
  | "vc2-4c-8gb"
  | "vc2-6c-16gb"
  | "vc2-8c-32gb"
  | (string & {});

/**
 * Region slug. Non-exhaustive union for ergonomics.
 *
 * @see https://api.vultr.com/v2/regions
 */
export type VultrRegion =
  | "ewr"
  | "ord"
  | "dfw"
  | "sea"
  | "lax"
  | "atl"
  | "ams"
  | "lhr"
  | "fra"
  | "sjc"
  | "syd"
  | "nrt"
  | "sgp"
  | (string & {});

export type InstanceStatus = api.InstanceStatus;
export type PowerStatus = api.PowerStatus;
export type ServerStatus = api.ServerStatus;

export type InstanceProps = {
  /**
   * Region slug to deploy into. Cannot be changed after creation —
   * triggers a replace.
   */
  region: VultrRegion;
  /**
   * Plan slug, e.g. `vc2-1c-1gb`. Resizing in-place requires the
   * instance to be powered off, so the provider treats plan changes as
   * a replace.
   */
  plan: SharedCpuPlan;
  /**
   * Vultr OS ID. Mutually exclusive with `appId`, `imageId`,
   * `snapshotId`, `isoId`. Cannot be changed after creation.
   *
   * @see https://api.vultr.com/v2/os
   */
  osId?: number;
  /**
   * Marketplace app ID (e.g. WordPress, Docker). Mutually exclusive
   * with `osId`. Cannot be changed after creation.
   */
  appId?: number;
  /**
   * Application image slug. Mutually exclusive with `osId`. Cannot be
   * changed after creation.
   */
  imageId?: string;
  /**
   * Snapshot ID to restore from. Cannot be changed after creation.
   */
  snapshotId?: string;
  /**
   * ISO ID to boot from. Cannot be changed after creation.
   */
  isoId?: string;
  /**
   * Human-readable label shown in the Vultr console. If omitted, a
   * label is generated from `${stack}-${id}-${stage}`.
   */
  label?: string;
  /**
   * Hostname assigned to the instance OS. Defaults to the label when
   * omitted. Cannot be changed after creation.
   */
  hostname?: string;
  /**
   * SSH key IDs to install on first boot. Cannot be changed after
   * creation.
   */
  sshKeyIds?: string[];
  /**
   * Tags applied to the instance in addition to the `alchemy:*`
   * branding tags.
   */
  tags?: string[];
  /**
   * Cloud-init user data. Sent base64-encoded by the API; pass plain
   * text here.
   */
  userData?: string;
  /**
   * Whether automated backups are enabled.
   *
   * @default "disabled"
   */
  backups?: "enabled" | "disabled";
  /**
   * Whether IPv6 is enabled. Cannot be changed after creation.
   *
   * @default false
   */
  enableIpv6?: boolean;
  /**
   * Whether DDoS protection is enabled (region-dependent).
   *
   * @default false
   */
  ddosProtection?: boolean;
  /**
   * Firewall group ID to attach.
   */
  firewallGroupId?: string;
};

export type InstanceAttrs = {
  instanceId: string;
  label: string;
  hostname: string;
  region: string;
  plan: string;
  osId: number;
  appId: number;
  imageId: string;
  mainIp: string;
  internalIp: string;
  v6MainIp: string;
  status: InstanceStatus;
  powerStatus: PowerStatus;
  serverStatus: ServerStatus;
  ramMb: number;
  diskGb: number;
  vcpuCount: number;
  tags: string[];
  backups: "enabled" | "disabled";
  enableIpv6: boolean;
  ddosProtection: boolean;
  firewallGroupId: string;
  /**
   * Initial root password. Captured only at creation time and never
   * refreshed; rotate via the Vultr console / API.
   */
  defaultPassword: Redacted.Redacted<string> | undefined;
  dateCreated: string;
};

export type Instance = Resource<
  "Vultr.Compute.Instance",
  InstanceProps,
  InstanceAttrs,
  never,
  Providers
>;

/**
 * A Vultr Cloud Compute (shared-CPU) instance.
 *
 * @section Creating an Instance
 * @example Smallest shared-CPU box
 * ```typescript
 * const vm = yield* Vultr.Instance("api", {
 *   region: "ewr",
 *   plan: "vc2-1c-1gb",
 *   osId: 1743, // Ubuntu 22.04 x64
 * });
 * ```
 *
 * @example Cloud-init bootstrap
 * ```typescript
 * const vm = yield* Vultr.Instance("api", {
 *   region: "ewr",
 *   plan: "vc2-1c-2gb",
 *   osId: 1743,
 *   sshKeyIds: ["abc-def"],
 *   userData: "#cloud-config\npackage_update: true\npackages: [docker.io]\n",
 *   tags: ["env:dev", "team:platform"],
 * });
 * ```
 *
 * @section Adoption
 * Instances are branded with `alchemy:stack=…`, `alchemy:stage=…`, and
 * `alchemy:id=…` tags so the provider can rediscover them after state
 * loss. Pre-existing instances without these tags are not adopted
 * implicitly.
 *
 * @see https://www.vultr.com/api/#tag/instances
 */
export const Instance = Resource<Instance>("Vultr.Compute.Instance");

const ALCHEMY_TAG_PREFIXES = [
  "alchemy:stack=",
  "alchemy:stage=",
  "alchemy:id=",
] as const;

const buildAlchemyTags = Effect.fn(function* (id: string) {
  const stack = yield* Stack;
  const stage = yield* Stage;
  return [
    `alchemy:stack=${stack.name}`,
    `alchemy:stage=${stage}`,
    `alchemy:id=${id}`,
  ];
});

const stripAlchemyTags = (tags: ReadonlyArray<string>) =>
  tags.filter(
    (tag) => !ALCHEMY_TAG_PREFIXES.some((prefix) => tag.startsWith(prefix)),
  );

const computeDesiredTags = Effect.fn(function* (
  id: string,
  userTags: ReadonlyArray<string> | undefined,
) {
  const internal = yield* buildAlchemyTags(id);
  return Array.from(new Set([...internal, ...(userTags ?? [])])).sort();
});

const tagsEqual = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) => {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((v, i) => v === sortedB[i]);
};

const defaultLabel = (id: string) =>
  Effect.gen(function* () {
    const stack = yield* Stack;
    const stage = yield* Stage;
    return `${stack.name}-${id}-${stage}`;
  });

/**
 * Find an instance that carries the full set of alchemy branding tags
 * for this `(stack, stage, id)`. Returns `undefined` if no match — used
 * by `read` to recover after state loss without spawning duplicates.
 *
 * Vultr's `?tag=` query is a single-tag filter, so we narrow on
 * `alchemy:id=<id>` (the most selective) and then verify the
 * stack+stage prefixes client-side. Paginates defensively.
 */
const findByAlchemyTags = Effect.fn(function* (id: string) {
  const expected = new Set(yield* buildAlchemyTags(id));
  const idTag = `alchemy:id=${id}`;
  const { instances } = yield* api.listInstances({
    tag: idTag,
    per_page: 100,
  });
  return instances.find((info) =>
    [...expected].every((tag) => (info.tags ?? []).includes(tag)),
  );
});

const toAttrs = (
  info: api.VultrInstanceInfo,
  defaultPassword: Redacted.Redacted<string> | undefined,
): InstanceAttrs => ({
  instanceId: info.id,
  label: info.label,
  hostname: info.hostname,
  region: info.region,
  plan: info.plan,
  osId: info.os_id,
  appId: info.app_id,
  imageId: info.image_id,
  mainIp: info.main_ip,
  internalIp: info.internal_ip,
  v6MainIp: info.v6_main_ip,
  status: info.status,
  powerStatus: info.power_status,
  serverStatus: info.server_status,
  ramMb: info.ram,
  diskGb: info.disk,
  vcpuCount: info.vcpu_count,
  tags: info.tags ?? [],
  backups: info.backups ?? "disabled",
  enableIpv6: !!info.v6_main_ip,
  ddosProtection: (info.features ?? []).includes("ddos_protection"),
  firewallGroupId: info.firewall_group_id ?? "",
  defaultPassword,
  dateCreated: info.date_created,
});

export const InstanceProvider = () =>
  Provider.effect(
    Instance,
    Effect.succeed({
      stables: ["instanceId", "region", "osId", "appId"],

      diff: Effect.fn(function* ({ news, olds, output }) {
        if (!isResolved(news)) return undefined;
        const o = olds ?? ({} as Partial<InstanceProps>);

        // Region & boot-source changes require a fresh instance.
        if (
          news.region !== (output?.region ?? o.region) ||
          (news.osId ?? 0) !== (output?.osId ?? o.osId ?? 0) ||
          (news.appId ?? 0) !== (output?.appId ?? o.appId ?? 0) ||
          (news.imageId ?? "") !== (output?.imageId ?? o.imageId ?? "") ||
          (news.snapshotId ?? "") !== (o.snapshotId ?? "") ||
          (news.isoId ?? "") !== (o.isoId ?? "")
        ) {
          return { action: "replace" } as const;
        }

        // Plan resizing in-place requires powering the instance off,
        // which is more invasive than just rolling a fresh instance.
        if (news.plan !== (output?.plan ?? o.plan)) {
          return { action: "replace" } as const;
        }

        // Hostname & SSH keys are baked at first boot; treat as stable.
        if (
          (news.hostname ?? "") !== (o.hostname ?? "") ||
          !tagsEqual(news.sshKeyIds ?? [], o.sshKeyIds ?? [])
        ) {
          return { action: "replace" } as const;
        }

        // IPv6 cannot be toggled without a rebuild.
        if (
          (news.enableIpv6 ?? false) !==
          (output?.enableIpv6 ?? o.enableIpv6 ?? false)
        ) {
          return { action: "replace" } as const;
        }

        return undefined;
      }),

      read: Effect.fn(function* ({ id, output }) {
        // Happy path: state has the instance ID, fetch it directly.
        if (output?.instanceId) {
          return yield* api.getInstance(output.instanceId).pipe(
            Effect.map(({ instance }) =>
              toAttrs(instance, output.defaultPassword),
            ),
            Effect.catchTag("InstanceNotFound", () =>
              Effect.succeed(undefined),
            ),
          );
        }
        // Recovery path: state lost / first reconcile after an aborted
        // create. Look for an instance branded with our `(stack, stage,
        // id)` tags so we don't duplicate.
        const adopted = yield* findByAlchemyTags(id);
        return adopted ? toAttrs(adopted, undefined) : undefined;
      }),

      reconcile: Effect.fn(function* ({ id, news, output }) {
        const desiredTags = yield* computeDesiredTags(id, news.tags);
        const label = news.label ?? (yield* defaultLabel(id));

        // Observe / ensure
        const observed = output?.instanceId
          ? yield* api.getInstance(output.instanceId).pipe(
              Effect.map(({ instance }) => instance),
              Effect.catchTag("InstanceNotFound", () =>
                Effect.succeed(undefined),
              ),
            )
          : undefined;

        let info: api.VultrInstanceInfo;
        let defaultPassword: Redacted.Redacted<string> | undefined =
          output?.defaultPassword;

        if (!observed) {
          const created = yield* api.createInstance({
            region: news.region,
            plan: news.plan,
            os_id: news.osId,
            app_id: news.appId,
            image_id: news.imageId,
            snapshot_id: news.snapshotId,
            iso_id: news.isoId,
            label,
            hostname: news.hostname,
            sshkey_id: news.sshKeyIds,
            tags: desiredTags,
            user_data: news.userData
              ? Buffer.from(news.userData, "utf8").toString("base64")
              : undefined,
            backups: news.backups,
            enable_ipv6: news.enableIpv6,
            ddos_protection: news.ddosProtection,
            firewall_group_id: news.firewallGroupId,
          });
          if (created.instance.default_password) {
            defaultPassword = Redacted.make(created.instance.default_password);
          }
          info = yield* api.waitForActive(created.instance.id);
        } else {
          info = observed;
        }

        // Sync mutable scalars: label, tags, backups, ddos, firewall.
        const updates: api.UpdateInstanceInput = {};
        if (info.label !== label) updates.label = label;
        if (!tagsEqual(info.tags ?? [], desiredTags))
          updates.tags = desiredTags;
        const desiredBackups = news.backups ?? "disabled";
        if ((info.backups ?? "disabled") !== desiredBackups) {
          updates.backups = desiredBackups;
        }
        const desiredDdos = news.ddosProtection ?? false;
        const observedDdos = (info.features ?? []).includes("ddos_protection");
        if (desiredDdos !== observedDdos) {
          updates.ddos_protection = desiredDdos;
        }
        const desiredFw = news.firewallGroupId ?? "";
        if ((info.firewall_group_id ?? "") !== desiredFw) {
          updates.firewall_group_id = desiredFw;
        }

        if (Object.keys(updates).length > 0) {
          const updated = yield* api.updateInstance(info.id, updates);
          info = updated.instance;
        }

        return toAttrs(info, defaultPassword);
      }),

      delete: Effect.fn(function* ({ output }) {
        yield* api.deleteInstance(output.instanceId);
      }),
    }),
  );

/**
 * Strip Alchemy-managed branding tags from a tag list. Useful when
 * displaying user tags only.
 */
export const userTagsOnly = (tags: ReadonlyArray<string>) =>
  stripAlchemyTags(tags);
