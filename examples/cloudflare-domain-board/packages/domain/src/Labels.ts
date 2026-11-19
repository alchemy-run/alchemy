import * as Schema from "effect/Schema";

/** Labels on a thread, each a `key=value` pair by convention: `kind=bug`, `pr=812`. */
export const Labels = Schema.Array(Schema.String).annotate({
  description: 'Labels, such as ["kind=bug","pr=812"]',
});
export type Labels = typeof Labels.Type;

/** Whether `labels` has every label in `wanted`. */
export const hasAll = (labels: Labels, wanted: Labels): boolean =>
  wanted.every((label) => labels.includes(label));
