# Azure Function with a blob binding

An Effect-native Azure Function (Flex Consumption, Node.js 22) that stores
and serves files in a Blob Storage container. The Function reaches the
container with its managed identity: no keys or connection strings.

```sh
curl -X PUT "$URL/files/notes/hello.txt" -H "content-type: text/plain" -d "hi"
# 201 {"key":"notes/hello.txt","etag":"\"0x8DC…\""}
curl "$URL/files/notes/hello.txt"
# 200 hi
curl "$URL/files?prefix=notes/"
# 200 {"files":[{"key":"notes/hello.txt","size":2,"contentType":"text/plain"}]}
curl -X DELETE "$URL/files/notes/hello.txt"
# 204
```

## Architecture

- [`Files`](./src/Files.ts) — a storage account and a blob container.
- [`Api`](./src/Api.ts) — `Azure.Functions.Function` in the Effect form.
  `Azure.Storage.BlobContainerReadWrite(container)` grants the app's
  system-assigned identity **Storage Blob Data Contributor** on the
  container and returns a typed client (`put`, `get`, `list`, `delete`).
  `Azure.Storage.BlobContainerReadWriteHttp` implements it over the Blob
  REST API.
- [`alchemy.run.ts`](./alchemy.run.ts) — the stack. Every resource lands
  in the stack's resource group (`<stack>-<stage>`).

| Route                  | What it does                       |
| ---------------------- | ---------------------------------- |
| `GET /files?prefix=p`  | list the files (one page)          |
| `PUT /files/:key`      | store the request body             |
| `GET /files/:key`      | read a file, `404` if it is absent |
| `DELETE /files/:key`   | delete a file                      |

A failed Azure call answers `502` with the error tag, for example while
the role assignment propagates after the first deploy (up to a few
minutes).

## Cost

Flex Consumption bills per execution and scales to zero. The two
Standard_LRS storage accounts (the files account and the Functions host
account) cost cents per month when idle. One test run costs about a cent.

## Deploy

Set up an Azure service principal and profile first — see
[Azure setup](https://alchemy.run/azure/setup). From the repository root:

```sh
pnpm install
cd examples/azure-function
pnpm deploy --profile <name>
```

The stack outputs the Function's URL.

## Live test

```sh
ALCHEMY_PROFILE=<name> bun test test/integ.test.ts
```

The test deploys the stack and checks the app's managed identity and its
role on the container. It stores a file through the API and reads it back
through the API and out of band (with an account SAS). It reads a blob
uploaded out of band, deletes it through the API, and checks it is gone.
Then it destroys the stack and checks the function app and both storage
accounts are gone.

## Destroy

```sh
pnpm destroy --profile <name>
```
