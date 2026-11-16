import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

export class ComputeServiceIdentityConflict extends Data.TaggedError(
  "ComputeServiceIdentityConflict",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Refuse to patch a Compute service observed under a different immutable identity. */
export const ensureServiceImmutableIdentity = (
  app: {
    id: string;
    projectId: string;
    region: { id: string };
  },
  projectId: string,
  regionId: string,
) =>
  app.projectId === projectId && app.region.id === regionId
    ? Effect.void
    : Effect.fail(
        new ComputeServiceIdentityConflict({
          message: `Prisma Compute service '${app.id}' has immutable identity project '${app.projectId}' / region '${app.region.id}', but this resource requires project '${projectId}' / region '${regionId}'. Refusing to patch or claim the mismatched service; replace it or import the correct service ID.`,
        }),
      );
