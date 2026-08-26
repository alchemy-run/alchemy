import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const MAX_TITLE = 300;

export class ResourceNotResolved extends Data.TaggedError(
  "GCP.Forms.ResourceNotResolved",
)<{
  formId: string;
}> {}

export const encodeTitle = (
  labels: Record<string, string>,
  title: string | undefined,
): string => {
  const marker = `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;
  const combined = title && title.length > 0 ? `${marker} ${title}` : marker;
  return combined.slice(0, MAX_TITLE);
};

export const parseTitle = (
  title: string | undefined,
): {
  labels: Record<string, string>;
  title: string | undefined;
} => {
  if (!title?.startsWith("[alchemy ")) {
    return { labels: {}, title };
  }
  const end = title.indexOf("]");
  if (end < 0) return { labels: {}, title };
  const labels: Record<string, string> = {};
  for (const part of title.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = title.slice(end + 1).trim();
  return { labels, title: rest.length > 0 ? rest : undefined };
};

export const hasOwnershipMarker = (title: string | undefined) =>
  Object.keys(parseTitle(title).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

export const ownedByAlchemy = (id: string, title: string | undefined) =>
  Effect.gen(function* () {
    const { labels } = parseTitle(title);
    return yield* hasAlchemyLabels(id, labels);
  });

export const ownedTitle = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    const labels = yield* createInternalLabels(id);
    const user =
      requested ??
      existing ??
      (yield* createPhysicalName({ id, maxLength: 40, lowercase: true }));
    return encodeTitle(labels, user);
  });
