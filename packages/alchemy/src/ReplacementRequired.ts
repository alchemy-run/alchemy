import * as Data from "effect/Data";

/**
 * A create-time property changed and the change reached `reconcile`
 * without a replace plan. The next plan replaces the resource.
 */
export class ReplacementRequired extends Data.TaggedError(
  "ReplacementRequired",
)<{
  readonly resourceType: string;
  readonly physicalId: string;
  readonly properties: ReadonlyArray<string>;
}> {
  override get message() {
    return `${this.resourceType} '${this.physicalId}' needs a replacement: ${this.properties.join(", ")} changed.`;
  }
}
