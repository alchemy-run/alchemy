# Alchemy examples

Each example is its own application. Read its README, provider setup, and test
configuration before deploying: examples can create billable infrastructure.
Use the [SQL documentation](https://alchemy.run/sql) to choose a client or
[find an integration by provider](https://alchemy.run/sql#find-your-provider).

## SQL integrations

| Runtime | Database | Client | Runnable project |
| --- | --- | --- | --- |
| AWS Lambda | Aurora PostgreSQL | Drizzle | [aws-aurora-drizzle](./aws-aurora-drizzle) |
| AWS Lambda | Aurora PostgreSQL | `pg` | [aws-rds](./aws-rds) |
| Cloudflare Workers | Neon Postgres through Hyperdrive | Drizzle | [cloudflare-neon-drizzle](./cloudflare-neon-drizzle) |
| Cloudflare Workers | PlanetScale Postgres through Hyperdrive | Drizzle | [cloudflare-planetscale-postgres-drizzle](./cloudflare-planetscale-postgres-drizzle) |
| Cloudflare Workers | Neon Postgres through Hyperdrive | Prisma ORM, TypeScript-first | [cloudflare-neon-prisma](./cloudflare-neon-prisma) |
| Cloudflare Workers | Neon Postgres through Hyperdrive | Prisma ORM, PSL-first | [cloudflare-neon-prisma-psl](./cloudflare-neon-prisma-psl) |
| Fly Service | Fly Managed Postgres | Drizzle | [fly-postgres](./fly-postgres) |
| Hetzner Service | Neon Postgres | Drizzle | [hetzner-website-vite](./hetzner-website-vite) |
| Railway Service | Railway Postgres | Drizzle | [railway-service](./railway-service) |

### Looking for Drizzle + Aurora?

Start with [aws-aurora-drizzle](./aws-aurora-drizzle): a standalone Lambda
application with private Aurora PostgreSQL, IAM authentication, verified TLS,
and deployment-time schema setup. Its [integration guide](https://alchemy.run/aws/data/drizzle-aurora)
explains the connection and migration placement. The separate `aws-rds`
application uses **plain `pg`**, not Drizzle.

The [AWS full-stack Drizzle guide](https://alchemy.run/aws/frontend/full-stack-tanstack-rpc-drizzle)
uses **Aurora DSQL**, a different database and deployment from Aurora
PostgreSQL. See [SQL on AWS](https://alchemy.run/sql/providers/aws) for the
connection choices and guide/example availability.

## Guides and lifecycle

- [Choose a database](https://alchemy.run/sql/databases).
- [Drizzle](https://alchemy.run/sql/drizzle/postgres) and [Prisma contracts](https://alchemy.run/sql/prisma/contracts).
- [Connection lifecycle](https://alchemy.run/sql/effect-sql/lifecycle).
- [AWS](https://alchemy.run/aws/setup), [Cloudflare](https://alchemy.run/cloudflare/setup), [Fly](https://alchemy.run/fly/setup), [Hetzner](https://alchemy.run/hetzner/setup), and [Railway](https://alchemy.run/railway/setup) credentials.

A guide, a runnable application, and an internal test fixture serve different
purposes. Check the selected project's supported runtime/database combination,
migration path, and cleanup instructions rather than assuming all SQL clients
support every database with a similar connection string.
