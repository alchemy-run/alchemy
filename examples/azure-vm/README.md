# Effect program on an Azure virtual machine

A job API and a background worker written as one Effect program and run on
an Azure virtual machine. Alchemy bundles the program for Node.js 22, stages
it in a storage account it creates, and installs it on the VM as a systemd
unit with a managed run command (no SSH, no image build). The program runs as
the VM's system-assigned managed identity.

```sh
curl -X POST "$URL/jobs" --data "hello"
# 202 {"id":"6f1c…"}
curl "$URL/jobs/6f1c…"
# 200 HELLO
```

## Architecture

- [`Network`](./src/Network.ts) — a virtual network and subnet, a Standard
  static public IP, and a network security group that allows inbound TCP on
  port 3000.
- [`AdminKey`](./src/resources.ts) — an SSH key pair that Azure generates
  for the admin user. The private key stays in the stack's state as the
  secret `privateKey` attribute.
- [`Jobs`](./src/resources.ts) and [`Results`](./src/resources.ts) — an
  `Azure.Storage.Queue` and an `Azure.Storage.BlobContainer` in one Storage
  account.
- [`Server`](./src/Server.ts) — `Azure.Compute.VirtualMachine` in its Effect
  form: `main: import.meta.url`, an init Effect that binds the queue and the
  container, a `ServerHost` loop that drains the queue every 2 seconds, and a
  `fetch` handler.

Each binding grants the VM's identity one role on one resource:

| Binding                                         | Role                                 | Scope     |
| ----------------------------------------------- | ------------------------------------ | --------- |
| `Azure.Storage.QueueSend(jobs)`                 | Storage Queue Data Message Sender    | `Jobs`    |
| `Azure.Storage.QueueReceive(jobs)`              | Storage Queue Data Message Processor | `Jobs`    |
| `Azure.Storage.BlobContainerReadWrite(results)` | Storage Blob Data Contributor        | `Results` |

| Route           | What it does                                     |
| --------------- | ------------------------------------------------ |
| `GET /`         | answers `ok`                                     |
| `POST /jobs`    | enqueues the body as a job, answers `202 { id }` |
| `GET /jobs/:id` | returns the result, or `404 pending`             |

Every resource runs in `eastus`, in the stack's resource group
(`<stack>-<stage>`).

## Cost and time

Under $0.05 per test run, so the test is not gated: one 1-vCPU
`Standard_F1als_v7` VM (about $0.04 per hour), a Standard public IP (about
$0.005 per hour), and two Standard LRS storage accounts (the example's and
the release store). A deploy takes 5-10 minutes: Azure creates the VM, then
the release command installs Node.js 22 and starts the unit. A full test run
takes about 20 minutes.

The VM size needs vCPU quota in your subscription. If `Standard_F1als_v7`
has none, change `VM_SIZE` in [`src/resources.ts`](./src/resources.ts) to a
Linux size that has.

## Deploy

Set up an Azure service principal and profile first — see
[Azure setup](https://alchemy.run/azure/setup). From the repository root:

```sh
pnpm install
cd examples/azure-vm
pnpm deploy --profile <name>
```

The stack outputs the program's URL (`http://<public IP>:3000`).

## Live test

```sh
ALCHEMY_PROFILE=<name> bun test test/integ.test.ts
```

The test deploys the stack and calls the API over HTTP: it posts a job and
waits for the worker's result. Out of band it checks that the release run
command succeeded and that the VM's system-assigned identity holds exactly
the three role assignments in the table above. It then destroys the stack,
waits for the VM to be gone, and checks that the role assignments were
revoked.

## Destroy

```sh
pnpm destroy --profile <name>
```
