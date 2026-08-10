import { isTransientError } from "@distilled.cloud/core/category";
import {
  dropletActionsPost,
  dropletsCreate,
  dropletsDestroy,
  dropletsGet,
  dropletsList,
  dropletActionsGet,
  type Droplet as ApiDroplet,
  type DropletActionRename,
  type DropletSingleCreateInput,
  type DropletStatus,
} from "@distilled.cloud/digitalocean/droplets";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { Stack } from "../../Stack.ts";
import { Stage } from "../../Stage.ts";
import { arrayEqualsUnordered } from "../../Util/equal.ts";
import type { Providers } from "../Providers.ts";

export type DropletProps = {
  /**
   * Droplet name (also its hostname). Defaults to a generated physical name.
   * Changing it renames the droplet in place; every other property triggers
   * a replacement.
   */
  name?: string;
  /** Region slug to deploy into, e.g. `sfo3`, `nyc1`. */
  region: string;
  /** Size slug, e.g. `s-1vcpu-1gb`, `s-2vcpu-4gb`. */
  size: string;
  /** Public image slug (`ubuntu-24-04-x64`) or private image id. */
  image: string | number;
  /**
   * SSH key ids or fingerprints to embed in the root account. Keys must
   * already exist on the team.
   */
  sshKeys?: Array<string | number>;
  /** Enable automated backups. */
  backups?: boolean;
  /** Enable IPv6. */
  ipv6?: boolean;
  /** Install the DigitalOcean monitoring agent. */
  monitoring?: boolean;
  /** Tags to apply. Tag names are created on the fly if they don't exist. */
  tags?: string[];
  /**
   * Cloud-init user data (cloud-config or shell script, ≤64KiB) applied on
   * first boot.
   */
  userData?: string;
  /** Block storage volume ids to attach on creation. */
  volumes?: string[];
  /** VPC to assign the droplet to. Defaults to the region's default VPC. */
  vpcUuid?: string;
  /** Install the droplet-console agent (see DigitalOcean docs). */
  withDropletAgent?: boolean;
};

export type Droplet = Resource<
  "DigitalOcean.Droplet",
  DropletProps,
  {
    dropletId: number;
    name: string;
    status: DropletStatus;
    region: string;
    sizeSlug: string;
    imageId: number | undefined;
    imageSlug: string | undefined;
    /** Public IPv4 address. */
    ipv4: string | undefined;
    /** VPC-private IPv4 address. */
    privateIpv4: string | undefined;
    /** Public IPv6 address, when `ipv6` is enabled. */
    ipv6: string | undefined;
    vpcUuid: string | undefined;
    tags: string[];
    createdAt: string;
  },
  never,
  Providers
>;

/**
 * A DigitalOcean Droplet — a Linux virtual machine. Only `name` is mutable
 * in place (a rename action); changing `region`, `size`, `image`, or any
 * other property replaces the droplet. In-place resize is a candidate for a
 * later wave — droplets used with alchemy are best treated as cattle:
 * provision via `userData` (cloud-init) so a replacement converges on its
 * own.
 * @resource
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/Droplets
 *
 * @section Creating a Droplet
 * @example Docker host reachable over SSH
 * ```typescript
 * const key = yield* DigitalOcean.SshKey("deploy-key", {
 *   publicKey: process.env.SSH_PUBLIC_KEY!,
 * });
 * const host = yield* DigitalOcean.Droplet("app", {
 *   region: "sfo3",
 *   size: "s-2vcpu-4gb",
 *   image: "docker-24-04",
 *   sshKeys: [key.fingerprint],
 *   monitoring: true,
 * });
 * // host.ipv4 is the public address once the droplet is active.
 * ```
 *
 * @example Bootstrap via cloud-init
 * ```typescript
 * const host = yield* DigitalOcean.Droplet("app", {
 *   region: "sfo3",
 *   size: "s-2vcpu-4gb",
 *   image: "ubuntu-24-04-x64",
 *   userData: [
 *     "#cloud-config",
 *     "packages: [docker.io]",
 *     "runcmd:",
 *     "  - docker compose -f /opt/app/compose.yaml up -d",
 *   ].join("\n"),
 * });
 * ```
 */
export const Droplet = Resource<Droplet>("DigitalOcean.Droplet");

/**
 * DigitalOcean droplet names are not unique, so name alone cannot prove
 * ownership. Droplets support tags — we stamp a deterministic marker tag on
 * create so a re-apply (e.g. wiped state) can adopt a droplet *we*
 * previously created without hijacking someone else's droplet of the same
 * name. Tag charset is letters/numbers/colons/dashes/underscores, ≤255.
 */
const MARKER_PREFIX = "alchemy:";

const sanitizeTagPart = (part: string) =>
  part.replaceAll(/[^a-zA-Z0-9_-]/g, "-");

const buildMarker = (stack: string, stage: string, id: string) =>
  `${MARKER_PREFIX}${[stack, stage, id].map(sanitizeTagPart).join(":")}`.slice(
    0,
    255,
  );

const stripMarkers = (tags: readonly string[]) =>
  tags.filter((t) => !t.startsWith(MARKER_PREFIX));

class DropletNotReady extends Data.TaggedError("DropletNotReady")<{
  readonly dropletId: number;
  readonly status: string;
}> {}

class DropletStillPresent extends Data.TaggedError("DropletStillPresent")<{
  readonly dropletId: number;
}> {}

class DropletActionFailed extends Data.TaggedError("DropletActionFailed")<{
  readonly dropletId: number;
  readonly actionId: number;
  readonly status: string;
}> {}

const isReady = (droplet: ApiDroplet) =>
  droplet.status === "active" && !droplet.locked;

// Order-insensitive prop comparison; an omitted list and an empty list
// describe the same desired state.
const sameSet = <T extends string | number>(
  a: ReadonlyArray<T> | undefined,
  b: ReadonlyArray<T> | undefined,
) => arrayEqualsUnordered(a ?? [], b ?? []);

export const DropletProvider = () =>
  Provider.effect(
    Droplet,
    Effect.gen(function* () {
      const create = yield* dropletsCreate;
      const get = yield* dropletsGet;
      const destroy = yield* dropletsDestroy;
      const list = yield* dropletsList;
      const postAction = yield* dropletActionsPost;
      const getAction = yield* dropletActionsGet;

      const toAttrs = (droplet: ApiDroplet) => ({
        dropletId: droplet.id,
        name: droplet.name,
        status: droplet.status,
        region: droplet.region.slug,
        sizeSlug: droplet.size_slug,
        imageId: droplet.image.id,
        imageSlug: droplet.image.slug ?? undefined,
        ipv4: droplet.networks.v4?.find((n) => n.type === "public")?.ip_address,
        privateIpv4: droplet.networks.v4?.find((n) => n.type === "private")
          ?.ip_address,
        ipv6: droplet.networks.v6?.find((n) => n.type === "public")?.ip_address,
        vpcUuid: droplet.vpc_uuid,
        tags: stripMarkers(droplet.tags),
        createdAt: droplet.created_at,
      });

      const observe = (dropletId: number) =>
        get({ droplet_id: dropletId }).pipe(
          Effect.map((r) => r.droplet),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );

      /** Find the droplet named `name` that carries our marker tag. */
      const observeByName = (name: string, marker: string) =>
        list({ name, per_page: 200 }).pipe(
          Effect.map((r) =>
            (r.droplets ?? []).find((d) => d.tags.includes(marker)),
          ),
        );

      /**
       * Poll the droplet until `settled` holds. Polling happens on the
       * success channel — `DropletNotReady` exists only as the terminal
       * timeout error. Droplet reads are eventually consistent after
       * actions (a completed rename stays invisible to GET for ~30-60s,
       * verified against the live API), so anything a mutation changes must
       * be polled until observed, never assumed from action completion.
       */
      const waitForDroplet = (
        dropletId: number,
        settled: (droplet: ApiDroplet) => boolean,
      ) =>
        get({ droplet_id: dropletId }).pipe(
          Effect.map((r) => r.droplet),
          // A transient API blip is indistinguishable from "not settled
          // yet" while polling — fold it into the same bounded budget.
          Effect.catchIf(isTransientError, () => Effect.succeed(undefined)),
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            // Explicitly boolean so TS doesn't infer a refinement: `times`
            // exhaustion can still hand back an unsettled droplet, and the
            // result type must stay wide for the guard below.
            until: (droplet): boolean =>
              droplet !== undefined && settled(droplet),
            // ≈ 10 minutes — droplets usually settle in well under one.
            times: 120,
          }),
          Effect.flatMap((droplet) => {
            const status = droplet?.status ?? "missing";
            return droplet !== undefined && settled(droplet)
              ? Effect.succeed(droplet)
              : Effect.fail(new DropletNotReady({ dropletId, status }));
          }),
        );

      /**
       * Droplet creation answers 202 with status "new"; networking (and the
       * public IP we surface as an attribute) only exists once it turns
       * "active". A locked droplet also rejects actions, so wait out both.
       */
      const waitForActive = (dropletId: number) =>
        waitForDroplet(dropletId, isReady);

      /**
       * Droplet actions (rename, resize, power, …) are asynchronous — the
       * POST answers with an in-progress Action, and the droplet itself
       * stays `active` throughout, so polling the droplet proves nothing.
       * Poll the action until it leaves "in-progress"; anything but
       * "completed" is the terminal `DropletActionFailed`.
       */
      const waitForAction = (dropletId: number, actionId: number) =>
        getAction({ droplet_id: dropletId, action_id: actionId }).pipe(
          Effect.map((r) => r.action?.status ?? "in-progress"),
          Effect.catchIf(isTransientError, () =>
            Effect.succeed("in-progress" as const),
          ),
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (status): boolean => status !== "in-progress",
            times: 60,
          }),
          Effect.flatMap((status) =>
            status === "completed"
              ? Effect.void
              : Effect.fail(
                  new DropletActionFailed({ dropletId, actionId, status }),
                ),
          ),
        );

      return {
        stables: ["dropletId", "region", "createdAt"],
        // Enumerate every droplet in the team. `GET /v2/droplets` paginates;
        // walk pages exhaustively and hydrate each row into the exact
        // `read`/`toAttrs` Attributes shape — directly usable by `delete`
        // with no follow-up get.
        list: () =>
          Effect.gen(function* () {
            const out: Array<ReturnType<typeof toAttrs>> = [];
            for (let page = 1; ; page++) {
              const res = yield* list({ per_page: 200, page });
              const droplets = res.droplets ?? [];
              out.push(...droplets.map(toAttrs));
              if (droplets.length < 200) return out;
            }
          }),
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news) || olds === undefined) return undefined;
          // Everything but `name` is create-time-only on the API (or, like
          // size, needs an offline resize we don't model yet) — replace.
          if (
            news.region !== olds.region ||
            news.size !== olds.size ||
            news.image !== olds.image ||
            news.backups !== olds.backups ||
            news.ipv6 !== olds.ipv6 ||
            news.monitoring !== olds.monitoring ||
            news.userData !== olds.userData ||
            news.vpcUuid !== olds.vpcUuid ||
            news.withDropletAgent !== olds.withDropletAgent ||
            !sameSet(news.sshKeys, olds.sshKeys) ||
            !sameSet(news.tags, olds.tags) ||
            !sameSet(news.volumes, olds.volumes)
          ) {
            return { action: "replace" } as const;
          }
          if (news.name !== olds.name) {
            return { action: "update" } as const;
          }
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, output }) {
          const stack = yield* Stack;
          const stage = yield* Stage;
          const marker = buildMarker(stack.name, stage, id);
          const desiredName =
            news.name ??
            (yield* createPhysicalName({ id, lowercase: true, maxLength: 63 }));

          // Observe — prefer the cached physical id; fall back to probing by
          // name + marker so a crash after create (state never persisted)
          // converges instead of creating a same-named twin. `read` upstream
          // has already surfaced foreign droplets as `Unowned`, so mutation
          // is safe here.
          let current =
            output !== undefined
              ? yield* observe(output.dropletId)
              : yield* observeByName(desiredName, marker);

          // Ensure — POST creates the droplet (names are not unique, so
          // there is no AlreadyExists race to tolerate; the observe above is
          // the guard). Wait until it is active so attributes carry an IP.
          if (current === undefined) {
            const created = yield* create({
              body: {
                name: desiredName,
                region: news.region,
                size: news.size,
                image: news.image,
                ssh_keys: news.sshKeys,
                backups: news.backups,
                ipv6: news.ipv6,
                monitoring: news.monitoring,
                tags: [...(news.tags ?? []), marker],
                user_data: news.userData,
                volumes: news.volumes,
                vpc_uuid: news.vpcUuid,
                with_droplet_agent: news.withDropletAgent,
              } satisfies DropletSingleCreateInput,
            });
            const dropletId = created.droplet?.id;
            if (dropletId === undefined) {
              return yield* Effect.die(
                new Error("droplet create response carried no droplet"),
              );
            }
            return toAttrs(yield* waitForActive(dropletId));
          }

          // Sync — the only mutable aspect is the name (a rename action).
          // Everything else was classified `replace` by diff.
          if (current.name !== desiredName) {
            yield* waitForActive(current.id);
            const renamed = yield* postAction({
              droplet_id: current.id,
              body: {
                type: "rename",
                name: desiredName,
              } satisfies DropletActionRename,
            });
            const actionId = renamed.action?.id;
            if (actionId === undefined) {
              return yield* Effect.die(
                new Error("rename action response carried no action id"),
              );
            }
            yield* waitForAction(current.id, actionId);
            // Action completion is not read visibility — poll until the new
            // name is actually served.
            return toAttrs(
              yield* waitForDroplet(
                current.id,
                (droplet) => isReady(droplet) && droplet.name === desiredName,
              ),
            );
          }
          return toAttrs(current);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* destroy({ droplet_id: output.dropletId }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
          );
          // Destruction is async (202-style). Poll on the success channel
          // until the API answers NotFound so a follow-up create of the
          // same name doesn't observe the dying instance.
          const gone = yield* get({ droplet_id: output.dropletId }).pipe(
            Effect.map(() => false),
            Effect.catchTag("NotFound", () => Effect.succeed(true)),
            Effect.catchIf(isTransientError, () => Effect.succeed(false)),
            Effect.repeat({
              schedule: Schedule.spaced("5 seconds"),
              until: (gone) => gone,
              times: 60,
            }),
          );
          if (!gone) {
            return yield* Effect.fail(
              new DropletStillPresent({ dropletId: output.dropletId }),
            );
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const stack = yield* Stack;
          const stage = yield* Stage;
          const marker = buildMarker(stack.name, stage, id);
          const existing =
            output !== undefined
              ? yield* observe(output.dropletId)
              : olds?.name !== undefined
                ? yield* observeByName(olds.name, marker)
                : undefined;
          if (existing === undefined) return undefined;
          const attrs = toAttrs(existing);
          return existing.tags.includes(marker) ? attrs : Unowned(attrs);
        }),
      };
    }),
  );
