# clickhouse-cloud-usage

A Cloudflare Worker that reports a ClickHouse Cloud organization's spend:

- `GET /usage?days=7`: what each service and ClickPipe cost, per day, in ClickHouse Credits.
- `GET /credits`: the credits left.
- `GET /notifications`: the organization's notifications of the last week.

It creates no ClickHouse service, only the Worker's view-only API keys and roles.

```sh
alchemy profile edit --add ClickHouseCloud
bun run deploy
```

See [ClickHouse Cloud](https://alchemy.run/clickhouse-cloud) for the docs.
