import * as ipLists from "@distilled.cloud/stackit/lb_ip_lists";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Effect from "effect/Effect";
import type { ProjectScope } from "../IaaS/internal.ts";

/** The spec's name pattern: 1-51 characters of `[0-9a-z-]`. */
const NAME_MAX_LENGTH = 51;

/** Physical name for an IP list. */
export const physicalName = (id: string) =>
  createPhysicalName({ id, maxLength: NAME_MAX_LENGTH, lowercase: true });

/** `GetIPList`; `undefined` when the list is gone. */
export const getIPListOrUndefined = (scope: ProjectScope, name: string) =>
  ipLists.getIPList({ ...scope, name }).pipe(Effect.catchTag("NotFound", () => Effect.undefined));
