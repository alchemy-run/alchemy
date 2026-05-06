<div align="center">

<a href="https://v2.alchemy.run">
  <img src="./images/readme-hero.png" alt="Alchemy — Infrastructure as Effects" width="360" />
</a>

<br />

[![npm](https://img.shields.io/npm/v/alchemy?style=flat-square&color=3f5a2a&label=alchemy)](https://www.npmjs.com/package/alchemy)
[![license](https://img.shields.io/badge/license-Apache%202.0-3f5a2a?style=flat-square)](./LICENSE)
[![discord](https://img.shields.io/badge/discord-join-3f5a2a?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/jwKw8dBJdN)

**Infrastructure-as-Effects** — cloud infrastructure and application logic as a single, type-safe [Effect](https://effect.website) program.

[Docs](https://v2.alchemy.run) · [Tutorial](https://v2.alchemy.run/tutorial/part-1) · [Examples](./examples) · [Discord](https://discord.gg/jwKw8dBJdN)

</div>

---

A Cloudflare Worker, fronted by Hyperdrive, querying Neon Postgres with Drizzle — provisioned, bound, and queried in one program:

```typescript
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Neon from "alchemy/Neon";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { Users } from "./schema.ts";

export default Alchemy.Stack("App", {
  providers: Layer.mergeAll(
    Cloudflare.providers(),
    Neon.providers(),
    Drizzle.providers(),
  ),
}, Effect.gen(function* () {
  const project = yield* Neon.Project("db", { region: "aws-us-east-1" });
  const branch  = yield* Neon.Branch("main", { project });
  const pool    = yield* Cloudflare.Hyperdrive("pool", { origin: branch.origin });

  return yield* Cloudflare.Worker("api", { main: import.meta.path },
    Effect.gen(function* () {
      const conn = yield* Cloudflare.Hyperdrive.bind(pool);
      const db   = yield* Drizzle.postgres(conn.connectionString);
      return {
        fetch: Effect.gen(function* () {
          const users = yield* db.select().from(Users);
          return yield* HttpServerResponse.json(users);
        }),
      };
    }).pipe(Effect.provide(Cloudflare.HyperdriveConnectionLive)),
  );
}));
```

`Cloudflare.Hyperdrive.bind(pool)` is the whole magic: it creates the Worker binding, wires the env var, and hands you a typed connection — at deploy time and at runtime.

---

- **One program, one language.** Resources, Lambdas/Workers, IAM, and SDKs live in the same Effect program — no YAML, no second runtime.
- **Bindings, not glue code.** `S3.GetObject.bind(bucket)` wires the IAM policy, env var, and a typed SDK call in a single line.
- **Errors in the type system.** Every cloud API failure is a tagged Effect error you handle — or don't — on purpose.
- **AWS + Cloudflare today.** S3, SQS, DynamoDB, Kinesis, Lambda, EC2 / Workers, R2, D1, Durable Objects, Containers.
- **Same code, every stage.** Local dev, `plan` / `deploy`, smoke tests, and CI all share one mental model.

```sh
bun add alchemy effect
```

## Bootstrap with an AI coding agent

Paste this into Claude Code, Cursor, or any agent that can fetch a URL:

```
You are an Alchemy expert. Read https://v2.alchemy.run/llms.txt to load the
full documentation index, then act as my pair on this project.

Goal: help me set up, build, test, and deploy a cloud application with
`alchemy` (Infrastructure-as-Effects, powered by Effect).

Follow the patterns from the docs and the /examples folder. Stay idiomatic
to Effect: use Layers for wiring, return Effects from lifecycle code, and
keep infra and runtime in the same program. Ask before introducing new
dependencies or breaking conventions.
```

## Learn more

- [What is Alchemy?](https://v2.alchemy.run/what-is-alchemy) — the framework in 2 minutes
- [Getting Started](https://v2.alchemy.run/getting-started) — your first Stack
- [Tutorial](https://v2.alchemy.run/tutorial/part-1) — five-part walkthrough to a tested, CI-deployed app
- [Examples](./examples) — runnable projects on AWS and Cloudflare
- [llms.txt](https://v2.alchemy.run/llms.txt) — agent-ready documentation index

> **alchemy** is in alpha. Expect breaking changes. Come hang in our [Discord](https://discord.gg/jwKw8dBJdN).

## License

Apache-2.0
