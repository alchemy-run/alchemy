# modal-functions

Modal Functions and a Server in one App, written in TypeScript:

- `Embed` is a function other runtimes call: its `embed` method is an RPC method (`Modal.InvokeFunction`).
- `Api` is a web function at a `*.modal.run` URL that calls `Embed`.
- `Status` is a public `Modal.Server` reporting `Embed`'s load (`Modal.ReadFunction`).

```sh
pnpm deploy    # prints the `api` and `status` URLs
curl "<api URL>?text=hello%20modal"
pnpm destroy
```

Docs: https://alchemy.run/modal/services/functions
