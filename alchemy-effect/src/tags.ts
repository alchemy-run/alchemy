import * as Effect from "effect/Effect";
import { App } from "./app.ts";

export type Tags =
  | Record<string, string>
  | [string, string][]
  | { Key: string; Value: string }[];

const normalizeTags = (tags: Tags) =>
  Array.isArray(tags)
    ? Object.fromEntries(
        tags.map((tag) =>
          Array.isArray(tag) ? [tag[0], tag[1]] : [tag.Key, tag.Value],
        ),
      )
    : tags;

export const hasTags = (expectedTags: Tags, tags: Tags | undefined) => {
  const actualTags = normalizeTags(tags ?? []);
  return Object.entries(normalizeTags(expectedTags)).every(
    ([key, value]) => actualTags[key] === value,
  );
};

export const createTagsList = (tags: Tags) =>
  Object.entries(normalizeTags(tags)).map(([Key, Value]) => ({
    Key,
    Value,
  }));

export const createTagger = Effect.fn(function* () {
  const app = yield* App;
  return (id: string) => ({
    "alchemy::app": app.name,
    "alchemy::stage": app.stage,
    "alchemy::id": id,
  });
});

export const diffTags = (
  oldTags: Record<string, string>,
  newTags: Record<string, string>,
) => {
  const removed: string[] = [];
  const updated: { Key: string; Value: string }[] = [];
  const added: { Key: string; Value: string }[] = [];
  for (const key in oldTags) {
    if (!(key in newTags)) {
      removed.push(key);
    } else if (oldTags[key] !== newTags[key]) {
      updated.push({ Key: key, Value: newTags[key] });
    }
  }
  for (const key in newTags) {
    if (!(key in oldTags)) {
      added.push({ Key: key, Value: newTags[key] });
    } else if (oldTags[key] !== newTags[key]) {
      updated.push({ Key: key, Value: newTags[key] });
    }
  }
  return {
    added,
    removed,
    updated,
    upsert: [...added, ...updated].filter(
      (tag, index, self) => self.findIndex((t) => t.Key === tag.Key) === index,
    ),
  };
};
