# Effect Cluster chat rooms

The finished code of the [Effect Cluster tutorial](https://alchemy.run/cluster/tutorial/part-1): chat rooms as Effect Cluster entities, on a Postgres database and two runners on your local Docker swarm.

Each room tracks its members, lets only signed-in users join through RPC middleware, and admits invited guests through a durable workflow that waits for their answer.

## Run it

```sh
docker swarm init   # once
bun install
bun run --filter effect-cluster-rooms-example deploy
```

```sh
curl -H "x-member: sam" localhost:8080/lobby
curl "localhost:8080/invite?room=lobby&guest=ada"
curl "localhost:8080/answer?executionId=<id>&accept=true"
```

```sh
bun run --filter effect-cluster-rooms-example destroy
```
