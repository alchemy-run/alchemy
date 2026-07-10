# Prisma Compute Effect

Minimal Effect-native Prisma Compute app managed by Alchemy.

This example is intentionally not a framework app. It shows the provider-native
runtime path:

- `Prisma.Project`
- `Prisma.Branch`
- `Prisma.Postgres`
- `Prisma.Connection`
- `Prisma.Compute(..., Effect.gen(...))`
- `Prisma.ConnectionBinding(Connection)` inside the deployed runtime

`alchemy.run.ts` only wires the stack together. The Prisma data resources live
in `src/Database.ts`, and the Effect-native Compute app lives in
`src/Api.ts`.

The deployed app responds on `/` and `/api/health` with JSON showing the
bound database and connection IDs.

## Deploy

```sh
export PRISMA_SERVICE_TOKEN="..."
bun run deploy
```

`PRISMA_API_TOKEN` also works.

## Check It

```sh
curl "$URL/"
curl "$URL/api/health"
```

The response should include:

```json
{
  "ok": true,
  "mode": "effect-native",
  "hasDatabaseUrl": true
}
```

## Destroy

```sh
export PRISMA_SERVICE_TOKEN="..."
bun run destroy
```
