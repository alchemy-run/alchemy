import { State } from "@livestore/livestore";
import { events } from "./events.ts";
import { tables } from "./tables.ts";

// Materializers are used to map events to state (https://docs.livestore.dev/reference/state/materializers)
export const materializers = State.SQLite.materializers(events, {
  "v1.TodoCreated": ({ id, text }) =>
    tables.todos.insert({ id, text, completed: false }),
  "v1.TodoCompleted": ({ id }) =>
    tables.todos.update({ completed: true }).where({ id }),
  "v1.TodoUncompleted": ({ id }) =>
    tables.todos.update({ completed: false }).where({ id }),
  "v1.TodoDeleted": ({ id, deletedAt }) =>
    tables.todos.update({ deletedAt }).where({ id }),
  "v1.TodoClearedCompleted": ({ deletedAt }) =>
    tables.todos.update({ deletedAt }).where({ completed: true }),
});
