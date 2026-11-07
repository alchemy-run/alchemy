# Boat program example

An Effect HTTP program served from a long-lived Boat sandbox.

- [`src/Api.ts`](./src/Api.ts) — `Boat.Sandbox` in its class form: Alchemy bundles the program, uploads it and runs it with Node, at a public URL. It counts visits in a file on the sandbox's disk.

## Commands

```sh
pnpm alchemy profile edit --add Boat   # once: sign Alchemy in to Boat
pnpm --filter boat-program deploy
pnpm --filter boat-program test
pnpm --filter boat-program destroy
```
