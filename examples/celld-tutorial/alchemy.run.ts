import * as AWS from "@alchemy.run/aws";
import * as Celld from "@alchemy.run/celld";
import * as CelldAWS from "@alchemy.run/celld/AWS";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Cells } from "./src/fleet.ts";

export default Alchemy.Stack(
  "CelldTutorial",
  {
    providers: Layer.mergeAll(
      AWS.providers(),
      Celld.providers(),
      CelldAWS.EcsFleet().pipe(Layer.provide(CelldAWS.EcsTaskManagement())),
    ),
    state: AWS.state(),
  },
  Effect.gen(function* () {
    const cells = yield* Cells;
    return { url: cells.publicUrl };
  }),
);
