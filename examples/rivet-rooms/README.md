# Rivet chat rooms

The finished code of the [Rivet tutorial](https://alchemy.run/rivet/tutorial/part-1): chat rooms as Rivet Durable Objects, on a control plane and a pool of nodes on your local Docker swarm.

Each room counts its visitors in key-value storage, keeps its messages in SQL, and clears them with an alarm an hour after the last one.

## Run it

```sh
docker swarm init   # once
bun install
bun run --filter rivet-rooms-example deploy
```

```sh
curl -X POST localhost:3000/lobby/join
curl -X POST localhost:3000/lobby/messages \
  -H 'content-type: application/json' \
  -d '{"author":"sam","text":"hello"}'
curl localhost:3000/lobby/messages
```

```sh
bun run --filter rivet-rooms-example destroy
```
