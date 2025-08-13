---
title: D1 + Drizzle
description: Build a full-stack application with Drizzle ORM and Cloudflare D1 Database using Alchemy for type-safe database operations.
sidebar:
  order: 15
---

import { Tabs, TabItem, Steps } from '@astrojs/starlight/components';

Build a full-stack application with Drizzle ORM and Cloudflare D1 Database. This guide shows you how to set up a type-safe database layer with automated migrations and a web interface.

<Steps>

1. **Create your project**

   Start by creating a new project and installing dependencies.

   ```sh
   mkdir drizzle-d1-app
   cd drizzle-d1-app
   ```

   <Tabs syncKey="pkgManager">
     <TabItem label="bun">
       ```sh
       bun init -y
       bun add alchemy drizzle-orm
       bun add -D drizzle-kit @types/node
       ```
     </TabItem>
     <TabItem label="npm">
       ```sh
       npm init -y
       npm install alchemy drizzle-orm
       npm install -D drizzle-kit @types/node
       ```
     </TabItem>
     <TabItem label="pnpm">
       ```sh
       pnpm init
       pnpm add alchemy drizzle-orm
       pnpm add -D drizzle-kit @types/node
       ```
     </TabItem>
     <TabItem label="yarn">
       ```sh
       yarn init -y
       yarn add alchemy drizzle-orm
       yarn add -D drizzle-kit @types/node
       ```
     </TabItem>
   </Tabs>

2. **Login to Cloudflare**

   Authenticate with your Cloudflare account.

   <Tabs syncKey="pkgManager">
     <TabItem label="bun">
       ```sh
       bun alchemy login
       ```
     </TabItem>
     <TabItem label="npm">
       ```sh
       npx alchemy login
       ```
     </TabItem>
     <TabItem label="pnpm">
       ```sh
       pnpm alchemy login
       ```
     </TabItem>
     <TabItem label="yarn">
       ```sh
       yarn alchemy login
       ```
     </TabItem>
   </Tabs>

   :::tip
   Make sure you have a [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works)
   :::

3. **Set up Drizzle schema**

   Create your database schema with Drizzle ORM:

   ```typescript
   // src/schema.ts
   import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

   export const users = sqliteTable('users', {
     id: integer('id').primaryKey({ autoIncrement: true }),
     name: text('name').notNull(),
     email: text('email').notNull().unique(),
     createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
   });

   export const posts = sqliteTable('posts', {
     id: integer('id').primaryKey({ autoIncrement: true }),
     title: text('title').notNull(),
     content: text('content').notNull(),
     authorId: integer('author_id').notNull().references(() => users.id),
     createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
   });
   ```

4. **Configure Drizzle Kit**

   Create `drizzle.config.ts` for migration generation:

   ```typescript
   // drizzle.config.ts
   import { defineConfig } from 'drizzle-kit';

   export default defineConfig({
     schema: './src/schema.ts',
     out: './migrations',
     dialect: 'sqlite',
   });
   ```

5. **Generate migrations**

   Generate SQL migrations from your schema:

   <Tabs syncKey="pkgManager">
     <TabItem label="bun">
       ```sh
       bun drizzle-kit generate
       ```
     </TabItem>
     <TabItem label="npm">
       ```sh
       npx drizzle-kit generate
       ```
     </TabItem>
     <TabItem label="pnpm">
       ```sh
       pnpm drizzle-kit generate
       ```
     </TabItem>
     <TabItem label="yarn">
       ```sh
       yarn drizzle-kit generate
       ```
     </TabItem>
   </Tabs>

   This creates migration files in the `migrations/` directory.

6. **Create your infrastructure**

   Create `alchemy.run.ts` with D1 database and Worker:

   ```typescript
   // alchemy.run.ts
   import alchemy from "alchemy";
   import { D1Database, Worker } from "alchemy/cloudflare";

   const app = await alchemy("drizzle-d1-app");

   // Create D1 database with migrations
   const database = await D1Database("app-db", {
     name: "app-db",
     migrationsDir: "./migrations",
   });

   // Create API worker
   export const worker = await Worker("api-worker", {
     name: "api-worker",
     entrypoint: "./src/worker.ts",
     bindings: {
       DB: database,
     },
   });

   console.log(`API available at: ${worker.url}`);
   await app.finalize();
   ```

7. **Create your worker with Drizzle**

   Create `src/worker.ts` with basic Drizzle ORM integration:

   ```typescript
   // src/worker.ts
   import { drizzle } from 'drizzle-orm/d1';
   import { users } from './schema';
   import type { worker } from "../alchemy.run.ts"

   // infer the types
   type Env = typeof worker.Env

   export default {
     async fetch(request: Request, env: Env): Promise<Response> {
       const db = drizzle(env.DB);
       
       // Create a sample user
       const newUser = await db.insert(users).values({
         name: 'John Doe',
         email: 'john@example.com',
         createdAt: new Date(),
       }).returning();
       
       // Query all users
       const allUsers = await db.select().from(users);
       
       return new Response(JSON.stringify({
         message: 'Drizzle D1 working!',
         newUser: newUser[0],
         allUsers
       }), {
         headers: { 'Content-Type': 'application/json' }
       });
     },
   };
   ```

8. **Deploy your application**

   Deploy your D1 database and worker:

   <Tabs syncKey="pkgManager">
     <TabItem label="bun">
       ```sh
       bun alchemy deploy
       ```
     </TabItem>
     <TabItem label="npm">
       ```sh
       npx alchemy deploy
       ```
     </TabItem>
     <TabItem label="pnpm">
       ```sh
       pnpm alchemy deploy
       ```
     </TabItem>
     <TabItem label="yarn">
       ```sh
       yarn alchemy deploy
       ```
     </TabItem>
   </Tabs>

   Your API will be available at the displayed URL. Test it with:

   ```sh
   # Test the Drizzle D1 integration
   curl https://api-worker.your-account.workers.dev
   ```

9. **(Optional) Tear down**

    Clean up all resources when you're done:

    <Tabs syncKey="pkgManager">
      <TabItem label="bun">
        ```sh
        bun alchemy destroy
        ```
      </TabItem>
      <TabItem label="npm">
        ```sh
        npx alchemy destroy
        ```
      </TabItem>
      <TabItem label="pnpm">
        ```sh
        pnpm alchemy destroy
        ```
      </TabItem>
      <TabItem label="yarn">
        ```sh
        yarn alchemy destroy
        ```
      </TabItem>
    </Tabs>

</Steps>
