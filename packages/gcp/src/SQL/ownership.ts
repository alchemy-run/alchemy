import { alchemyLabelKeys } from "../Labels.ts";

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const instanceIdOf = (value: string) => lastSegment(value);

/**
 * Stamp the ownership marker ahead of `description`. With `maxLength` (Cloud
 * SQL backups allow 140 characters) the stack and stage values are shortened
 * — the same way every time — so the marker and the user's text fit; the id,
 * which ownership matching reads, is kept whole.
 */
export const encodeDescription = (
  labels: Record<string, string>,
  description: string | undefined,
  maxLength = Number.POSITIVE_INFINITY,
): string => {
  const stack = labels[alchemyLabelKeys.stack] ?? "";
  const stage = labels[alchemyLabelKeys.stage] ?? "";
  const id = labels[alchemyLabelKeys.id] ?? "";
  const markerOf = (stackValue: string, stageValue: string) =>
    `[alchemy ${alchemyLabelKeys.stack}=${stackValue} ${alchemyLabelKeys.stage}=${stageValue} ${alchemyLabelKeys.id}=${id}]`;
  const withText = (marker: string) => (description ? `${marker}\n${description}` : marker);
  let marker = markerOf(stack, stage);
  const over = withText(marker).length - maxLength;
  if (over > 0) {
    const stackCut = Math.min(over, Math.max(0, stack.length - 8));
    const stageCut = Math.min(over - stackCut, Math.max(0, stage.length - 8));
    marker = markerOf(
      stack.slice(0, stack.length - stackCut),
      stage.slice(0, stage.length - stageCut),
    );
  }
  return withText(marker).slice(0, maxLength);
};

export const parseDescription = (
  description: string | undefined,
): {
  labels: Record<string, string>;
  description: string | undefined;
} => {
  if (!description?.startsWith("[alchemy ")) {
    return { labels: {}, description };
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

export const hasOwnershipMarker = (description: string | undefined) =>
  Object.keys(parseDescription(description).labels).some((key) => key.startsWith("alchemy-"));

export const matchesOwnership = (description: string | undefined, labels: Record<string, string>) =>
  parseDescription(description).labels[alchemyLabelKeys.id] === labels[alchemyLabelKeys.id];
