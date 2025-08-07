import { Schema, SessionIdSymbol, State } from "@livestore/livestore";

// You can model your state as SQLite tables (https://docs.livestore.dev/reference/state/sqlite-schema)
export const tables = {
  todos: State.SQLite.table({
    name: "todos",
    columns: {
      id: State.SQLite.text({ primaryKey: true }),
      text: State.SQLite.text({ default: "" }),
      completed: State.SQLite.boolean({ default: false }),
      deletedAt: State.SQLite.integer({
        nullable: true,
        schema: Schema.DateFromNumber,
      }),
    },
  }),
  // Client documents can be used for local-only state (e.g. form inputs)
  uiState: State.SQLite.clientDocument({
    name: "uiState",
    schema: Schema.Struct({
      newTodoText: Schema.String,
      filter: Schema.Literal("all", "active", "completed"),
    }),
    default: {
      id: SessionIdSymbol,
      value: {
        newTodoText: "",
        filter: "all",
      },
    },
  }),
};
