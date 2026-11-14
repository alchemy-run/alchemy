import * as archil from "@distilled.cloud/archil";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import type { Providers } from "./Providers.ts";

export class DiskUserUnexpectedResponse extends Data.TaggedError(
  "Archil.DiskUserUnexpectedResponse",
)<{
  readonly message: string;
}> {}

export interface DiskUserProps {
  /** Id of the disk the user can mount (e.g. `disk.diskId`). Changing it replaces the user. */
  disk: string;
  /**
   * Name shown in the console. If omitted, a unique name is generated from
   * the stack, stage, and logical ID. Changing it replaces the user.
   */
  nickname?: string;
  /**
   * An AWS IAM role or user ARN that mounts with its own AWS identity
   * instead of a token, e.g. an ECS task role. Changing it replaces the user.
   */
  principal?: string;
  /**
   * `token` mounts with a disk token; `s3` gets an access key pair for the
   * disk's S3-compatible API instead. Ignored when `principal` is set (an
   * `awssts` user). Changing it replaces the user.
   * @default "token"
   */
  type?: "token" | "s3";
  /**
   * Mounts made with this user reject writes (`EROFS`); an `s3` user can
   * only `GET` and `HEAD`. Changing it replaces the user.
   * @default false
   */
  readOnly?: boolean;
  /**
   * When the user stops working, as an RFC 3339 timestamp in the future
   * (at most 365 days away). Requests signed with an expired `s3` key,
   * presigned URLs included, are rejected. Changing it replaces the user.
   */
  expiresAt?: string;
  /**
   * The user works for one mount only; later mounts with it are rejected.
   * Not available for `s3` users. Changing it replaces the user.
   * @default false
   */
  oneUse?: boolean;
}

export interface DiskUserAttributes {
  /** Id of the disk. */
  diskId: string;
  /** `token`, `s3` for an access key pair, or `awssts` for an IAM principal. */
  type: "token" | "awssts" | "s3";
  /** Archil's identifier for the user, used to revoke it. */
  identifier: string;
  /** Name shown in the console. */
  nickname: string;
  /** The IAM ARN, for an `awssts` user. */
  principal: string | undefined;
  /**
   * The disk token, for a `token` user. Pass it to `archil mount` as
   * `ARCHIL_MOUNT_TOKEN`. It works only for this disk.
   */
  token: Redacted.Redacted<string> | undefined;
  /** The S3 access key id, for an `s3` user. */
  accessKeyId: string | undefined;
  /**
   * The S3 secret access key, for an `s3` user. Sign requests to the disk's
   * S3-compatible API with it; it works only for this disk.
   */
  secretAccessKey: Redacted.Redacted<string> | undefined;
  /** Whether the user is read-only. */
  readOnly: boolean;
  /** When the user expires, if it does. */
  expiresAt: string | undefined;
  /** Whether the user works for one mount only. */
  oneUse: boolean;
}

export type DiskUser = Resource<
  "Archil.DiskUser",
  DiskUserProps,
  DiskUserAttributes,
  never,
  Providers
>;

/**
 * Access to one disk. A token user gets a disk token for `archil mount`; an
 * `s3` user gets an access key pair for the disk's S3-compatible API; an
 * IAM user lets an AWS principal mount with its own identity, so no secret
 * exists at all. Archil checks each one itself, so a host holding a disk
 * user can't reach any other disk. `readOnly`, `expiresAt` and `oneUse`
 * narrow it further.
 *
 * Archil only shows a token or secret key once, when it's created, so
 * Alchemy stores it in state as a `Redacted` value. Destroying the user
 * revokes it. `Archil.MountDisk(disk)` and the object bindings
 * (`Archil.ReadDisk`, `Archil.WriteDisk`, `Archil.ReadWriteDisk`) create
 * one per host for you.
 *
 * :::caution
 * Archil can't change a user, so changing any prop replaces it: the old
 * token or key stops working once the new one exists.
 * :::
 * @see https://docs.archil.com/concepts/sharing-disks
 *
 * ### Creating a Disk User
 * **Example:** A token for one machine
 * ```typescript
 * const user = yield* Archil.DiskUser("Indexer", { disk: dataset.diskId });
 * // ARCHIL_MOUNT_TOKEN=<user.token> archil mount <disk> /mnt/data --region aws-us-east-1
 * ```
 *
 * **Example:** An ECS task role that mounts with its own identity
 * ```typescript
 * const user = yield* Archil.DiskUser("Workers", {
 *   disk: dataset.diskId,
 *   principal: taskRole.roleArn,
 * });
 * ```
 *
 * **Example:** A read-only token that expires
 * ```typescript
 * const user = yield* Archil.DiskUser("Viewer", {
 *   disk: dataset.diskId,
 *   readOnly: true,
 *   expiresAt: "2027-01-01T00:00:00Z",
 * });
 * ```
 *
 * ### S3 Keys
 * **Example:** A read-only access key pair for one disk
 * ```typescript
 * const reader = yield* Archil.DiskUser("Reader", {
 *   disk: dataset.diskId,
 *   type: "s3",
 *   readOnly: true,
 * });
 * // reader.accessKeyId, reader.secretAccessKey sign requests to
 * // https://s3.green.us-east-1.aws.prod.archil.com/<disk id>/<key>
 * ```
 *
 * @resource
 * @product Disk
 */
export const DiskUser = Resource<DiskUser>("Archil.DiskUser");

const userNickname = (id: string, nickname: string | undefined) =>
  nickname ? Effect.succeed(nickname) : createPhysicalName({ id, maxLength: 64, delimiter: "-" });

const lookupDiskUser = Effect.fn(function* (
  diskId: string,
  match: { nickname?: string; principal?: string; identifier?: string },
) {
  const { data } = yield* archil.getDisk({ id: diskId });
  return (data.authorizedUsers ?? []).find((user) =>
    match.identifier !== undefined
      ? user.identifier === match.identifier
      : match.principal !== undefined
        ? user.principal === match.principal
        : user.nickname === match.nickname,
  );
});

/**
 * The authorized user on a disk with this identifier, nickname or principal.
 *
 * For a few seconds after a user is added, some `getDisk` reads still list
 * the disk without it (removals show at once). So a listed user exists, but
 * a user we created (`match.identifier`) counts as missing only after reads
 * across that window all miss it.
 */
export const findDiskUser = Effect.fn(function* (
  diskId: string,
  match: { nickname?: string; principal?: string; identifier?: string },
) {
  const first = yield* lookupDiskUser(diskId, match);
  if (first || match.identifier === undefined) return first;
  return yield* lookupDiskUser(diskId, match).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("500 millis"),
      until: (user) => user !== undefined,
      times: 14,
    }),
  );
});

/** What a disk user is created with. */
export interface DiskUserSpec {
  readonly nickname: string;
  readonly principal?: string;
  readonly type?: "token" | "s3";
  readonly readOnly?: boolean;
  readonly expiresAt?: string;
  readonly oneUse?: boolean;
}

const userType = (user: Pick<DiskUserSpec, "principal" | "type">) =>
  user.principal !== undefined ? ("awssts" as const) : (user.type ?? "token");

const redacted = (value: string | Redacted.Redacted<string> | undefined) =>
  value === undefined ? undefined : typeof value === "string" ? Redacted.make(value) : value;

/** Add a token, S3, or IAM user to a disk. */
export const addDiskUser = Effect.fn(function* (diskId: string, user: DiskUserSpec) {
  const type = userType(user);
  const limits = { readOnly: user.readOnly, expiresAt: user.expiresAt };
  const { data } = yield* archil.addDiskUser({
    id: diskId,
    body:
      type === "awssts"
        ? { type, principal: user.principal!, ...limits, oneUse: user.oneUse }
        : type === "s3"
          ? { type, nickname: user.nickname, ...limits }
          : { type, nickname: user.nickname, ...limits, oneUse: user.oneUse },
  });
  const missing =
    type === "token"
      ? !data.token || !data.identifier
      : type === "s3"
        ? !data.s3AccessKeyId || !data.s3SecretKey
        : false;
  if (missing) {
    return yield* new DiskUserUnexpectedResponse({
      message: `Archil returned no ${type === "s3" ? "S3 keys" : "token"} for disk user ${user.nickname} on ${diskId}`,
    });
  }
  return {
    diskId,
    type,
    identifier: data.identifier ?? data.s3AccessKeyId ?? user.principal ?? "",
    nickname: data.nickname ?? user.nickname,
    principal: user.principal,
    token: redacted(data.token),
    accessKeyId: data.s3AccessKeyId,
    secretAccessKey: redacted(data.s3SecretKey),
    readOnly: data.readOnly ?? user.readOnly ?? false,
    expiresAt: data.expiresAt ?? user.expiresAt,
    oneUse: data.oneUse ?? user.oneUse ?? false,
  } satisfies DiskUserAttributes;
});

/** Revoke a disk user. Revoking a missing user (or one on a deleted disk) succeeds. */
export const removeDiskUser = Effect.fn(function* (attrs: {
  diskId: string;
  type: "token" | "awssts" | "s3";
  identifier: string;
  principal?: string;
}) {
  yield* archil
    .removeDiskUser({
      id: attrs.diskId,
      userType: attrs.type,
      identifier: attrs.type === "awssts" ? undefined : attrs.identifier,
      principal: attrs.type === "awssts" ? attrs.principal : undefined,
    })
    .pipe(Effect.catchTag("NotFound", () => Effect.void));
});

export const DiskUserProvider = () =>
  Provider.effect(
    DiskUser,
    Effect.gen(function* () {
      return {
        stables: [
          "diskId",
          "type",
          "identifier",
          "nickname",
          "principal",
          "token",
          "accessKeyId",
          "secretAccessKey",
          "readOnly",
          "expiresAt",
          "oneUse",
        ],
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          if (!isResolved(news)) return undefined;
          const nickname = output?.nickname ?? (yield* userNickname(id, olds?.nickname));
          if (
            news.disk !== (output?.diskId ?? olds?.disk) ||
            (news.nickname !== undefined && news.nickname !== nickname) ||
            news.principal !== (output?.principal ?? olds?.principal) ||
            userType(news) !== (output?.type ?? (olds ? userType(olds) : userType(news))) ||
            (news.readOnly ?? false) !== (output?.readOnly ?? olds?.readOnly ?? false) ||
            news.expiresAt !== (output?.expiresAt ?? olds?.expiresAt) ||
            (news.oneUse ?? false) !== (output?.oneUse ?? olds?.oneUse ?? false)
          ) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          if (!output && !olds) return undefined;
          const diskId = output?.diskId ?? olds!.disk;
          const nickname = output?.nickname ?? (yield* userNickname(id, olds?.nickname));
          const observed = yield* findDiskUser(diskId, {
            identifier: output?.identifier,
            principal: output?.principal ?? olds?.principal,
            nickname,
          }).pipe(Effect.catchTag("NotFound", () => Effect.undefined));
          if (!observed) return undefined;
          return (
            output ?? {
              diskId,
              type: observed.type ?? "token",
              identifier: observed.identifier ?? observed.principal ?? "",
              nickname: observed.nickname ?? nickname,
              principal: observed.principal,
              // Secrets are only shown at creation; reconcile re-creates.
              token: undefined,
              accessKeyId: observed.s3AccessKeyId,
              secretAccessKey: undefined,
              readOnly: observed.readOnly ?? false,
              expiresAt: observed.expiresAt,
              oneUse: observed.oneUse ?? false,
            }
          );
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const nickname = output?.nickname ?? (yield* userNickname(id, news.nickname));
          // Observe
          const observed = yield* findDiskUser(news.disk, {
            identifier: output?.identifier,
            principal: news.principal,
            nickname,
          });
          const type = userType(news);
          const hasSecret =
            type === "awssts" ||
            (type === "s3" ? output?.secretAccessKey !== undefined : output?.token !== undefined);
          if (observed && output && hasSecret) return output;
          // Ensure — a user we hold no secret for (a lost create, or an
          // adoption) is revoked and created again.
          if (observed) {
            yield* session.note(`Re-creating disk user ${nickname}...`);
            yield* removeDiskUser({
              diskId: news.disk,
              type: observed.type ?? "token",
              identifier: observed.identifier ?? "",
              principal: observed.principal,
            });
          }
          return yield* addDiskUser(news.disk, {
            nickname,
            principal: news.principal,
            type: news.type,
            readOnly: news.readOnly,
            expiresAt: news.expiresAt,
            oneUse: news.oneUse,
          });
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* removeDiskUser(output);
        }),
      };
    }),
  );
