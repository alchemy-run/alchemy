# sqlite-state-store

SQLite state store for [Alchemy](https://github.com/samgoodwin/alchemy) with no runtime dependencies.

## Usage

### D1

Stores state in a Cloudflare D1 database accessed over HTTP. Slower than the other stores that run locally, but recommended for CI/CD.

```ts
import { D1StateStore } from "@alchemy.run/sqlite-state-store/d1";

const app = await alchemy("my-app", {
  stateStore: (scope) => new D1StateStore(scope),
});
```

You can customize the database name by passing a `databaseName` option to the constructor. The default is `alchemy-state`.

```ts
const app = await alchemy("my-app", {
  stateStore: (scope) =>
    new D1StateStore(scope, { databaseName: "my-database" }),
});
```

You can also customize how the Cloudflare API is accessed:

```ts
const app = await alchemy("my-app", {
  stateStore: (scope) =>
    new D1StateStore(scope, {
      accountId: "my-account-id",
      apiToken: "my-api-token",
    }),
});
```

### Bun

Stores state in a Bun SQLite database. Only supported on Bun (obviously).

```ts
const app = await alchemy("my-app", {
  stateStore: (scope) => new BunSQLiteStateStore(scope),
});
```

You can customize the filename by passing a `filename` option to the constructor, or by setting the `ALCHEMY_STATE_FILE` environment variable. The default is `.alchemy/state.sqlite`.

```ts
const app = await alchemy("my-app", {
  stateStore: (scope) =>
    new BunSQLiteStateStore(scope, { filename: "my-database.sqlite" }),
});
```

### Better SQLite3

Stores state in a Better SQLite3 database. Only supported on Node.js. Requires `better-sqlite3` as a peer dependency.

```ts
import { BetterSQLite3StateStore } from "@alchemy.run/sqlite-state-store/better-sqlite3";

const app = await alchemy("my-app", {
  stateStore: (scope) => new BetterSQLite3StateStore(scope),
});
```

You can customize the filename by passing a `filename` option to the constructor, or by setting the `ALCHEMY_STATE_FILE` environment variable. The default is `.alchemy/state.sqlite`.

```ts
const app = await alchemy("my-app", {
  stateStore: (scope) =>
    new BetterSQLite3StateStore(scope, { filename: "my-database.sqlite" }),
});
```

### LibSQL

Stores state in a LibSQL database. Supports both Bun and Node.js. Requires `@libsql/client` as a peer dependency.

```ts
import { LibSQLStateStore } from "@alchemy.run/sqlite-state-store/libsql";

const app = await alchemy("my-app", {
  stateStore: (scope) => new LibSQLStateStore(scope),
});
```

You can provide any LibSQL-compatible options to the constructor. See the [LibSQL documentation](https://github.com/libsql/libsql-client-ts) for the available options.

For example, you can change the file name from the default `.alchemy/state.sqlite` by passing a `url` option to the constructor:

```ts
const app = await alchemy("my-app", {
  stateStore: (scope) =>
    new LibSQLStateStore(scope, {
      url: "file:my-database.sqlite",
    }),
});
```

Alternatively, you can use a remote database:

```ts
const app = await alchemy("my-app", {
  stateStore: (scope) =>
    new LibSQLStateStore(scope, {
      url: "https://my-remote-database.com",
      authToken: "my-auth-token",
    }),
});
```

## Supported Stores

| Store            | Bun Support | Node Support | Peer Dependencies |
| ---------------- | :---------: | :----------: | ----------------- |
| `bun`            |     ✅      |      ❌      | None              |
| `d1`             |     ✅      |      ✅      | None              |
| `better-sqlite3` |     ❌      |      ✅      | `better-sqlite3`  |
| `libsql`         |     ✅      |      ✅      | `@libsql/client`  |
