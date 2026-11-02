import * as Stackit from "@alchemy.run/stackit";
import { ServerHost } from "alchemy/Runtime/Process";
import * as Effect from "effect/Effect";

/**
 * A program with a background loop that declares scaling to zero: nothing could run the loop
 * there, so a deploy refuses before it builds or creates anything.
 */
export default class BackgroundApplication extends Stackit.ContainerApplications.Application<BackgroundApplication>()(
  "StackitScaBackground",
  {
    main: import.meta.url,
    environmentId: "never-reached",
    registry: { repository: "registry.alchemy.invalid/never/pushed" },
    scaling: { type: "auto", minInstances: 0, maxInstances: 1 },
  },
  Effect.gen(function* () {
    const { run } = yield* ServerHost;
    yield* run(Effect.never);
    return {};
  }),
) {}
