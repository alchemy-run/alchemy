import * as kv from "@distilled.cloud/cloudflare/kv";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";

type NamespaceMode = "classic" | "instant";

const matchesMode = (namespace: { mode?: "instant" | null }, mode: NamespaceMode) =>
  (namespace.mode === "instant") === (mode === "instant");

export const createTitle = (id: string, title: string | undefined) =>
  Effect.gen(function* () {
    return title ?? (yield* createPhysicalName({ id }));
  });

export const getNamespace = (accountId: string, namespaceId: string) =>
  kv
    .getNamespace({ accountId, namespaceId })
    .pipe(Effect.catchTag("NamespaceNotFound", () => Effect.succeed(undefined)));

export const deleteNamespace = (accountId: string, namespaceId: string) =>
  kv
    .deleteNamespace({ accountId, namespaceId })
    .pipe(Effect.catchTag("NamespaceNotFound", () => Effect.void));

// Namespace titles cannot be filtered server-side. Scan all pages for adoption,
// but stop once the matching title and storage mode are found.
export const findNamespaceByTitle = (accountId: string, title: string, mode: NamespaceMode) =>
  kv.listNamespaces.items({ accountId }).pipe(
    Stream.filter((ns) => ns.title === title && matchesMode(ns, mode)),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
  );

export const listNamespaces = (accountId: string, mode: NamespaceMode) =>
  kv.listNamespaces.items({ accountId }).pipe(
    Stream.filter((ns) => matchesMode(ns, mode)),
    Stream.runCollect,
    Effect.map((namespaces) => Array.from(namespaces)),
  );

// Title is the only mutable property. Preserve the observed response unless a
// rename is needed, then return the attributes shared by both resource types.
export const syncNamespaceTitle = Effect.fn(function* (
  accountId: string,
  observed: { id: string; title: string; supportsUrlEncoding?: boolean | null },
  title: string,
) {
  const namespace =
    observed.title === title
      ? observed
      : yield* kv.updateNamespace({ accountId, namespaceId: observed.id, title });
  return {
    title: namespace.title,
    namespaceId: namespace.id,
    supportsUrlEncoding: namespace.supportsUrlEncoding ?? undefined,
    accountId,
  };
});
