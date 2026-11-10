# Archil Sandbox

Set up a sandbox at deploy time, and fork it while the app runs.

- `src/Golden.ts`: an `Archil.Sandbox` whose `run` commands clone repositories onto its disk at deploy.
- `src/Api.ts`: a program in its own `Archil.Sandbox`, bound to `Archil.CreateSandbox(Golden)`. `POST /run` runs a command in a fresh fork, deleted when the request ends. `/users/:user/...` gives each user a fork of their own.

```sh
alchemy profile edit --profile default --add Archil
bun run deploy
curl -X POST --data "ls" "$URL/run"
bun run destroy
```
