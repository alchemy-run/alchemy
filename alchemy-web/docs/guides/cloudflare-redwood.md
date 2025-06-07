---
order: 3
title: Redwood
description: Deploy RedwoodJS applications with Drizzle ORM and D1 database to Cloudflare Workers using Alchemy. Includes schema migration and local development setup.
---

# Redwood

This guide demonstrates how to deploy a Redwood application with Drizzle to Cloudflare using Alchemy.

## Create a new Redwood Project

Start by creating a new Redwood project using the Drizzle template:

::: code-group

```sh [bun]
bunx degit redwoodjs/example-drizzle my-cloudflare-app
cd my-cloudflare-app
bun install
```

```sh [npm]
npx degit redwoodjs/example-drizzle my-cloudflare-app
cd my-cloudflare-app
npm install
```

```sh [pnpm]
pnpm dlx degit redwoodjs/example-drizzle my-cloudflare-app
cd my-cloudflare-app
pnpm install
```

```sh [yarn]
yarn dlx degit redwoodjs/example-drizzle my-cloudflare-app
cd my-cloudflare-app
yarn install
```

:::

Install `cloudflare` and `alchemy`:

::: code-group

```sh [bun]
bun add alchemy cloudflare
```

```sh [npm]
npm install alchemy cloudflare
```

```sh [pnpm]
pnpm add alchemy cloudflare
```

```sh [yarn]
yarn add alchemy cloudflare
```

:::

## Create `alchemy.run.ts`

```ts
// ./alchemy.run.ts
import "alchemy/cloudflare";
import alchemy from "alchemy";
import { D1Database, Redwood } from "alchemy/cloudflare";

const app = await alchemy("cloudflare-redwood", {
  stage: process.env.USER ?? "dev",
  phase: process.argv.includes("--destroy") ? "destroy" : "up",
  quiet: process.argv.includes("--verbose") ? false : true,
});

// (resources go here)

await app.finalize(); // must be at end
```

> [!NOTE]
> See the [Getting Started](../getting-started) guide if this is unfamiliar.

## Create Redwood and Database

Import the `Redwood` and `D1Database` resources to configure your application:

```ts
const database = await D1Database("redwood-db", {
  name: "redwood-db",
  migrationsDir: "drizzle",
});

export const website = await Redwood("redwood-website", {
  bindings: {
    DB: database,
  },
});
```

Log out the website's URL:
```ts
console.log({
  url: website.url
})
```

## Deploy Redwood Application

Login to Cloudflare:

::: code-group

```sh [bun]
bun wrangler login
```

```sh [npm]
npx wrangler login
```

```sh [pnpm]
pnpm wrangler login
```

```sh [yarn]
yarn wrangler login
```

:::

Run `alchemy.run.ts` script to deploy:

::: code-group

```sh [bun]
bun ./alchemy.run
```

```sh [npm]
npx tsx ./alchemy.run
```

```sh [pnpm]
pnpm tsx ./alchemy.run
```

```sh [yarn]
yarn tsx ./alchemy.run
```

:::

It should log out the URL of your deployed site:
```sh
{
  url: "https://your-site.your-sub-domain.workers.dev",
}
```

Click the endpoint to see your Redwood application!

## Working with Drizzle Schema and Migrations

The Redwood Drizzle template includes a database schema defined using Drizzle ORM. Let's explore and modify the schema.

### Understanding the Existing Schema

The schema files are located in the `api/db` directory. Take a look at the existing schema:

```sh
cat api/db/schema.ts
```

The default schema typically includes a basic user model. Let's modify this schema to add a posts table for a blog.

### Modifying the Schema

Edit the schema file to add a posts table:

```ts
// api/db/schema.ts
import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name"),
  email: text("email").notNull(),
  hashedPassword: text("hashed_password"),
  salt: text("salt"),
  resetToken: text("reset_token"),
  resetTokenExpiresAt: integer("reset_token_expires_at"),
  createdAt: integer("created_at", { mode: "timestamp" }).default(sql`CURRENT_TIMESTAMP`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).default(sql`CURRENT_TIMESTAMP`),
});

// Add a new posts table
export const posts = sqliteTable("posts", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  userId: text("user_id").references(() => users.id),
  createdAt: integer("created_at", { mode: "timestamp" }).default(sql`CURRENT_TIMESTAMP`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).default(sql`CURRENT_TIMESTAMP`),
});
```

### Generating a Migration

After modifying the schema, generate a migration:

::: code-group

```sh [bun]
bun migrate:new
```

```sh [npm]
npm run migrate:new
```

```sh [pnpm]
pnpm migrate:new
```

```sh [yarn]
yarn migrate:new
```

:::

This will create a new migration file in the `drizzle` directory.

### Deploy with Migrations

Now that we've modified the schema and generated migrations, let's redeploy our application with the updated database schema:

::: code-group

```sh [bun]
bun ./alchemy.run
```

```sh [npm]
npx tsx ./alchemy.run
```

```sh [pnpm]
pnpm tsx ./alchemy.run
```

```sh [yarn]
yarn tsx ./alchemy.run
```

:::

The D1Database resource will automatically apply migrations from the directory we specified earlier (`migrationsDir: "drizzle"`).


## Local Development

Redwood has integrated development tooling. Run the development server:

::: code-group

```sh [bun]
bun run dev
```

```sh [npm]
npm run dev
```

```sh [pnpm]
pnpm run dev
```

```sh [yarn]
yarn run dev
```

:::

This will start both the web and API sides of your Redwood application:

```sh
  VITE v6.3.2  ready in 2848 ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: use --host to expose
  ➜  Debug:   http://localhost:5173/__debug
  ➜  press h + enter to show help
^C%
```

## Tear Down

That's it! You can now tear down the app (if you want to):

::: code-group

```sh [bun]
bun ./alchemy.run --destroy
```

```sh [npm]
npx tsx ./alchemy.run --destroy
```

```sh [pnpm]
pnpm tsx ./alchemy.run --destroy
```

```sh [yarn]
yarn tsx ./alchemy.run --destroy
```

:::
