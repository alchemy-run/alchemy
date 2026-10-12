import { alchemyLabelKeys } from "../Labels.ts";

/**
 * Ownership marker for IAM resources that have no labels (workload identity
 * pools and providers). Alchemy stamps `[alchemy alchemy-stack=… alchemy-stage=…
 * alchemy-id=…]` in front of the user description and strips it back out of
 * the `description` attribute.
 */
export const encodeOwnedDescription = (
  labels: Record<string, string>,
  description: string | undefined,
  maxLength: number,
): string => {
  const marker = `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;
  if (!description) return marker.slice(0, maxLength);
  const sep = "\n";
  const budget = maxLength - marker.length - sep.length;
  if (budget <= 0) return marker.slice(0, maxLength);
  return `${marker}${sep}${description.slice(0, budget)}`;
};

export const parseOwnedDescription = (
  description: string | undefined,
): {
  labels: Record<string, string>;
  description: string | undefined;
} => {
  if (!description?.startsWith("[alchemy ")) {
    return { labels: {}, description: description || undefined };
  }
  const end = description.indexOf("]");
  if (end < 0) return { labels: {}, description };
  const labels: Record<string, string> = {};
  for (const part of description.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = description.slice(end + 1).replace(/^\n/, "");
  return { labels, description: rest.length > 0 ? rest : undefined };
};

export const hasOwnedDescription = (description: string | undefined) =>
  Object.keys(parseOwnedDescription(description).labels).some((key) => key.startsWith("alchemy-"));
