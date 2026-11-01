import { boolean, pgTable, text, uuid } from "drizzle-orm/pg-core";

/** The table `migrations/0001_create_todos.sql` creates. */
export const todos = pgTable("todos", {
  id: uuid("id").primaryKey(),
  title: text("title").notNull(),
  done: boolean("done").notNull().default(false),
});
