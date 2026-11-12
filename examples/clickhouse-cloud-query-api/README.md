# clickhouse-cloud-query-api

A ClickHouse Cloud service that loads a public CSV of weather stations with a one-shot ClickPipe, serves the hottest stations through a Query API endpoint, and a Cloudflare Worker that calls it:

- `GET /hottest?n=3` runs the endpoint with the Worker's own API key.
- `GET /status` reads the service's state.

```sh
alchemy profile edit --add ClickHouseCloud
bun run deploy
```

The service idles after five minutes without queries. See [ClickHouse Cloud](https://alchemy.run/clickhouse-cloud) for the docs.
