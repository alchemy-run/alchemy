import * as Effect from "effect/Effect";
import { isPrismaDevId } from "./Refs.ts";
import type { PrismaManagementClient } from "./Client.ts";

/** Resolves the desired branch id from explicit props or the project's default branch. */
export const desiredBranchId = Effect.fn(function* (
  client: PrismaManagementClient,
  projectId: string,
  props: { branchId?: string; branchGitName?: string },
) {
  if (props.branchId !== undefined && !isPrismaDevId(props.branchId)) {
    return props.branchId;
  }
  if (props.branchGitName !== undefined) {
    const branches = yield* client.listBranches(projectId, {
      gitName: props.branchGitName,
      limit: 2,
    });
    if (branches.length > 1) {
      return yield* Effect.fail(
        new Error(
          `Prisma returned multiple branches named '${props.branchGitName}' in project '${projectId}'; refusing to select one arbitrarily.`,
        ),
      );
    }
    return branches[0]?.id;
  }
  const branches = yield* client.listBranches(projectId, { limit: 100 });
  const defaults = branches.filter((branch) => branch.isDefault);
  if (defaults.length > 1) {
    return yield* Effect.fail(
      new Error(
        `Prisma returned multiple default branches for project '${projectId}'; refusing to select one arbitrarily.`,
      ),
    );
  }
  return defaults[0]?.id;
});
