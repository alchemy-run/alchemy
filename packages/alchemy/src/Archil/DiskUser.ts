import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  addDiskUser,
  getDisk,
  listDisks,
  removeDiskUser,
  retryTransient,
  type AuthorizedUser,
  type DiskUserSpec,
} from "./Api.ts";
import type { Disk } from "./Disk.ts";
import { ALL_REGIONS, type ArchilRegion } from "./Region.ts";
import type { Providers } from "./Providers.ts";

export type { AwsStsDiskUser, DiskUserSpec, TokenDiskUser } from "./Api.ts";

/**
 * The disk to authorize the user on — an {@link Disk} resource or a plain
 * `{ diskId, region }` reference to a disk managed elsewhere.
 */
export type DiskRef = Disk | { diskId: string; region: ArchilRegion };

export interface DiskUserProps {
  /**
   * The disk to authorize the user on.
   */
  disk: DiskRef;
  /**
   * The user to authorize:
   * - `token` — a server-generated shared disk token (returned once).
   * - `awssts` — an IAM principal ARN mounting via STS role assumption.
   *
   * Changing the user replaces it (remove + add).
   */
  user: DiskUserSpec;
}

export type DiskUser = Resource<
  "Archil.DiskUser",
  DiskUserProps,
  {
    /** ID of the disk the user is authorized on. */
    diskId: string;
    /** Region of the disk. */
    region: ArchilRegion;
    /** Authentication type. */
    type: "token" | "awssts";
    /** Stable identifier used to remove the user (the IAM ARN for awssts). */
    identifier: string;
    /** Nickname (token users). */
    nickname: string | undefined;
    /** IAM principal ARN (awssts users). */
    principal: string | undefined;
    /**
     * The generated disk token (token users). Captured exactly once at
     * creation — Archil never returns it again.
     */
    diskToken: Redacted.Redacted<string> | undefined;
    /** Last 4 characters of the disk token. */
    tokenSuffix: string | undefined;
    /** Creation timestamp. */
    createdAt: string | undefined;
  },
  never,
  Providers
>;

type DiskUserAttributes = DiskUser["Attributes"];

/**
 * An authorized user on an Archil disk — the credential clients present when
 * mounting. Token users get a server-generated shared token; `awssts` users
 * authenticate by assuming an IAM role.
 *
 * @resource
 * @section Authorizing Users
 * @example Add a token user
 * ```typescript
 * const disk = yield* Archil.Disk("shared");
 * const ci = yield* Archil.DiskUser("ci-mount", {
 *   disk,
 *   user: { type: "token", nickname: "ci" },
 * });
 * // ci.diskToken holds the one-time generated token
 * ```
 *
 * @example Authorize an IAM principal via STS
 * ```typescript
 * yield* Archil.DiskUser("ec2-role", {
 *   disk,
 *   user: {
 *     type: "awssts",
 *     principal: "arn:aws:iam::123456789012:role/my-server",
 *   },
 * });
 * ```
 *
 * @see https://docs.archil.com/concepts/disk-users
 */
export const DiskUser = Resource<DiskUser>("Archil.DiskUser");

/**
 * Extract the disk id + region from a {@link DiskRef}. At reconcile time a
 * `Disk` resource passed as a plain prop arrives as its bare attributes, so
 * both forms carry resolved `diskId`/`region` — the casts strip the static
 * `Output` typing that resource attribute access carries.
 */
const resolveDiskRef = (
  source: DiskRef,
): { diskId: string; region: ArchilRegion } => ({
  diskId: (source as { diskId: string }).diskId as unknown as string,
  region: (source as { region: ArchilRegion })
    .region as unknown as ArchilRegion,
});

const matchesSpec = (user: AuthorizedUser, spec: DiskUserSpec): boolean =>
  spec.type === "token"
    ? user.type === "token" && user.nickname === spec.nickname
    : user.type === "awssts" &&
      (user.identifier === spec.principal || user.principal === spec.principal);

const toAttributes = (
  user: AuthorizedUser,
  diskId: string,
  region: ArchilRegion,
  diskToken: Redacted.Redacted<string> | undefined,
): DiskUserAttributes => ({
  diskId,
  region,
  type: user.type ?? "token",
  identifier: user.identifier ?? user.principal ?? user.nickname ?? "",
  nickname: user.nickname,
  principal:
    user.type === "awssts" ? (user.principal ?? user.identifier) : undefined,
  diskToken,
  tokenSuffix: user.tokenSuffix,
  createdAt: user.createdAt,
});

export const DiskUserProvider = () =>
  Provider.succeed(DiskUser, {
    stables: ["diskId", "region", "type", "identifier"],
    list: Effect.fn(function* () {
      // The list-disks response embeds each disk's authorized users, so a
      // per-region sweep enumerates every user without per-disk reads.
      const rows = yield* Effect.forEach(
        ALL_REGIONS,
        (region) =>
          listDisks({ region, limit: 100 }).pipe(
            retryTransient,
            Effect.map((disks) =>
              disks.flatMap((disk) =>
                (disk.authorizedUsers ?? []).map((user) =>
                  toAttributes(user, disk.id, region, undefined),
                ),
              ),
            ),
            Effect.catchTag("AccessDenied", () => Effect.succeed([])),
          ),
        { concurrency: ALL_REGIONS.length },
      );
      return rows.flat();
    }),
    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      // No update API: any change to the target disk or the user spec is a
      // replacement.
      const oldDiskId =
        output?.diskId ??
        (olds ? resolveDiskRef(olds.disk as DiskRef).diskId : undefined);
      const newDiskId = resolveDiskRef(news.disk as DiskRef).diskId;
      if (oldDiskId !== undefined && newDiskId !== oldDiskId) {
        return { action: "replace" } as const;
      }
      if (
        olds?.user &&
        JSON.stringify(news.user) !== JSON.stringify(olds.user)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ output }) {
      if (!output?.identifier) return undefined;
      return yield* getDisk({
        region: output.region,
        diskId: output.diskId,
      }).pipe(
        Effect.map((disk) => {
          const user = (disk.authorizedUsers ?? []).find(
            (u) => u.identifier === output.identifier,
          );
          return user
            ? toAttributes(user, output.diskId, output.region, output.diskToken)
            : undefined;
        }),
        Effect.catchTag("DiskNotFound", () => Effect.succeed(undefined)),
      );
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      const user = news.user;
      const { diskId, region } = resolveDiskRef(news.disk as DiskRef);

      // Observe — the disk's authorized-user list is authoritative.
      const observed = yield* getDisk({ region, diskId }).pipe(retryTransient);
      const existing = (observed.authorizedUsers ?? []).find((u) =>
        output?.identifier
          ? u.identifier === output.identifier
          : matchesSpec(u, user),
      );

      // Ensure — add if missing. The one-time token only appears on a fresh
      // add; otherwise preserve the value captured previously.
      if (existing === undefined) {
        const added = yield* addDiskUser({ region, diskId, user }).pipe(
          retryTransient,
        );
        return toAttributes(
          added,
          diskId,
          region,
          added.token ? Redacted.make(added.token) : undefined,
        );
      }
      return toAttributes(existing, diskId, region, output?.diskToken);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* removeDiskUser({
        region: output.region,
        diskId: output.diskId,
        userType: output.type,
        identifier: output.identifier,
      }).pipe(
        retryTransient,
        // Disk (and its users) already gone — deletion is idempotent.
        Effect.catchTag("DiskNotFound", () => Effect.void),
        // Archil reports an already-removed user as a 400 validation error.
        Effect.catchIf(
          (e): boolean =>
            e._tag === "ArchilValidationError" && /not found/i.test(e.message),
          () => Effect.void,
        ),
      );
    }),
  });
