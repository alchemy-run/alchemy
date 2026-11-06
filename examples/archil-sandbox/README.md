# Archil Sandbox

Two programs, each in its own `Archil.Sandbox`:

- `src/Api.ts`: an Effect program that stores files on an `Archil.Disk`
  through `Archil.ReadWriteDisk` (`PUT /:key`, `GET /:key`).
- `src/hello.ts`: an async program, a plain `fetch(request, env)` handler
  typed with `Archil.InferEnv`.

```sh
alchemy profile edit --profile default --add Archil
bun run deploy
curl -X PUT --data "hi" "$URL/hello.txt"
curl "$URL/hello.txt"
bun run destroy
```
