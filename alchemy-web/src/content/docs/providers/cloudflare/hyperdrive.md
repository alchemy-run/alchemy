---
title: Hyperdrive
description: Learn how to configure and use Cloudflare Hyperdrive using Alchemy to accelerate access to your existing databases.
---

[Cloudflare Hyperdrive](https://developers.cloudflare.com/hyperdrive/) provides serverless connection pooling and caching for PostgreSQL databases.

## Minimal Example

Create a basic Hyperdrive connection to a PostgreSQL database.

```ts
import { Hyperdrive } from "alchemy/cloudflare";

const db = await Hyperdrive("my-postgres-db", {
  name: "my-postgres-db",
  origin: "postgresql://user:password@ep-example-host-1234.us-east-1.aws.neon.tech/mydb?sslmode=require",
});
```

:::tip
Your origin can be a string, secret, or an object containing connection parameters.
:::

## With Local Origin

If you want to use a local database for development, you can set the `dev.origin` property.

This will be used by Miniflare to connect to the local database.

```ts
const db = await Hyperdrive("my-postgres-db", {
  name: "my-postgres-db",
  origin: "postgresql://user:password@ep-example-host-1234.us-east-1.aws.neon.tech/mydb?sslmode=require",
  dev: {
    origin: "postgres://user:password@localhost:5432/postgres",
  },
});
```

## With Explicit Origin Object

If you'd prefer to set parameters explicitly, you can use an object.

```ts
const db = await Hyperdrive("my-postgres-db", {
  name: "my-postgres-db",
  origin: {
    database: "postgres",
    host: "database.example.com",
    password: "password",
    port: 5432,
    user: "postgres",
  },
});
```

:::tip
Your password can be a string or a secret. If you provide a string, Alchemy will convert it to a secret for you.
:::

## With Caching Disabled

Create a Hyperdrive connection with caching disabled.

```ts
const noCacheDb = await Hyperdrive("no-cache-db", {
  name: "no-cache-db",
  origin: {
    database: "postgres",
    host: "database.example.com",
    password: alchemy.secret.env.DB_PASSWORD,
    port: 5432,
    user: "postgres",
  },
  caching: {
    disabled: true,
  },
});
```

## With mTLS Configuration

Create a Hyperdrive connection with mTLS security.

```ts
const secureDb = await Hyperdrive("secure-db", {
  name: "secure-db",
  origin: {
    database: "postgres",
    host: "database.example.com",
    password: alchemy.secret.env.DB_PASSWORD,
    port: 5432,
    user: "postgres",
  },
  mtls: {
    ca_certificate_id: "00000000-0000-0000-0000-0000000000",
    mtls_certificate_id: "00000000-0000-0000-0000-0000000000",
    sslmode: "verify-full",
  },
});
```

## With Access Client Credentials

Create a Hyperdrive connection using access client credentials.

```ts
const accessDb = await Hyperdrive("access-db", {
  name: "access-db",
  origin: {
    database: "postgres",
    host: "database.example.com",
    access_client_id: "client-id",
    access_client_secret: alchemy.secret.env.ACCESS_CLIENT_SECRET,
    port: 5432,
    user: "postgres",
  },
});
```

## Bind to a Worker

Use Hyperdrive with a Cloudflare Worker.

```ts
import { Worker, Hyperdrive } from "alchemy/cloudflare";

const db = await Hyperdrive("my-db", {
  name: "my-db",
  origin: {
    database: "postgres",
    host: "database.example.com",
    password: alchemy.secret("password"),
    user: "postgres",
  },
});

await Worker("my-worker", {
  name: "my-worker",
  script: "console.log('Hello, world!')",
  bindings: {
    DB: db,
  },
});
```
