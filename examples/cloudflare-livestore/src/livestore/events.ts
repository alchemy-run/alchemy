import { Events, Schema } from "@livestore/livestore";
import { tables } from "./tables.ts";

// Events describe data changes (https://docs.livestore.dev/reference/events)
export const events = {
  todoCreated: Events.synced({
    name: "v1.TodoCreated",
    schema: Schema.Struct({ id: Schema.String, text: Schema.String }),
  }),
  todoCompleted: Events.synced({
    name: "v1.TodoCompleted",
    schema: Schema.Struct({ id: Schema.String }),
  }),
  todoUncompleted: Events.synced({
    name: "v1.TodoUncompleted",
    schema: Schema.Struct({ id: Schema.String }),
  }),
  todoDeleted: Events.synced({
    name: "v1.TodoDeleted",
    schema: Schema.Struct({ id: Schema.String, deletedAt: Schema.Date }),
  }),
  todoClearedCompleted: Events.synced({
    name: "v1.TodoClearedCompleted",
    schema: Schema.Struct({ deletedAt: Schema.Date }),
  }),
  uiStateSet: tables.uiState.set,
};
