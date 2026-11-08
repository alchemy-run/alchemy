# Archil Sandbox

Seed a disk at deploy time, and run commands against it while the app runs.

- `src/Storage.ts`: a `Repo` disk with repositories cloned onto it by an `Archil.Checkpoint` at deploy.
- `src/Api.ts`: a program in its own `Archil.Sandbox`. `POST /run` runs a command in a fresh microVM with `Repo` mounted read-only. `/users/:user/...` gives each user a disk of their own, copied from the base on their first request.

```sh
alchemy profile edit --profile default --add Archil
bun run deploy
curl -X POST --data "ls" "$URL/run"
bun run destroy
```
