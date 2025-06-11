---
order: 20
title: PlanetScale
description: Get started with PlanetScale serverless MySQL databases using Alchemy's Infrastructure-as-Code approach for database and branch management.
---

# Getting Started with PlanetScale

This guide will walk you through setting up a PlanetScale serverless MySQL database with branching workflow using Alchemy.

## Install

First, install Alchemy and the necessary dependencies:

::: code-group

```sh [bun]
bun add -D alchemy
```

```sh [npm]
npm install --save-dev alchemy
```

```sh [pnpm]
pnpm add -D alchemy
```

```sh [yarn]
yarn add --dev alchemy
```

:::

## Credentials

To use PlanetScale with Alchemy, you'll need:

1. **PlanetScale API Token**: Create a service token in your [PlanetScale organization settings](https://app.planetscale.com/organization/settings/service-tokens)
2. **Organization Name**: Your PlanetScale organization name (not UUID), found in your organization URL

Add these to your `.env` file:

```sh
PLANETSCALE_API_TOKEN=your_service_token_here
PLANETSCALE_ORG_ID=your_organization_id
```

::: warning [!CAUTION]
When creating your service token in PlanetScale, make sure to copy the token in the format `id:secret` (both parts separated by a colon). This is the complete token value that should be used for `PLANETSCALE_API_TOKEN`.
:::

## Create a new project

If you don't have a project yet, create one:

::: code-group

```sh [bun]
mkdir my-planetscale-app
cd my-planetscale-app
bun init
```

```sh [npm]
mkdir my-planetscale-app
cd my-planetscale-app
npm init -y
```

```sh [pnpm]
mkdir my-planetscale-app
cd my-planetscale-app
pnpm init
```

```sh [yarn]
mkdir my-planetscale-app
cd my-planetscale-app
yarn init -y
```

:::

## Create `alchemy.run.ts`

Create an Alchemy script to provision your PlanetScale database and branches:

```ts
import { Database, Branch } from "alchemy/planetscale";

// Create the main database
const database = await Database("my-app-db", {
  name: "my-app-db",
  organizationId: process.env.PLANETSCALE_ORG_ID!,
  region: {
    slug: "us-east"
  },
  clusterSize: "PS_10",
  allowDataBranching: true,
  automaticMigrations: true,
  requireApprovalForDeploy: false
});

console.log(`✅ Database created: ${database.name}`);
console.log(`🌐 Database URL: ${database.htmlUrl}`);

// Create a development branch
const devBranch = await Branch("development", {
  name: "development",
  organizationId: process.env.PLANETSCALE_ORG_ID!,
  databaseName: database.name,
  parentBranch: "main",
  isProduction: false,
  safeMigrations: true
});

console.log(`🌿 Development branch created: ${devBranch.name}`);
console.log(`🔗 Branch URL: ${devBranch.htmlUrl}`);

// Create a staging branch
const stagingBranch = await Branch("staging", {
  name: "staging",
  organizationId: process.env.PLANETSCALE_ORG_ID!,
  databaseName: database.name,
  parentBranch: "main",
  isProduction: true,
  clusterSize: "PS_10"
});

console.log(`🎭 Staging branch created: ${stagingBranch.name}`);
console.log(`🔗 Branch URL: ${stagingBranch.htmlUrl}`);

export { database, devBranch, stagingBranch };
```

For a more advanced setup with a Cloudflare Worker connection, you can also add:

```ts
import { Database, Branch } from "alchemy/planetscale";
import { Worker, Hyperdrive } from "alchemy/cloudflare";

// Create PlanetScale database
const database = await Database("my-app-db", {
  name: "my-app-db", 
  organizationId: process.env.PLANETSCALE_ORG_ID!,
  clusterSize: "PS_10",
  allowDataBranching: true
});

// Create a production branch
const prodBranch = await Branch("production", {
  name: "production",
  organizationId: process.env.PLANETSCALE_ORG_ID!,
  databaseName: database.name,
  parentBranch: "main",
  isProduction: true,
  clusterSize: "PS_20"
});

// Connect to Cloudflare with Hyperdrive for connection pooling
const hyperdrive = await Hyperdrive("planetscale-hyperdrive", {
  name: "planetscale-connection",
  origin: {
    scheme: "mysql",
    database: database.name,
    host: `${database.name}.us-east.psdb.cloud`,
    port: 3306,
    user: process.env.PLANETSCALE_DB_USERNAME!,
    password: alchemy.secret(process.env.PLANETSCALE_DB_PASSWORD!)
  },
  caching: {
    disabled: false
  }
});

// Create a Cloudflare Worker that uses the database
const worker = await Worker("planetscale-api", {
  name: "planetscale-api",
  entrypoint: "./src/worker.ts",
  bindings: {
    DATABASE: hyperdrive
  },
  url: true
});

console.log(`🚀 Worker deployed: ${worker.url}`);
```

## Deploy

Run the Alchemy script to deploy your PlanetScale infrastructure:

::: code-group

```sh [bun]
bun ./alchemy.run.ts
```

```sh [npm]
npx tsx ./alchemy.run.ts
```

```sh [pnpm]
pnpm tsx ./alchemy.run.ts
```

```sh [yarn]
yarn tsx ./alchemy.run.ts
```

:::

The script will create your database and branches. You should see output like:

```sh
✅ Database created: my-app-db
🌐 Database URL: https://app.planetscale.com/my-org/my-app-db
🌿 Development branch created: development
🔗 Branch URL: https://app.planetscale.com/my-org/my-app-db/development
🎭 Staging branch created: staging
🔗 Branch URL: https://app.planetscale.com/my-org/my-app-db/staging
```

You can now:
- Access your database in the [PlanetScale console](https://app.planetscale.com)
- Create connection strings for your branches
- Start developing schema changes in your development branch

## Tear Down

That's it! You can now tear down the infrastructure (if you want to):

::: code-group

```sh [bun]
bun ./alchemy.run.ts --destroy
```

```sh [npm]
npx tsx ./alchemy.run.ts --destroy
```

```sh [pnpm]
pnpm tsx ./alchemy.run.ts --destroy
```

```sh [yarn]
yarn tsx ./alchemy.run.ts --destroy
```

:::

This will delete all created databases and branches from your PlanetScale organization.