import * as drive from "@distilled.cloud/gcp/drive_v3";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";

export const ALCHEMY_PROPERTY_MARKER = "alchemy";
export const DEFAULT_MIME_TYPE = "application/vnd.google-apps.document";
export const MAX_DRIVE_NAME_LENGTH = 1000;
export const MAX_FILE_NAME_LENGTH = 200;
export const FILE_OWNERSHIP_QUERY =
  "trashed = false and properties has { key='alchemy' and value='true' }";
export const DRIVE_OWNERSHIP_QUERY = "name contains '[alchemy'";

export type QuotedFileContent = {
  mimeType?: string;
  value?: string;
};

export type DriveRestrictions = {
  domainUsersOnly?: boolean;
  driveMembersOnly?: boolean;
  adminManagedRestrictions?: boolean;
  sharingFoldersRequiresOrganizerPermission?: boolean;
  copyRequiresWriterPermission?: boolean;
};

export type DriveBackgroundImageFile = {
  id?: string;
  xCoordinate?: number;
  yCoordinate?: number;
  width?: number;
};

const markerOf = (
  _labels: Record<string, string>,
  stack: string,
  stage: string,
  id: string,
) =>
  `[alchemy ${alchemyLabelKeys.stack}=${stack} ${alchemyLabelKeys.stage}=${stage} ${alchemyLabelKeys.id}=${id}]`;

const fitMarker = (labels: Record<string, string>, maxLength: number) => {
  let stack = labels[alchemyLabelKeys.stack] ?? "x";
  let stage = labels[alchemyLabelKeys.stage] ?? "x";
  let id = labels[alchemyLabelKeys.id] ?? "x";
  let marker = markerOf(labels, stack, stage, id);
  while (
    marker.length > maxLength &&
    (stack.length > 1 || stage.length > 1 || id.length > 1)
  ) {
    if (stack.length >= stage.length && stack.length >= id.length) {
      stack = stack.slice(0, -1);
    } else if (stage.length >= id.length) {
      stage = stage.slice(0, -1);
    } else {
      id = id.slice(0, -1);
    }
    marker = markerOf(labels, stack, stage, id);
  }
  return marker.slice(0, maxLength);
};

export const encodeOwnership = (
  labels: Record<string, string>,
  text: string | undefined,
): string => {
  const marker = fitMarker(labels, 8000);
  const trimmed = text?.trim();
  return trimmed && trimmed.length > 0 ? `${marker}\n${trimmed}` : marker;
};

export const encodeOwnershipLine = (
  labels: Record<string, string>,
  text: string | undefined,
  maxLength = MAX_DRIVE_NAME_LENGTH,
): string => {
  const trimmed = text?.replace(/[\r\n]+/g, " ").trim();
  if (!trimmed) return fitMarker(labels, maxLength);
  const minMarker = 24;
  const reserved = Math.min(
    trimmed.length + 1,
    Math.max(0, maxLength - minMarker),
  );
  const marker = fitMarker(labels, maxLength - reserved);
  return `${marker} ${trimmed}`.slice(0, maxLength);
};

export const parseOwnership = (
  text: string | undefined,
): {
  labels: Record<string, string>;
  text: string | undefined;
} => {
  if (!text?.startsWith("[alchemy ")) {
    return { labels: {}, text };
  }
  const end = text.indexOf("]");
  if (end < 0) return { labels: {}, text };
  const labels: Record<string, string> = {};
  for (const part of text.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = text.slice(end + 1).replace(/^[\s\n]+/, "");
  return { labels, text: rest.length > 0 ? rest : undefined };
};

export const hasOwnershipMarker = (text: string | undefined) => {
  if (
    Object.keys(parseOwnership(text).labels).some((key) =>
      key.startsWith("alchemy-"),
    )
  ) {
    return true;
  }
  return (text ?? "").toLowerCase().includes("alchemy-");
};

const prefixMatch = (expected: string, observed: string) =>
  expected === observed ||
  expected.startsWith(observed) ||
  observed.startsWith(expected);

export const ownedByAlchemy = (id: string, text: string | undefined) =>
  Effect.gen(function* () {
    const expected = yield* createInternalLabels(id);
    const { labels } = parseOwnership(text);
    if (!hasOwnershipMarker(text)) return false;
    const exact = yield* hasAlchemyLabels(id, labels);
    if (exact) return true;
    return (
      prefixMatch(
        expected[alchemyLabelKeys.stack] ?? "",
        labels[alchemyLabelKeys.stack] ?? "",
      ) &&
      prefixMatch(
        expected[alchemyLabelKeys.stage] ?? "",
        labels[alchemyLabelKeys.stage] ?? "",
      ) &&
      prefixMatch(
        expected[alchemyLabelKeys.id] ?? "",
        labels[alchemyLabelKeys.id] ?? "",
      )
    );
  });

export const ownershipLabels = (id: string) => createInternalLabels(id);

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const sameBoolean = (
  left: boolean | undefined,
  right: boolean | undefined,
) => (left ?? false) === (right ?? false);

export const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const sameStringList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) =>
  jsonEqual(
    [...(left ?? [])].slice().sort(),
    [...(right ?? [])].slice().sort(),
  );

export const toGeneratedName = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
  maxLength = 40,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) {
      return requested;
    }
    if (existing !== undefined && existing.length > 0) {
      return existing;
    }
    const generated = yield* createPhysicalName({
      id,
      maxLength,
      lowercase: true,
    });
    const next = /^[a-z]/.test(generated)
      ? generated
      : `d${generated}`.slice(0, maxLength);
    return next.length >= 4 ? next : `${next}xxxx`.slice(0, maxLength);
  });

const emptyList = <A>() => Effect.succeed([] as A[]);

export const catchMissing = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.catchIf(
      (error): error is E & { readonly _tag: "NotFound" | "Forbidden" } =>
        error._tag === "NotFound" || error._tag === "Forbidden",
      () => Effect.succeed(undefined),
    ),
  );

export const ignoreMissing = <E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<unknown, E, R>,
) =>
  effect.pipe(
    Effect.catchIf(
      (error): error is E & { readonly _tag: "NotFound" | "Forbidden" } =>
        error._tag === "NotFound" || error._tag === "Forbidden",
      () => Effect.void,
    ),
  );

export const userProperties = (
  properties: Record<string, string | undefined> | null | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(stripInternalLabels(tagRecord(properties))).filter(
      ([key]) => key !== ALCHEMY_PROPERTY_MARKER,
    ),
  );

export const desiredFileProperties = (
  id: string,
  user: Record<string, string> | undefined,
) =>
  Effect.gen(function* () {
    const internal = yield* createInternalLabels(id);
    return {
      ...toLabels(user),
      ...internal,
      [ALCHEMY_PROPERTY_MARKER]: "true",
    };
  });

export const hasAlchemyFileMarker = (file: drive.File) => {
  const properties = tagRecord(file.properties);
  return (
    properties[ALCHEMY_PROPERTY_MARKER] === "true" ||
    Object.keys(properties).some((key) => key.startsWith("alchemy-")) ||
    hasOwnershipMarker(file.description)
  );
};

export const fileOwnedByAlchemy = (id: string, file: drive.File) =>
  Effect.gen(function* () {
    if (yield* hasAlchemyLabels(id, tagRecord(file.properties))) {
      return true;
    }
    return yield* ownedByAlchemy(id, file.description);
  });

export const restrictionsOf = (
  restrictions:
    | drive.DriveRestrictions
    | drive.TeamDriveRestrictions
    | undefined,
): DriveRestrictions | undefined => {
  if (restrictions === undefined) return undefined;
  const driveMembersOnly =
    "driveMembersOnly" in restrictions
      ? restrictions.driveMembersOnly
      : "teamMembersOnly" in restrictions
        ? restrictions.teamMembersOnly
        : undefined;
  return {
    domainUsersOnly: restrictions.domainUsersOnly,
    driveMembersOnly,
    adminManagedRestrictions: restrictions.adminManagedRestrictions,
    sharingFoldersRequiresOrganizerPermission:
      restrictions.sharingFoldersRequiresOrganizerPermission,
    copyRequiresWriterPermission: restrictions.copyRequiresWriterPermission,
  };
};

export const backgroundImageOf = (
  image:
    | drive.DriveBackgroundImageFile
    | drive.TeamDriveBackgroundImageFile
    | undefined,
): DriveBackgroundImageFile | undefined => {
  if (image === undefined) return undefined;
  return {
    id: image.id,
    xCoordinate: image.xCoordinate,
    yCoordinate: image.yCoordinate,
    width: image.width,
  };
};

export const quotedContentOf = (
  quoted: drive.CommentQuotedFileContent | undefined,
): QuotedFileContent | undefined => {
  if (quoted === undefined) return undefined;
  return { mimeType: quoted.mimeType, value: quoted.value };
};

export const getFile = (fileId: string) =>
  fileId.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(
        drive.getFiles({
          fileId,
          supportsAllDrives: true,
        }),
      );

export const listFiles = (q: string) =>
  drive.listFiles
    .pages({
      q,
      pageSize: 100,
      spaces: "drive",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.files ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => emptyList<drive.File>()),
      Effect.catchTag("Forbidden", () => emptyList<drive.File>()),
    );

export const listOwnedFiles = () =>
  listFiles(FILE_OWNERSHIP_QUERY).pipe(
    Effect.map((files) => files.filter(hasAlchemyFileMarker)),
  );

export const findOwnedFile = (id: string) =>
  Effect.gen(function* () {
    const files = yield* listOwnedFiles();
    for (const file of files) {
      if (yield* fileOwnedByAlchemy(id, file)) {
        return file;
      }
    }
    return undefined;
  });

export const getDrive = (driveId: string) =>
  driveId.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(
        drive.getDrives({
          driveId,
        }),
      );

export const listDrives = () =>
  drive.listDrives
    .pages({
      q: DRIVE_OWNERSHIP_QUERY,
      pageSize: 100,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.drives ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => emptyList<drive.Drive>()),
      Effect.catchTag("Forbidden", () => emptyList<drive.Drive>()),
    );

export const listOwnedDrives = () =>
  listDrives().pipe(
    Effect.map((items) =>
      items.filter((item) => hasOwnershipMarker(item.name)),
    ),
  );

export const findOwnedDrive = (id: string) =>
  Effect.gen(function* () {
    const items = yield* listOwnedDrives();
    for (const item of items) {
      if (yield* ownedByAlchemy(id, item.name)) {
        return item;
      }
    }
    return undefined;
  });

export const getTeamdrive = (teamDriveId: string) =>
  teamDriveId.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(
        drive.getTeamdrives({
          teamDriveId,
        }),
      );

export const listTeamdrives = () =>
  drive.listTeamdrives
    .pages({
      q: DRIVE_OWNERSHIP_QUERY,
      pageSize: 100,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.teamDrives ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => emptyList<drive.TeamDrive>()),
      Effect.catchTag("Forbidden", () => emptyList<drive.TeamDrive>()),
    );

export const listOwnedTeamdrives = () =>
  listTeamdrives().pipe(
    Effect.map((items) =>
      items.filter((item) => hasOwnershipMarker(item.name)),
    ),
  );

export const findOwnedTeamdrive = (id: string) =>
  Effect.gen(function* () {
    const items = yield* listOwnedTeamdrives();
    for (const item of items) {
      if (yield* ownedByAlchemy(id, item.name)) {
        return item;
      }
    }
    return undefined;
  });

export const getComment = (fileId: string, commentId: string) =>
  fileId.length === 0 || commentId.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(
        drive.getComments({
          fileId,
          commentId,
        }),
      );

export const listComments = (fileId: string) =>
  fileId.length === 0
    ? emptyList<drive.Comment>()
    : drive.listComments
        .pages({
          fileId,
          pageSize: 100,
        })
        .pipe(
          Stream.flatMap((page) => Stream.fromIterable(page.comments ?? [])),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.catchTag("NotFound", () => emptyList<drive.Comment>()),
          Effect.catchTag("Forbidden", () => emptyList<drive.Comment>()),
        );

export type CommentWithFile = drive.Comment & { fileId: string };

export const listOwnedComments = () =>
  Effect.gen(function* () {
    const files = yield* listOwnedFiles();
    const pages = yield* Effect.forEach(
      files.filter((file) => (file.id ?? "").length > 0),
      (file) =>
        listComments(file.id ?? "").pipe(
          Effect.map((comments) =>
            comments
              .filter((comment) => hasOwnershipMarker(comment.content))
              .map((comment): CommentWithFile => ({
                ...comment,
                fileId: file.id ?? "",
              })),
          ),
        ),
      { concurrency: 4 },
    );
    return pages.flat();
  });

export const findOwnedComment = (id: string, fileId: string) =>
  Effect.gen(function* () {
    const comments = yield* listComments(fileId);
    for (const comment of comments) {
      if (yield* ownedByAlchemy(id, comment.content)) {
        return comment;
      }
    }
    return undefined;
  });

export const getReply = (fileId: string, commentId: string, replyId: string) =>
  fileId.length === 0 || commentId.length === 0 || replyId.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(
        drive.getReplies({
          fileId,
          commentId,
          replyId,
        }),
      );

export const listReplies = (fileId: string, commentId: string) =>
  fileId.length === 0 || commentId.length === 0
    ? emptyList<drive.Reply>()
    : drive.listReplies
        .pages({
          fileId,
          commentId,
          pageSize: 100,
        })
        .pipe(
          Stream.flatMap((page) => Stream.fromIterable(page.replies ?? [])),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.catchTag("NotFound", () => emptyList<drive.Reply>()),
          Effect.catchTag("Forbidden", () => emptyList<drive.Reply>()),
        );

export type ReplyWithParent = drive.Reply & {
  fileId: string;
  commentId: string;
};

export const listOwnedReplies = () =>
  Effect.gen(function* () {
    const comments = yield* listOwnedComments();
    const pages = yield* Effect.forEach(
      comments.filter((comment) => (comment.id ?? "").length > 0),
      (comment) =>
        listReplies(comment.fileId, comment.id ?? "").pipe(
          Effect.map((replies) =>
            replies
              .filter((reply) => hasOwnershipMarker(reply.content))
              .map((reply): ReplyWithParent => ({
                ...reply,
                fileId: comment.fileId,
                commentId: comment.id ?? "",
              })),
          ),
        ),
      { concurrency: 4 },
    );
    return pages.flat();
  });

export const findOwnedReply = (id: string, fileId: string, commentId: string) =>
  Effect.gen(function* () {
    const replies = yield* listReplies(fileId, commentId);
    for (const reply of replies) {
      if (yield* ownedByAlchemy(id, reply.content)) {
        return reply;
      }
    }
    return undefined;
  });

export const getPermission = (fileId: string, permissionId: string) =>
  fileId.length === 0 || permissionId.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(
        drive.getPermissions({
          fileId,
          permissionId,
          supportsAllDrives: true,
        }),
      );

export const listPermissions = (fileId: string) =>
  fileId.length === 0
    ? emptyList<drive.Permission>()
    : drive.listPermissions
        .pages({
          fileId,
          pageSize: 100,
          supportsAllDrives: true,
        })
        .pipe(
          Stream.flatMap((page) => Stream.fromIterable(page.permissions ?? [])),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.catchTag("NotFound", () => emptyList<drive.Permission>()),
          Effect.catchTag("Forbidden", () => emptyList<drive.Permission>()),
        );

export const isManagedPermission = (permission: drive.Permission) =>
  permission.role !== "owner" &&
  permission.deleted !== true &&
  !(permission.permissionDetails ?? []).some(
    (detail) => detail.inherited === true,
  );

export type PermissionWithFile = drive.Permission & { fileId: string };

export const listManagedPermissions = () =>
  Effect.gen(function* () {
    const files = yield* listOwnedFiles();
    const pages = yield* Effect.forEach(
      files.filter((file) => (file.id ?? "").length > 0),
      (file) =>
        listPermissions(file.id ?? "").pipe(
          Effect.map((permissions) =>
            permissions
              .filter(isManagedPermission)
              .map((permission): PermissionWithFile => ({
                ...permission,
                fileId: file.id ?? "",
              })),
          ),
        ),
      { concurrency: 4 },
    );
    return pages.flat();
  });

export const permissionMatches = (
  permission: drive.Permission,
  news: {
    permissionId?: string;
    type?: string;
    emailAddress?: string;
    domain?: string;
  },
) => {
  if (
    news.permissionId !== undefined &&
    news.permissionId.length > 0 &&
    permission.id === news.permissionId
  ) {
    return true;
  }
  if (news.type !== undefined && permission.type !== news.type) {
    return false;
  }
  if (
    news.emailAddress !== undefined &&
    (permission.emailAddress ?? "").toLowerCase() !==
      news.emailAddress.toLowerCase()
  ) {
    return false;
  }
  if (
    news.domain !== undefined &&
    (permission.domain ?? "").toLowerCase() !== news.domain.toLowerCase()
  ) {
    return false;
  }
  if (news.type === "anyone") {
    return permission.type === "anyone";
  }
  return news.type !== undefined;
};

export const findPermission = (
  fileId: string,
  news: {
    permissionId?: string;
    type?: string;
    emailAddress?: string;
    domain?: string;
  },
) =>
  Effect.gen(function* () {
    if (news.permissionId !== undefined && news.permissionId.length > 0) {
      const existing = yield* getPermission(fileId, news.permissionId);
      if (existing !== undefined) return existing;
    }
    const permissions = yield* listPermissions(fileId);
    return permissions.find((permission) =>
      permissionMatches(permission, news),
    );
  });
