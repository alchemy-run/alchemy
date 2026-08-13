# Cloudflare Website: TanStack Start

Deploys a [TanStack Start](https://tanstack.com/start) app to Cloudflare
Workers with `Cloudflare.Website.Vite` — one Worker serves the frontend
AND a typed backend, bridged by `createClient`.

- `src/backend.ts` declares the Website class with an Effect program as
  its third argument. Its RPC METHODS are the API surface (`get`, `save`
  — backed by an R2 bucket through a typed capability binding, collected
  automatically at plan time). No routes, no URL parsing.
- `src/lib/backend.ts` builds ONE shared backend client — the same file
  layout as the oRPC adapter — picked per world by `createIsomorphicFn`:

  ```ts
  const getBackend = createIsomorphicFn()
    // SSR: VALUE form — direct in-process dispatch, no HTTP; headers
    // resolve per call from TanStack's ambient accessor.
    .server(() =>
      createClient(Backend, {
        headers: () => Object.fromEntries(getRequestHeaders().entries()),
      }),
    )
    // Browser: TYPE-ONLY form — POST /api/__rpc/<method>, zero backend
    // bytes in the client bundle.
    .client(() => createClient<typeof Backend>());

  export const backend = getBackend();
  ```

- `src/routes/index.tsx` uses that one client in both worlds: the route
  `loader` calls `backend.get()` (in-process during SSR, over the wire on
  client-side navigation), and the Save button calls `backend.save(...)`
  from the browser.

## Deploy

```sh
bun run deploy
```

## Dev

```sh
bun run dev
```

## Destroy

```sh
bun run destroy
```
