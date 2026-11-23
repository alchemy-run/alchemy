import * as Domain from "@alchemy.run/domain";
import { UsernameClaim } from "./UsernameClaim.aggregate.ts";

/** Removes a username's claim, so the name no longer leads to anyone. */
export class ReleaseUsername extends Domain.Rewrite("ReleaseUsername", {
  of: UsernameClaim,
  delete: true,
}) {}
