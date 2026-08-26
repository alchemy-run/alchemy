import * as blogger from "@distilled.cloud/gcp/blogger_v3";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const DEFAULT_USER = "self";
export const MAX_TITLE_LENGTH = 200;
export const PAGE_STATUSES: blogger.ListPagesStatusEnumList = [
  "LIVE",
  "DRAFT",
  "SOFT_TRASHED",
];
export const POST_STATUSES: blogger.ListPostsStatusEnumList = [
  "LIVE",
  "DRAFT",
  "SCHEDULED",
  "SOFT_TRASHED",
];

export type PostLocation = {
  name?: string;
  lat?: number;
  lng?: number;
  span?: string;
};

export type PostImage = {
  url?: string;
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
  maxLength = MAX_TITLE_LENGTH,
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

const HTML_MARKER = /^<!--\s*(\[alchemy [^\]]+\])\s*-->\s*/;

export const encodeContentOwnership = (
  labels: Record<string, string>,
  content: string | undefined,
): string => {
  const marker = fitMarker(labels, 8000);
  const comment = `<!-- ${marker} -->`;
  const trimmed = content?.trim();
  return trimmed && trimmed.length > 0 ? `${comment}\n${trimmed}` : comment;
};

export const parseContentOwnership = (content: string | undefined) => {
  if (!content)
    return { labels: {} as Record<string, string>, text: undefined };
  const html = content.match(HTML_MARKER);
  if (html?.[1]) {
    const parsed = parseOwnership(html[1]);
    const rest = content.slice(html[0].length);
    return { labels: parsed.labels, text: rest.length > 0 ? rest : undefined };
  }
  return parseOwnership(content);
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

export const contentHasAlchemy = (content: string | undefined) => {
  const parsed = parseContentOwnership(content);
  return (
    Object.keys(parsed.labels).some((key) => key.startsWith("alchemy-")) ||
    hasOwnershipMarker(content)
  );
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

export const contentOwnedByAlchemy = (
  id: string,
  content: string | undefined,
) =>
  Effect.gen(function* () {
    const parsed = parseContentOwnership(content);
    if (Object.keys(parsed.labels).some((key) => key.startsWith("alchemy-"))) {
      const expected = yield* createInternalLabels(id);
      const exact = yield* hasAlchemyLabels(id, parsed.labels);
      if (exact) return true;
      return (
        prefixMatch(
          expected[alchemyLabelKeys.stack] ?? "",
          parsed.labels[alchemyLabelKeys.stack] ?? "",
        ) &&
        prefixMatch(
          expected[alchemyLabelKeys.stage] ?? "",
          parsed.labels[alchemyLabelKeys.stage] ?? "",
        ) &&
        prefixMatch(
          expected[alchemyLabelKeys.id] ?? "",
          parsed.labels[alchemyLabelKeys.id] ?? "",
        )
      );
    }
    return yield* ownedByAlchemy(id, content);
  });

export const encodeCustomMetaData = (
  labels: Record<string, string>,
  user: string | undefined,
): string => {
  let parsed: Record<string, unknown> = {};
  if (user !== undefined && user.length > 0) {
    try {
      const value = JSON.parse(user) as unknown;
      if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
      ) {
        parsed = value as Record<string, unknown>;
      } else {
        parsed = { value: user };
      }
    } catch {
      parsed = { value: user };
    }
  }
  return JSON.stringify({
    ...parsed,
    alchemy: "true",
    ...labels,
  });
};

export const parseCustomMetaData = (
  raw: string | undefined,
): {
  labels: Record<string, string>;
  text: string | undefined;
} => {
  if (raw === undefined || raw.length === 0) {
    return { labels: {}, text: undefined };
  }
  try {
    const value = JSON.parse(raw) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { labels: {}, text: raw };
    }
    const obj = value as Record<string, unknown>;
    const labels: Record<string, string> = {};
    const rest: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(obj)) {
      if (key === "alchemy" || key.startsWith("alchemy-")) {
        if (typeof entry === "string") labels[key] = entry;
      } else {
        rest[key] = entry;
      }
    }
    return {
      labels,
      text: Object.keys(rest).length > 0 ? JSON.stringify(rest) : undefined,
    };
  } catch {
    return { labels: {}, text: raw };
  }
};

export const metaOwnedByAlchemy = (id: string, raw: string | undefined) =>
  Effect.gen(function* () {
    const { labels } = parseCustomMetaData(raw);
    if (Object.keys(labels).length === 0) return false;
    const exact = yield* hasAlchemyLabels(id, labels);
    if (exact) return true;
    const expected = yield* createInternalLabels(id);
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

export const pageOwnedByAlchemy = (id: string, page: blogger.Page) =>
  Effect.gen(function* () {
    if (yield* ownedByAlchemy(id, page.title)) return true;
    return yield* contentOwnedByAlchemy(id, page.content);
  });

export const postOwnedByAlchemy = (id: string, post: blogger.Post) =>
  Effect.gen(function* () {
    if (yield* ownedByAlchemy(id, post.title)) return true;
    if (yield* contentOwnedByAlchemy(id, post.content)) return true;
    return yield* metaOwnedByAlchemy(id, post.customMetaData);
  });

export const hasAlchemyPageMarker = (page: blogger.Page) =>
  hasOwnershipMarker(page.title) || contentHasAlchemy(page.content);

export const hasAlchemyPostMarker = (post: blogger.Post) =>
  hasOwnershipMarker(post.title) ||
  contentHasAlchemy(post.content) ||
  Object.keys(parseCustomMetaData(post.customMetaData).labels).length > 0;

export const ownershipLabels = (id: string) => createInternalLabels(id);

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

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

export const locationOf = (
  location: blogger.PostLocation | undefined,
): PostLocation | undefined => {
  if (location === undefined) return undefined;
  return {
    name: location.name,
    lat: location.lat,
    lng: location.lng,
    span: location.span,
  };
};

export const imagesOf = (
  images: blogger.PostImagesItemList | undefined,
): PostImage[] | undefined => {
  if (images === undefined) return undefined;
  return images.map((image) => ({ url: image.url }));
};

export const userLabelsOf = (labels: readonly string[] | undefined): string[] =>
  (labels ?? []).filter(
    (label) =>
      !label.toLowerCase().startsWith("alchemy-") &&
      label.toLowerCase() !== "alchemy",
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
      : `b${generated}`.slice(0, maxLength);
    return next.length >= 4 ? next : `${next}xxxx`.slice(0, maxLength);
  });

export const isDraftStatus = (status: string | undefined) =>
  (status ?? "DRAFT") === "DRAFT";

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

export const getPage = (blogId: string, pageId: string) =>
  blogId.length === 0 || pageId.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(
        blogger.getPages({
          blogId,
          pageId,
          view: "ADMIN",
        }),
      );

export const getPost = (blogId: string, postId: string) =>
  blogId.length === 0 || postId.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(
        blogger.getPosts({
          blogId,
          postId,
          fetchBody: true,
          fetchImages: true,
          view: "ADMIN",
        }),
      );

export const listUserBlogs = () =>
  blogger
    .listByUserBlogs({
      userId: DEFAULT_USER,
      status: ["LIVE"],
      view: "ADMIN",
    })
    .pipe(
      Effect.map((page) => page.items ?? []),
      Effect.catchTag("NotFound", () => emptyList<blogger.Blog>()),
      Effect.catchTag("Forbidden", () => emptyList<blogger.Blog>()),
    );

export const listPages = (blogId: string) =>
  blogId.length === 0
    ? emptyList<blogger.Page>()
    : blogger.listPages
        .pages({
          blogId,
          fetchBodies: true,
          maxResults: 100,
          status: PAGE_STATUSES,
          view: "ADMIN",
        })
        .pipe(
          Stream.flatMap((page) => Stream.fromIterable(page.items ?? [])),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.catchTag("NotFound", () => emptyList<blogger.Page>()),
          Effect.catchTag("Forbidden", () => emptyList<blogger.Page>()),
        );

export const listPosts = (blogId: string) =>
  blogId.length === 0
    ? emptyList<blogger.Post>()
    : blogger.listPosts
        .pages({
          blogId,
          fetchBodies: true,
          fetchImages: true,
          maxResults: 100,
          status: POST_STATUSES,
          view: "ADMIN",
        })
        .pipe(
          Stream.flatMap((page) => Stream.fromIterable(page.items ?? [])),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.catchTag("NotFound", () => emptyList<blogger.Post>()),
          Effect.catchTag("Forbidden", () => emptyList<blogger.Post>()),
        );

export const listOwnedPages = () =>
  Effect.gen(function* () {
    const blogs = yield* listUserBlogs();
    const pages = yield* Effect.forEach(
      blogs.filter((blog) => (blog.id ?? "").length > 0),
      (blog) =>
        listPages(blog.id ?? "").pipe(
          Effect.map((items) => items.filter(hasAlchemyPageMarker)),
        ),
      { concurrency: 4 },
    );
    return pages.flat();
  });

export const listOwnedPosts = () =>
  Effect.gen(function* () {
    const blogs = yield* listUserBlogs();
    const posts = yield* Effect.forEach(
      blogs.filter((blog) => (blog.id ?? "").length > 0),
      (blog) =>
        listPosts(blog.id ?? "").pipe(
          Effect.map((items) => items.filter(hasAlchemyPostMarker)),
        ),
      { concurrency: 4 },
    );
    return posts.flat();
  });

export const findOwnedPage = (id: string, blogId: string) =>
  Effect.gen(function* () {
    const pages =
      blogId.length > 0 ? yield* listPages(blogId) : yield* listOwnedPages();
    for (const page of pages) {
      if (yield* pageOwnedByAlchemy(id, page)) {
        return page;
      }
    }
    return undefined;
  });

export const findOwnedPost = (id: string, blogId: string) =>
  Effect.gen(function* () {
    const posts =
      blogId.length > 0 ? yield* listPosts(blogId) : yield* listOwnedPosts();
    for (const post of posts) {
      if (yield* postOwnedByAlchemy(id, post)) {
        return post;
      }
    }
    return undefined;
  });
