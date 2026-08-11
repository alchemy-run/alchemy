# CLI startup benchmark

Run from the workspace root:

```sh
bun --filter alchemy benchmark:startup
```

The benchmark measures fresh Bun processes, isolated imports, CLI help, a
minimal plan, and `dev` up to its first `Plan:` line. The `dev` process and its
watched exec child run in a dedicated process group and are terminated after
the marker is observed; bundling and workerd startup are intentionally outside
this startup measurement.

Defaults are two warmups and 15 measured iterations. Override them or select a
single case when profiling:

```sh
ITERATIONS=30 WARMUPS=3 CASE="dev time" bun --filter alchemy benchmark:startup
```

The empty stack isolates CLI, Effect layer, state, and watcher overhead. The
Cloudflare Worker example import is measured separately to represent a real
consumer module graph without provisioning cloud resources.
