import { makeSchema, State } from "@livestore/livestore";
import { events } from "./events.ts";
import { materializers } from "./materializers.ts";
import { tables } from "./tables.ts";

export const schema = makeSchema({
  events,
  state: State.SQLite.makeState({ tables, materializers }),
});
