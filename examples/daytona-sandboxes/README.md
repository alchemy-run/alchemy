# daytona-sandboxes

A Cloudflare Worker that runs code in [Daytona](https://daytona.io) sandboxes:

- `POST /run` runs a command in a fresh sandbox and deletes it.
- `PUT /users/:user/sandbox` starts the user's own sandbox, with their volume mounted as home.
- `DELETE /users/:user/sandbox` deletes the sandbox; the volume keeps the files.

```sh
alchemy profile edit --add Daytona
bun run deploy
```

See [Daytona](https://alchemy.run/daytona) for the docs.
