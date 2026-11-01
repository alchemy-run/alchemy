import * as AWS from "@alchemy.run/aws";
import * as Convex from "@alchemy.run/convex/aws";
import * as Alchemy from "alchemy";
import { Stage } from "alchemy/Stage";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

/**
 * What stages share. Deploy it once per AWS account, with stage `prod` to the
 * production account and stage `dev` to the development account.
 */
export class Platform extends Alchemy.Stack<Platform, { convex: Convex.PlatformHandle }>()(
  "ConvexPlatform",
) {}

export default Platform.make(
  { providers: Convex.providers(), state: AWS.state() },
  Effect.gen(function* () {
    const stage = yield* Stage;
    const convex = yield* Convex.Platform("Convex", {
      domain: yield* Config.String("CONVEX_DOMAIN"),
      db: { engine: "postgres", instanceClass: "db.t4g.micro", storage: 20 },
      deletionProtection: stage === "prod",
    });
    return { convex };
  }),
);
