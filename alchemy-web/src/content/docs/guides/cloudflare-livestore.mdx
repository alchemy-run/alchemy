---
title: LiveStore (Cloudflare)
description: Deploy a LiveStore sync backend on Cloudflare Workers and connect it to a React client with Alchemy.
sidebar:
  order: 20
---

import { Tabs, TabItem, Steps } from '@astrojs/starlight/components';

LiveStore lets you build local-first, real-time, collaborative apps by combining an **event-sourced SQLite state** with automatic syncing.  


This guide walks you through setting up a LiveStore sync backend on Cloudflare Workers with D1 and connecting it to a React client with Alchemy.

:::note
For deeper details see the official [LiveStore Cloudflare guide](https://docs.livestore.dev/reference/syncing/sync-provider/cloudflare/).
:::

<Steps>

1. **Install dependencies**

    <Tabs syncKey="pkgManager">
      <TabItem label="bun">
        ```sh
        bun add alchemy @livestore/livestore @livestore/adapter-web @livestore/react @livestore/sync-cf react react-dom vite
        ```
      </TabItem>
      <TabItem label="npm">
        ```sh
        npm install alchemy @livestore/livestore @livestore/adapter-web @livestore/react @livestore/sync-cf react react-dom vite
        ```
      </TabItem>
      <TabItem label="pnpm">
        ```sh
        pnpm add alchemy @livestore/livestore @livestore/adapter-web @livestore/react @livestore/sync-cf react react-dom vite
        ```
      </TabItem>
      <TabItem label="yarn">
        ```sh
        yarn add alchemy @livestore/livestore @livestore/adapter-web @livestore/react @livestore/sync-cf react react-dom vite
        ```
      </TabItem>
    </Tabs>

2. **Create folder structure**

   Create `src/livestore/` and add the following files.

3. **Tables** – `src/livestore/tables.ts`

   Define your SQLite tables and any client documents used for local-only UI state.

   ```ts
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
   ```

4. **Events** – `src/livestore/events.ts`

   Describe all domain events (and reference `tables.uiState.set` for client docs).

   ```ts
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
   ```

5. **Materializers** – `src/livestore/materializers.ts`

   Map each event to mutations on your SQLite tables.

   ```ts
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
   ```

6. **Queries** – `src/livestore/queries.ts`

   Define any derived or convenience queries against your state.

   ```ts
   import { queryDb } from "@livestore/livestore";
   import { tables } from "./tables.ts";

   export const uiState$ = queryDb(tables.uiState.get(), { label: "uiState" });
   ```

7. **Schema** – `src/livestore/schema.ts`

   Assemble `events` and `state` into a complete LiveStore `schema`.

   ```ts
   import { makeSchema, State } from "@livestore/livestore";
   import { events } from "./events.ts";
   import { materializers } from "./materializers.ts";
   import { tables } from "./tables.ts";

   export const schema = makeSchema({
     events,
     state: State.SQLite.makeState({ tables, materializers }),
   });
   ```

8. **Client worker** – `src/livestore/worker.ts`

   Create a tiny web worker that connects the client to the Cloudflare sync backend.

   ```ts
   import { makeWorker } from "@livestore/adapter-web/worker";
   import { makeCfSync } from "@livestore/sync-cf";

   import { schema } from "./schema.ts";

   makeWorker({
     schema,
     sync: {
       backend: makeCfSync({ url: import.meta.env.VITE_LIVESTORE_SYNC_URL }),
       initialSyncOptions: { _tag: "Blocking", timeout: 5000 },
     },
   });
   ```

9. **Cloudflare sync backend** – `src/livestore/server.ts`

   Expose the LiveStore Cloudflare Worker and Durable Object for real-time sync.

   ```ts
   import { makeDurableObject, makeWorker } from "@livestore/sync-cf/cf-worker";

   export class WebSocketServer extends makeDurableObject({
     onPush: async (message) => {
       console.log("onPush", message.batch);
     },
     onPull: async (message) => {
       console.log("onPull", message);
     },
   }) {}

   export default makeWorker({
     validatePayload: (payload: any) => {
       if (payload?.authToken !== "insecure-token-change-me") {
         throw new Error("Invalid auth token");
       }
     },
     enableCORS: true,
   });
   ```

10. **Describe infrastructure** – `alchemy.run.ts`

    ```ts
    import alchemy from "alchemy";
    import { D1Database, DurableObjectNamespace, Vite, Worker } from "alchemy/cloudflare";

    const app = await alchemy("cloudflare-livestore");

    // Cloudflare Worker hosting the sync backend
    const server = await Worker("server", {
      entrypoint: "src/livestore/server.ts",
      compatibility: "node",
      bindings: {
        DB: await D1Database("db", { 
          name: `${app.name}-${app.stage}-livestore`, 
          adopt: true 
        }),
        WEBSOCKET_SERVER: DurableObjectNamespace("websocket-server", { 
          className: "WebSocketServer" 
        }),
      },
    });

    // Vite site serving your React app
    await Vite("client", {
      assets: "dist",
      env: {
        VITE_LIVESTORE_SYNC_URL: server.url!,
      },
    });

    await app.finalize();
    ```

11. **Run locally**

    ```sh
    bun alchemy dev
    # open http://localhost:8787 to see LiveStore in action
    ```

12. **Deploy to production**

    ```sh
    bun alchemy deploy
    ```

</Steps>

Alchemy will provision:

* a Cloudflare Worker (with Durable Object + D1) for syncing
* your Vite site, with `VITE_LIVESTORE_SYNC_URL` automatically wired up

## Next steps

- Explore advanced **syncing options** in the [LiveStore docs](https://docs.livestore.dev/reference/syncing)
- Enable **Dev-Tools** (`@livestore/devtools-vite`) for local debugging
- Extend the schema and events as your app grows 