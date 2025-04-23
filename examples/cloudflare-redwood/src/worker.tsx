import { index, render } from "@redwoodjs/sdk/router";
import { defineApp } from "@redwoodjs/sdk/worker";
import { drizzle } from "drizzle-orm/d1";
import { Document } from "src/Document";
import { setCommonHeaders } from "src/headers";
import { Home } from "src/pages/Home";

export interface Env {
  DB: D1Database;
}

export type AppContext = {
  db: ReturnType<typeof drizzle>;
};

export default defineApp<AppContext>([
  setCommonHeaders(),
  ({ appContext, env }) => {
    // setup db in appContext
    appContext.db = drizzle(env.DB);
  },
  render(Document, [index([Home])]),
]);
