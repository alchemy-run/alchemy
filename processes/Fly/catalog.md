# Fly.io Alchemy catalog (LOCKED)

This file is the locked DX for the Fly.io provider. Implementers read it
before writing code. Do not invent alternatives. Do not implement from this
file's research notes as a redesign — implement what is written here.

Assessed 2026-08-18:

- `packages/alchemy/src/Fly` does not exist. No partial resource work.
- `distilled/packages/fly-io` exists (`@distilled.cloud/fly-io`). Single
  generated service: `src/services/machines.ts`.
- Distilled patches today are **flat** status-map files only:
  - `distilled/packages/fly-io/patches/bad-request-errors.patch.json`
  - `distilled/packages/fly-io/patches/forbidden-errors.patch.json`
  - `distilled/packages/fly-io/patches/not-found-errors.patch.json`
- `convert.ts` currently applies **either** `patches/machines/*.patch.json`
  **or** (if that dir is absent) flat `patches/*.patch.json`. It must be
  upgraded to apply **both** before per-op patches land. Existing flat files
  must keep working.
- Reference DX: Hetzner (`Server` / `Service` / `Volume` / `MountVolume`),
  Docker `Service` (bundle `main` + image), `Platform.ts`,
  `examples/hetzner-app`.

This catalog covers **100% of the Machines API that is IaC**. Everything else
in `machines.ts` is documented as a helper or out of scope.

---

## Locked platform decisions

| Decision | Locked value |
| --- | --- |
| Namespace | `Fly` |
| Source tree | `packages/alchemy/src/Fly/<Name>.ts` (**flat**). Callers write `Fly.App`, never `Fly.Machines.App`. |
| Distilled package | `@distilled.cloud/fly-io` |
| Distilled service | `machines` (`@distilled.cloud/fly-io/machines`) |
| Auth | `FLY_API_TOKEN` only + optional `FLY_API_HOSTNAME` |
| Distilled credentials | `{ apiKey, apiBaseUrl }` |
| Default API | `https://api.machines.dev/v1` |
| Default test region | `iad` |
| Cheapest guest | `shared-cpu-1x` / 256 MB — `{ cpu_kind: "shared", cpus: 1, memory_mb: 256 }` |
| Raw Machine test image | public `nginx:alpine` |
| App name | `createPhysicalName({ lowercase: true, maxLength: 30 })`, then force a leading letter (`f` prefix if needed). Globally unique. |
| Resource refs | local unexported `type Ref<T> = T \| Effect.Effect<T, never, Providers>`. **Do not export `Ref`** (collides with `alchemy/src/Ref.ts`). |
| Props | never `Input<T>`. never `Output<App>` (or Output of any resource). Primitive attrs stay `Input<string>` via the engine wrap. |
| Reconciler | one observe-ensure-sync flow. Do **not** branch on `output === undefined`. |
| Ownership | Fly App has **no labels**. Stamp `alchemy.stack` / `alchemy.stage` / `alchemy.id` onto Machine `config.metadata` and onto Volume/Secret/SecretKey **names**. |
| `list()` | required on every resource for nuke. Never list the whole org unfiltered. |
| Volume attach | **only** via `MountVolume` mounts on Machine/Service. **No** `VolumeAttachment` resource. |
| Service vs Hetzner | N `Fly.Service`s per `Fly.App` (each Service is a Machine). Not systemd-on-a-box. |
| Tests | `test.provider`, start **and** end with `stack.destroy()`, deterministic names (no `Date.now`, no uuid), out-of-band verify via distilled, typed wait-until-gone, replacement where applicable. |
| Type-check | agents never run `tsc` / `tsc -b` / `pnpm build`. |
| Effect 4 | `Effect.result` + `Result.isSuccess` / `Result.isFailure`. No `Effect.either`. No `Effect.orDie` in lifecycle ops. No `async`/`await`, raw `Promise`, or `node:fs`. |
| Errors | unmatched `UnknownFlyIoError` or status-only handling is a **distilled patch**, never an alchemy catch. Catch typed `Conflict` / `NotFound` as races. |

---

## Two repos

| What | Where |
| --- | --- |
| Resources, bindings, tests, examples, this catalog | alchemy repo: `/Users/samgoodwin/workspaces/alchemy-effect-3` |
| Error/schema patches | **only** `distilled/packages/fly-io/patches/` |
| Generated SDK | `distilled/packages/fly-io/src/services/machines.ts` — **never edit by hand**. Regenerate. |

Never write Fly provider files into any `.grok/worktrees` path.

---

## Auth

Fly auth is a personal/org **API token**. There is no OAuth flow in v1.

| Alchemy env | Distilled `Credentials` field | Notes |
| --- | --- | --- |
| `FLY_API_TOKEN` (required) | `apiKey` (`Redacted`) | The only credential. |
| `FLY_API_HOSTNAME` (optional) | `apiBaseUrl` | If unset, `https://api.machines.dev/v1`. If set without a path, append `/v1`. If it already ends with `/v1`, use as-is. |

`Fly.AuthProvider` (`FLY_AUTH_PROVIDER_NAME = "Fly"`) mirrors Hetzner:

- methods: `env` (`FLY_API_TOKEN` + optional `FLY_API_HOSTNAME`) and `stored` (interactive token, `~/.alchemy/credentials`).
- `Fly/Credentials.ts` `fromAuthProvider()` maps onto `@distilled.cloud/fly-io`'s `{ apiKey, apiBaseUrl }`. Distilled's own `CredentialsFromEnv` reads `FLY_IO_API_KEY` — **do not use that env name in Alchemy**. The mapping layer is the seam.
- `FlyEnvironment` is `{ apiKey, apiBaseUrl }` resolved inside lifecycle ops via `FlyEnvironment.current` (same shape as `HetznerEnvironment`).

`currentTokenShow` is the org-discovery helper: `tokens[0].org_slug` feeds `appsList`. It is not a resource.

---

## Distilled patches (OpenAPI, not Smithy)

Fly patches target the **OpenAPI document**. `convert.ts` applies them, then
`generate.ts` compiles `.generated-specs/machines.json` with `patchesDir: false`.

### Keep working (do not number, do not move)

```
distilled/packages/fly-io/patches/bad-request-errors.patch.json
distilled/packages/fly-io/patches/forbidden-errors.patch.json
distilled/packages/fly-io/patches/not-found-errors.patch.json
```

Shared status-map errors stay in these `*-errors.patch.json` files.

### New per-op patches

```
distilled/packages/fly-io/patches/machines/{op}.patch.json
```

`{op}` is the **camelCase generated operation name** (`appsCreate.patch.json`,
`machinesWait.patch.json`). Do **not** number patch files.

### `convert.ts` upgrade (prerequisite, not optional)

`runOpenApiConvert` today picks **one** of:

1. `patches/<specName>/` if that directory exists (`patches/machines/`)
2. else, for a single-spec provider, the flat `patches/` directory

That would **drop** the existing `*-errors.patch.json` files the moment
`patches/machines/` is created. Upgrade `convert.ts` so the chain is:

1. Flat `patches/*.patch.json` (sorted) — the shared status maps.
2. Then `patches/machines/*.patch.json` (sorted) — per-op patches.

Both layers apply to the OpenAPI document. A warned-stale or failed patch
fails the generate; fix the patch, never skip.

Regenerate:

```sh
cd distilled/packages/fly-io
bun scripts/convert.ts
bun scripts/generate.ts --resource machines
pnpm exec oxfmt src/services/machines.ts
```

### Conflict

`Conflict` (HTTP 409) exists in `@distilled.cloud/fly-io` `errors.ts` and in
the converter's status map, but most generated ops do **not** currently
list it. Create/update races that 409 must be patched onto the op's
OpenAPI `responses/409` (shared file if many ops; per-op file if one)
so alchemy can `Effect.catchTag("Conflict", …)`. Never cast, never check
`UnknownFlyIoError` / status.

Machine wait timeouts that surface as untyped errors are also a patch,
not an alchemy catch.

---

## DX

`Fly.App` is the parent. Everything else is app-scoped.

```ts
const Site = Fly.App("Site");

// Raw image VM (no bundle). Tests use nginx:alpine.
const Web = yield* Fly.Machine("Web", {
  app: Site,
  region: "iad",
  image: "nginx:alpine",
  guest: { cpuKind: "shared", cpus: 1, memoryMb: 256 },
});

// Platform: bundle main, build/push to registry.fly.io, reconcile a Machine.
// N Services per App — each Service is its own Machine.
class Api extends Fly.Service<Api>()(
  "Api",
  { app: Site, main: import.meta.url, region: "iad" },
  Effect.gen(function* () {
    const data = yield* Fly.MountVolume(volume, { path: "/data" });
    const secret = yield* Fly.ReadSecret(dbUrl);
    return {
      fetch: Effect.gen(function* () {
        return yield* HttpServerResponse.json({ path: data.path });
      }),
    };
  }).pipe(Effect.provide(Fly.MountVolumeLive), Effect.provide(Fly.ReadSecretHttp)),
) {}
```

Module-scope refs (locked, same shape as `examples/hetzner-app`):

```ts
const Site = Fly.App("Site");

export default class Api extends Fly.Service<Api>()(
  "Api",
  { app: Site, main: import.meta.url, region: "iad" },
  Effect.gen(function* () { /* … */ }),
) {}
```

`app: Site` type-checks because `Site` is `Ref<App>` (`App | Effect<App, never, Providers>`).
`Service.transformProps` yields Effect-valued `app` at plan/deploy (no-op at
runtime), matching Hetzner `Service.transformProps` for `server`.

Contrast with Hetzner (do **not** copy this shape):

- Hetzner: N Services **share one Server**; each Service is a systemd unit copied over SSH.
- Fly: N Services **share one App**; each Service **is** a Machine. There is no shared VM.

---

## File layout (flat)

```
packages/alchemy/src/Fly/
  index.ts                 # re-exports (shared insertion)
  Providers.ts             # providers() layer (shared insertion)
  AuthProvider.ts
  Credentials.ts
  Environment.ts
  App.ts
  Machine.ts
  Volume.ts
  VolumeSnapshot.ts
  Certificate.ts
  IpAssignment.ts
  Secret.ts
  SecretKey.ts
  Service.ts               # Platform
  hosted.ts                # internal Service bundle/push helpers (NOT exported)
  MountVolume.ts           # Binding.Service
  SecretTypes.ts           # shared Secret client error
  SecretRead.ts            # Binding.Service + client (exported)
  SecretWrite.ts
  SecretReadWrite.ts
  SecretHttp.ts            # shared HTTP scaffolding (NOT exported from index)
  SecretReadHttp.ts
  SecretWriteHttp.ts
  SecretReadWriteHttp.ts
```

Tests: `packages/alchemy/test/Fly/{Resource}.test.ts`.

Example (after resources exist): `examples/fly-app/` mirroring
`examples/hetzner-app` — module-scope `Site`, `Api` Service, `Worker`
Service, shared `Volume` via `MountVolume`.

Shared-file discipline:

- `Fly/Providers.ts` and `Fly/index.ts` — single minimal insertions per
  resource agent. Re-read, retry on conflict, never rewrite wholesale.
- `packages/alchemy/package.json` `./Fly` export and the
  `@distilled.cloud/fly-io` dependency are **coordinator/auth-owned**.
  Do not fight over them.

`Fly/index.ts` re-exports contracts, per-level Secret HTTP layers, and
`MountVolume`. Do **not** export `SecretHttp.ts` or `hosted.ts`.

---

## Ownership, names, `list()`, nuke

Fly App has **no labels**. Ownership is:

| Resource | Stamp |
| --- | --- |
| App | physical name (globally unique `createPhysicalName`) plus child metadata |
| Machine / Service | `config.metadata["alchemy.stack" \| "alchemy.stage" \| "alchemy.id"]` and `alchemy.type` = `Fly.Machine` / `Fly.Service` |
| Volume | name generated with the alchemy physical-name shape (stack/stage/id) |
| Secret / SecretKey | same as Volume when `name` is omitted; user-provided names live on an owned App |
| Certificate / IpAssignment / VolumeSnapshot | scoped to an owned App (and owned Volume for snapshots) |

### App names

```ts
const raw = yield* createPhysicalName({ id, lowercase: true, maxLength: 30 });
const name = /^[a-z]/.test(raw) ? raw : `f${raw}`.slice(0, 30);
```

DNS-compatible: lowercase letters, digits, hyphens. Must start with a
letter. Globally unique across Fly. 30 chars is the lock (Fly DNS labels).

### `list()` (nuke)

Every resource implements `list()`. **Do not list the whole org unfiltered.**

1. `currentTokenShow({})` → `tokens[0].org_slug`.
2. `appsList({ org_slug })`.
3. Keep an app if **any** of:
   - it has ≥1 Machine whose `config.metadata.alchemy.stack` is set
   - it has ≥1 Volume/Secret/SecretKey whose name matches the alchemy
     physical-name shape
   - its own name matches the alchemy app-name shape produced by
     `createPhysicalName` + leading-letter force
4. Return **only** those apps. That filtered set is `App.list`.

Then:

| Resource | Strategy |
| --- | --- |
| `Machine.list` / `Service.list` | for each owned App, `machinesList`; keep rows whose metadata has `alchemy.stack`. Service vs Machine is `alchemy.type`. |
| `Volume.list` | for each owned App, `volumesList`; keep alchemy-named volumes. |
| `Secret.list` | for each owned App, `secretsList`; keep alchemy-named secrets **and** secrets whose names are in engine state for those apps. |
| `SecretKey.list` | for each owned App, `secretkeysList`; same filter as Secret. |
| `Certificate.list` | for each owned App, `appCertificatesList` — certs on an owned App are owned. |
| `IpAssignment.list` | for each owned App, `appIPAssignmentsList`. |
| `VolumeSnapshot.list` | for each owned Volume, `volumesListSnapshots`. |

`machinesOrgList` / `volumesOrgList` are **not** used for nuke. They are
unfiltered org dumps.

Nuke order (`nuke.dependsOn`):

```
Certificate, IpAssignment, Secret, SecretKey, VolumeSnapshot
  → Machine, Service          (wait destroyed)
  → Volume                    (cannot delete while attached)
  → App
```

`Service.nuke.dependsOn` includes `Fly.App`. `Machine` same. `Volume`
depends on `Fly.Machine` and `Fly.Service`. `App` has no `dependsOn`
(children must be gone first — the children's `dependsOn` encodes that).

---

## Reconciler + wait

One observe-ensure-sync flow. Cloud state is authoritative. `output` is a
cache for stable ids (`appName`, `machineId`, `volumeId`). If observation
misses, ensure recreates.

```
1. Observe  — derive physical id; appsShow / machinesShow / volumesGetById / …
2. Ensure   — if missing, create*. Catch Conflict and NotFound as races, re-read.
3. Sync     — each mutable aspect: read OBSERVED, diff desired, apply delta only.
4. Return   — re-read; return Attributes.
```

Machine wait (bounded — lock):

```ts
machinesWait({
  app_name,
  machine_id,
  state,          // "started" | "stopped" | "destroyed"
  timeout: 8,     // seconds; machinesWait blocks up to this
}).pipe(
  Effect.retry({
    times: 6,
    schedule: Schedule.exponential("500 millis"),
    while: (e) => e._tag !== "NotFound", // destroyed wait: NotFound is success
  }),
);
```

`times ≤ 10`, total backoff under 60s. Hitting the 240s test wall is a
failure. Catch `Conflict` as a race (retry). For `destroyed`, `NotFound`
is success (already gone). Never poll with `while (Date.now() < deadline)`.

Delete Machine: `machinesDelete` (force if still running) → wait
`destroyed` → treat `NotFound` as gone. Then volumes can delete.

---

## Resources

Status of every resource below is **`missing`** (not implemented). Priority
is the implementation order.

### 1. App — `Fly.App` — priority 1 — testability: yes

Parent. `POST /apps`, `GET /apps/{app_name}`, `DELETE /apps/{app_name}`,
`GET /apps?org_slug=`.

**Props**

| Name | Type | Required | Default | Replaces | Notes |
| --- | --- | --- | --- | --- | --- |
| `name` | `string` | no | physical name, max 30, leading letter | **yes** | Globally unique. Changing name replaces. |
| `orgSlug` | `string` | no | current token org | **yes** | `org_slug` on create. |
| `network` | `string` | no | Fly default | **yes** | Isolated network name. Immutable after create. |
| `enableSubdomains` | `boolean` | no | Fly default | no | `enable_subdomains`. Create-only; ignore on update (no update API). |

**Attrs**

| Name | Type | Notes |
| --- | --- | --- |
| `appId` | `string` | Fly `id` |
| `appName` | `string` | Fly `name` — the physical name |
| `internalNumericId` | `number \| undefined` | |
| `network` | `string \| undefined` | |
| `status` | `string \| undefined` | |
| `orgSlug` | `string \| undefined` | `organization.slug` |
| `machineCount` | `number \| undefined` | observed |
| `volumeCount` | `number \| undefined` | observed |

**Lifecycle**

| Op | Distilled |
| --- | --- |
| observe | `appsShow({ app_name })`; `NotFound` → missing |
| ensure | `appsCreate({ name, org_slug, network, enable_subdomains })`; catch `Conflict` / name-taken (`UnprocessableEntity`) as race, then show |
| sync | no update API. Replacement for name/org/network. |
| delete | `appsDelete({ app_name })`; `NotFound` = success. Machines/volumes must already be gone. |
| list | see Ownership |

No metadata/labels on App. No `pre-create`.

---

### 2. Machine — `Fly.Machine` — priority 1 — testability: yes

Raw image VM. Public image `nginx:alpine` in tests. Not a Platform.

**Props**

| Name | Type | Required | Default | Replaces | Notes |
| --- | --- | --- | --- | --- | --- |
| `app` | `Ref<App>` | yes | | **yes** | Parent. |
| `name` | `string` | no | physical name | **yes** | Unique per app. |
| `region` | `string` | no | `"iad"` | **yes** | |
| `image` | `string` | yes | | no | Docker image ref. Update in place via `machinesUpdate`. |
| `guest` | `{ cpuKind?: string; cpus?: number; memoryMb?: number; gpuKind?: string; gpus?: number }` | no | shared-cpu-1x 256MB | no | Maps to `config.guest`. |
| `env` | `Record<string, string>` | no | | no | Merged with binding `env`. |
| `services` | machine-service structs | no | | no | Fly proxy services/ports. |
| `init` | `{ cmd?; entrypoint?; exec?; swapSizeMb?; tty? }` | no | | no | |
| `metadata` | `Record<string, string>` | no | | no | User metadata. Alchemy keys always merged. |
| `autoDestroy` | `boolean` | no | `false` | no | |
| `restart` | `{ policy?; maxRetries? }` | no | | no | |
| `skipLaunch` | `boolean` | no | `false` | no | Create/update flag. |
| `minSecretsVersion` | `number` | no | | no | |

Mounts are **not** a prop. They come from `MountVolume` bindings.

**Attrs**

| Name | Type |
| --- | --- |
| `appName` | `string` |
| `machineId` | `string` |
| `name` | `string` |
| `region` | `string` |
| `state` | `string` |
| `instanceId` | `string \| undefined` |
| `privateIp` | `string \| undefined` |
| `imageRef` | `{ registry?; repository?; tag?; digest? } \| undefined` |
| `guest` | observed guest |

Stables: `machineId`, `name`, `region`, `appName`.

**Binding contract** (4th type param):

```ts
{
  env?: Record<string, any>;
  mounts?: Array<{ volume: string; path: string }>;
}
```

**Lifecycle**

| Op | Distilled |
| --- | --- |
| observe | `machinesShow({ app_name, machine_id })`; fallback `machinesList` by name; `NotFound` → missing |
| ensure | `machinesCreate({ app_name, name, region, config })`; catch `Conflict`; wait `started` unless `skipLaunch` |
| sync | `machinesUpdate` when image/guest/env/services/mounts/metadata/restart differ from **observed** config. Stamp metadata every time. Skip the API on no-op. Wait `started`. |
| delete | `machinesDelete` → wait `destroyed`; `NotFound` = success |
| list | owned apps → `machinesList` → metadata filter, `alchemy.type === "Fly.Machine"` |

`config.metadata` always includes:

```
alchemy.stack, alchemy.stage, alchemy.id, alchemy.type=Fly.Machine
```

Diff: region or name change → **replace**. Image/guest/env/services/metadata → update. `app` change → replace.

Replacement coverage is required in tests (region `iad` → another cheap region only if the suite can afford it; otherwise name-replace or image-update plus a dedicated replace test that changes `name`).

---

### 3. Volume — `Fly.Volume` — priority 2 — testability: yes

**Props**

| Name | Type | Required | Default | Replaces | Notes |
| --- | --- | --- | --- | --- | --- |
| `app` | `Ref<App>` | yes | | **yes** | |
| `name` | `string` | no | physical name (ownership stamp) | **yes** | Unique per app. Fly groups volumes by name. |
| `region` | `string` | no | `"iad"` | **yes** | |
| `sizeGb` | `number` | yes | | no (grow) / **yes** (shrink) | Extend via `volumesExtend`. Fly cannot shrink. |
| `encrypted` | `boolean` | no | Fly default | **yes** | Create-only. |
| `fstype` | `string` | no | | **yes** | Create-only. |
| `autoBackupEnabled` | `boolean` | no | Fly default (`true`) | no | `volumesUpdate`. |
| `snapshotRetention` | `number` | no | | no | `volumesUpdate`. |
| `snapshotId` | `string` | no | | **yes** | Restore-from. Create-only. |
| `sourceVolumeId` | `string` | no | | **yes** | Fork. Create-only. |
| `requireUniqueZone` | `boolean` | no | | **yes** | Create-only. |

**Attrs**: `appName`, `volumeId`, `name`, `region`, `sizeGb`, `encrypted`, `fstype`, `state`, `attachedMachineId`, `autoBackupEnabled`, `snapshotRetention`, `createdAt`, `zone`.

Stables: `volumeId`, `name`, `region`, `appName`.

**Lifecycle**

| Op | Distilled |
| --- | --- |
| observe | `volumesGetById`; `NotFound` → missing |
| ensure | `volumesCreate`; catch `Conflict` |
| sync | grow: `volumesExtend({ size_gb })` if observed `size_gb` < desired. `volumesUpdate` for auto_backup / snapshot_retention. Never shrink (diff returns replace if `sizeGb` decreases). |
| delete | `volumeDelete`; retry `Conflict` (still attached) with bounded wait; `NotFound` = success |
| list | owned apps → `volumesList` → alchemy name filter |

**No VolumeAttachment.** Attach happens when a Machine/Service reconciles `config.mounts` from `MountVolume`.

Tests: create 1 GB (Fly minimum is 1), extend, replace on region, destroy, wait-until-gone via `volumesGetById` + `NotFound`.

---

### 4. VolumeSnapshot — `Fly.VolumeSnapshot` — priority 3 — testability: limited

Machines API: `POST .../volumes/{volume_id}/snapshots` (empty response) and
`GET .../snapshots`. **There is no delete operation.**

**Props**

| Name | Type | Required | Replaces |
| --- | --- | --- | --- |
| `app` | `Ref<App>` | yes | yes |
| `volume` | `Ref<Volume>` | yes | yes |

No other mutable props. Create is fire-and-forget; identity is the snapshot
`id` from a subsequent `volumesListSnapshots`.

**Attrs**: `appName`, `volumeId`, `snapshotId`, `status`, `digest`, `size`, `volumeSize`, `retentionDays`, `createdAt`.

**Lifecycle**

| Op | Distilled |
| --- | --- |
| observe | `volumesListSnapshots` and pick `snapshotId` / newest matching |
| ensure | `createVolumeSnapshot`; then list until the snapshot appears (bounded repeat, `times ≤ 8`) |
| sync | none (immutable) |
| delete | **no-op** (no API). `nuke.skip: true`. Snapshots follow Volume `snapshot_retention` / Volume delete. |
| list | owned volumes → `volumesListSnapshots` |

Tests: create, out-of-band list, do not assert cloud-side delete. `skipIf` if snapshot create is plan-gated.

---

### 5. Certificate — `Fly.Certificate` — priority 3 — testability: limited

Needs a real hostname. Full lifecycle behind `FLY_TEST_DOMAIN`. Always keep
an ungated probe that the typed error comes back without a domain.

**Props**

| Name | Type | Required | Replaces | Notes |
| --- | --- | --- | --- | --- |
| `app` | `Ref<App>` | yes | yes | |
| `hostname` | `string` | yes | **yes** | Identity. |
| `kind` | `"acme" \| "custom"` | no | **yes** | Default `"acme"`. |
| `fullchain` | `string` | custom only | no | PEM. |
| `privateKey` | `Redacted.Redacted<string> \| string` | custom only | no | Sensitive. |

**Attrs**: `appName`, `hostname`, `status`, `configured`, `acmeRequested`, `dnsRequirements`, `validation`, `source`.

**Lifecycle**

| kind | ensure | delete | read/list |
| --- | --- | --- | --- |
| `acme` | `appCertificatesAcmeCreate` | `appCertificatesAcmeDelete` or `appCertificatesDelete` | `appCertificatesShow` / `appCertificatesList` |
| `custom` | `appCertificatesCustomCreate` | `appCertificatesCustomDelete` | same |

Sync: ACME re-validate via `appCertificatesCheck` when observed `configured === false` (bounded). Custom cert material update = delete+create (or custom create upsert if the API is idempotent — observe first).

Existence-shaped: hostname is the identity. No update-in-place for hostname.

---

### 6. IpAssignment — `Fly.IpAssignment` — priority 3 — testability: yes (v6 / shared_v4)

Do **not** allocate dedicated IPv4 in default tests (billed). Test `v6` and
`shared_v4`.

**Props**

| Name | Type | Required | Replaces |
| --- | --- | --- | --- |
| `app` | `Ref<App>` | yes | yes |
| `type` | `"v4" \| "v6" \| "shared_v4"` | yes | **yes** |
| `region` | `string` | no | **yes** (dedicated) |
| `network` | `string` | no | **yes** |
| `orgSlug` | `string` | no | no |
| `serviceName` | `string` | no | **yes** |

**Attrs**: `appName`, `ip`, `type` (from observed), `region`, `serviceName`, `shared`, `createdAt`.

Identity is `ip`. Existence-only: observe `appIPAssignmentsList` for the ip;
if missing, `appIPAssignmentsCreate`; delete `appIPAssignmentsDelete({ ip })`.
No sync.

---

### 7. Secret — `Fly.Secret` — priority 2 — testability: yes

App secret. Fly injects app secrets into Machines as env unless
`skip_secrets`. The Secret resource is the app-level value.

**Props**

| Name | Type | Required | Replaces | Notes |
| --- | --- | --- | --- | --- |
| `app` | `Ref<App>` | yes | yes | |
| `name` | `string` | no | **yes** | Env-var name when set by the user. If omitted, physical name (ownership stamp). |
| `value` | `Redacted.Redacted<string> \| string` | yes | no | Update in place via `secretCreate` (upsert). |

**Attrs**: `appName`, `name`, `digest`, `createdAt`, `updatedAt`. **Never persist `value` in state.**

**Lifecycle**

| Op | Distilled |
| --- | --- |
| observe | `secretGet({ show_secrets: false })`; `NotFound` → missing |
| ensure | `secretCreate({ secret_name, value })` (create-or-update) |
| sync | if observed digest ≠ desired, `secretCreate` again. Do not use digest of Redacted incorrectly — compare by re-putting when `olds` value hash differs **and** as a fallback always put when `olds` is absent (adoption). Prefer observed digest vs hash of desired. |
| delete | `secretDelete`; `NotFound` = success |
| list | owned apps → `secretsList` |

`secretsUpdate` (batch) is a helper, not a resource.

---

### 8. SecretKey — `Fly.SecretKey` — priority 3 — testability: yes

App secret **key** (crypto key), not an env secret.

**Props**

| Name | Type | Required | Replaces | Notes |
| --- | --- | --- | --- | --- |
| `app` | `Ref<App>` | yes | yes | |
| `name` | `string` | no | **yes** | Physical name if omitted. |
| `type` | `string` | no | **yes** | Fly key type (`nacl_sign`, `nacl_box`, `hmac`, …). |
| `value` | `ReadonlyArray<number>` | no | no | If omitted, `secretkeyGenerate`. If set, `secretkeySet`. |

**Attrs**: `appName`, `name`, `type`, `publicKey`, `createdAt`, `updatedAt`. Never persist private material.

**Lifecycle**: observe `secretkeyGet`; ensure generate or set; no meaningful sync besides re-set when value changes; delete `secretkeyDelete`; list `secretkeysList` on owned apps.

Encrypt/decrypt/sign/verify are **not** v1 bindings (runtime ops, not IaC).

---

### 9. Service — `Fly.Service` — priority 2 — testability: yes — **Platform**

`Platform("Fly.Service", { createRuntimeContext, transformProps })`.

Bundles `main` with rolldown (same hosted-program path as Hetzner/Docker),
builds a Docker image, pushes to `registry.fly.io/{appName}/{logicalId}`,
reconciles **one Machine**.

N Services per App. Each Service = one Machine. Not systemd-on-a-box.

**Props** (`PlatformProps` +)

| Name | Type | Required | Default | Replaces | Notes |
| --- | --- | --- | --- | --- | --- |
| `app` | `Ref<App>` | yes | | **yes** | Module-scope `Site` is valid. |
| `main` | `string` | yes | | no | `import.meta.url`. Hash change → update (new image + `machinesUpdate`). |
| `region` | `string` | no | `"iad"` | **yes** | |
| `guest` | same as Machine | no | shared-cpu-1x 256MB | no | |
| `port` | `number` | no | `3000` | no | Internal listen port + Fly service `internal_port`. |
| `handler` | `string` | no | `"default"` | no | |
| `env` | `Record<string, any>` | no | | no | Merged after binding env. |
| `build` | `Bundle.BundleConfig` | no | | no | |
| `image` | `string` | no | generated bun base | no | Dockerfile `FROM`. |
| `services` | machine-service structs | no | http 80/443 → `port` | no | |
| `name` | `string` | no | physical name | **yes** | Machine name. |

Mounts from `MountVolume`. Secrets from Secret HTTP bindings (runtime) and
from app-level `Fly.Secret` (injected by Fly into the Machine).

**Attrs**: `appName`, `machineId`, `name`, `region`, `state`, `url`
(`https://{appName}.fly.dev` when a public service is configured),
`imageRef`, `code: { hash }`.

Stables: `machineId`, `name`, `region`, `appName`.

**Lifecycle** — same Machine observe-ensure-sync, plus:

1. Bundle `main` → content hash (Hetzner `hosted.bundleProgram` equivalent).
2. If hash ≠ `output.code.hash` or Machine missing: build image, `appCreateDeployToken` for registry auth, push `registry.fly.io/{appName}/{logicalId}:{hash}`.
3. Reconcile Machine with `config.image` = that ref, `alchemy.type=Fly.Service`, mounts from bindings, env from bindings.
4. Wait `started`.

Deploy-time Docker engine is required for Service tests. Raw `Fly.Machine`
tests must **not** require Docker (`nginx:alpine`).

`list()`: owned apps → machines with `alchemy.type=Fly.Service`.

`transformProps`: yield Effect-valued `app` (Hetzner `server` pattern). No-op at runtime.

Binding contract: same as Machine (`env`, `mounts`).

---

## Bindings

### MountVolume — `Fly.MountVolume` — required

```ts
yield* Fly.MountVolume(volume, { path: "/data" })
```

Inside a Machine or Service impl. Registers `{ mounts: [{ volume: volume.volumeId, path }] }`
on the host via `` host.bind`${volume}`({ mounts: [...] }) ``, guarded by
`!globalThis.__ALCHEMY_RUNTIME__`.

Returns `{ path, volumeId }`.

Machine/Service reconcile reads binding `mounts` and writes `config.mounts`
(`FlyMachineMount.volume` + `path`). Same `(volume, path)` from two Services
on **different** Machines is two mounts (each Machine is its own VM). Two
binds on the **same** Service collapse to one mount.

**There is no VolumeAttachment resource.** This is the only attach path.

Provide `MountVolumeLive` on the Service/Machine Effect
(`Effect.provide(Fly.MountVolumeLive)`).

### Secret Read / Write / ReadWrite — HTTP only

Fly has no native worker-style binding. HTTP implementations talk to the
Machines secrets API using credentials injected into the host.

Flat names (no `Fly.Secret.Read` nested API):

| File | Export | Role |
| --- | --- | --- |
| `SecretRead.ts` | `SecretRead`, `ReadSecret` (bind alias), `ReadSecretClient` | `get` |
| `SecretWrite.ts` | `SecretWrite`, `WriteSecret`, `WriteSecretClient` | `put` / `delete` |
| `SecretReadWrite.ts` | `SecretReadWrite`, `ReadWriteSecret`; client **extends** Read + Write | both |
| `SecretHttp.ts` | **not exported** | shared HTTP scaffolding (`makeHttpSecretBinding`) |
| `SecretReadHttp.ts` | `ReadSecretHttp` | Layer |
| `SecretWriteHttp.ts` | `WriteSecretHttp` | Layer |
| `SecretReadWriteHttp.ts` | `ReadWriteSecretHttp` | Layer |

Inner client methods require `Alchemy.RuntimeContext`. Outer bind Effect
does not. Close over env at layer build; do not leak `FlyEnvironment` onto
the callable.

Runtime ops (typed errors from distilled):

- Read: `secretGet({ show_secrets: true })`
- Write: `secretCreate` / `secretDelete`

HTTP auth: inject a Redacted token + `appName` into the host env (deploy
token from `appCreateDeployToken` scoped to the App, not the user token
when possible). Scaffolding mints that once per host, like R2 HTTP mints
an `AccountApiToken`.

---

## Distilled operations → resource / helper / out of scope

| Operation | Use |
| --- | --- |
| `appsCreate` / `appsShow` / `appsDelete` / `appsList` | App |
| `currentTokenShow` | Auth + App.list org_slug |
| `machinesCreate` / `machinesShow` / `machinesUpdate` / `machinesDelete` / `machinesList` / `machinesWait` | Machine, Service |
| `machinesStart` / `machinesStop` / `machinesRestart` | Machine/Service reconcile helpers |
| `machinesShowMetadata` / `machinesUpsertMetadata` / `machinesUpdateMetadata` / `machinesGetMetadataKey` | ownership stamp helpers |
| `volumesCreate` / `volumesGetById` / `volumesUpdate` / `volumesExtend` / `volumeDelete` / `volumesList` | Volume |
| `createVolumeSnapshot` / `volumesListSnapshots` | VolumeSnapshot |
| `appCertificatesAcmeCreate` / `AcmeDelete` / `CustomCreate` / `CustomDelete` / `Delete` / `List` / `Show` / `Check` | Certificate |
| `appIPAssignmentsCreate` / `Delete` / `List` | IpAssignment |
| `secretCreate` / `secretGet` / `secretDelete` / `secretsList` | Secret + Secret HTTP bindings |
| `secretsUpdate` | Secret batch helper (optional) |
| `secretkeyGenerate` / `Set` / `Get` / `Delete` / `secretkeysList` | SecretKey |
| `appCreateDeployToken` | Service registry push |

### Out of scope (do not implement as resources)

| Operation / area | Why |
| --- | --- |
| `machinesCreateLease` / `ShowLease` / `ReleaseLease` | Orchestration locks, not desired-state IaC. |
| `machinesDeleteMetadata` plus metadata-as-resource | Metadata is stamped on Machine config, not a resource. |
| `machinesExec` / `machinesSignal` | Runtime process control, not IaC. |
| `machinesCordon` / `machinesUncordon` | Blue/green proxy switch; not a resource. |
| `machinesSuspend` | Runtime state; not a declared resource. Start/stop are reconcile helpers only. |
| `machinesGetMemory` / `SetMemoryLimit` / `ReclaimMemory` | Balloon device; not IaC. |
| `machinesListEvents` / `ListProcesses` / `ListVersions` | Observability, not desired state. |
| `machinesOrgList` / `volumesOrgList` | Unfiltered org dumps. Forbidden for `list()`. |
| `machinesUpdateMetadata2` | Duplicate of `machinesUpdateMetadata`. Do not call. |
| `tokensAuthenticate` / `tokensAuthorize` / `tokensRequestKms` / `tokensRequestOIDC` | Auth/OIDC/KMS, not resources. |
| `platformPlacementsPost` / `platformRegionsGet` | Capacity helpers, not resources. |
| `secretkeyEncrypt` / `Decrypt` / `Sign` / `Verify` | Runtime crypto; not v1 bindings. |
| GraphQL-only Postgres / Redis / Consul / `fly postgres` | **Not in distilled Machines API.** Out of scope until a distilled service exists. |
| `fly.toml` / `fly deploy` / Machines Apps-v2 GraphQL | Not the Machines API. |

---

## Tests (locked)

Wrap every live invocation:

```sh
timeout 240 doppler run --project alchemy-v2 --config dev -- pnpm test test/Fly/<Resource>.test.ts --profile testing --retry 0
```

From the alchemy repo root. Suite paths are relative to `packages/alchemy`.
Per-test timeout 90–120s. Never print secret values.

Rules:

- `Test.make({ providers: Fly.providers() })`.
- Start **and** end with `stack.destroy()`.
- Deterministic names: omit `name` (engine physical name) or a constant.
  No `Date.now()`, no uuid.
- Out-of-band verify via distilled (`appsShow`, `machinesShow`, …).
- Typed wait-until-gone (`NotFound`), bounded.
- Replacement tests where the table says replaces.
- Default region `iad`. Cheapest guest. `nginx:alpine` for raw Machine.
- Service tests may use Docker; Machine tests must not require it.
- Certificate full lifecycle: `skipIf(!process.env.FLY_TEST_DOMAIN)`.
- Dedicated IPv4: not in default tests.

---

## Implementation order

1. Distilled: upgrade `convert.ts` to apply flat + `patches/machines/`. Patch `Conflict` (and wait-timeout if untyped) onto racing ops. Regenerate.
2. Auth + Credentials + Environment + `providers()` skeleton.
3. App + tests.
4. Machine (nginx:alpine) + tests + wait helper.
5. Volume + MountVolume + Machine mount test.
6. Secret + Secret HTTP bindings.
7. Service (bundle + registry.fly.io + Machine).
8. VolumeSnapshot, Certificate, IpAssignment, SecretKey.

Do not open a PR from a catalog-only change set that also implements
resources. Catalog lands first; implementation is a later wave.
