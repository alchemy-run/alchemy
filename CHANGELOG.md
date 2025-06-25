## v0.40.1

*No significant changes*

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.40.0...v0.40.1)

---

## v0.40.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- **cloudflare**: Miniflare dev server &nbsp;-&nbsp; by **John Royal** in https://github.com/sam-goodwin/alchemy/issues/396 [<samp>(3d219)</samp>](https://github.com/sam-goodwin/alchemy/commit/3d21941c)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**: DOStateStore undefined fix &nbsp;-&nbsp; by **John Royal** in https://github.com/sam-goodwin/alchemy/issues/480 [<samp>(7d909)</samp>](https://github.com/sam-goodwin/alchemy/commit/7d9095e0)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.39.1...v0.40.0)

---

## v0.39.1

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **core**: Stage scope not being adopted &nbsp;-&nbsp; by **Michael K** in https://github.com/sam-goodwin/alchemy/issues/469 [<samp>(b949a)</samp>](https://github.com/sam-goodwin/alchemy/commit/b949aade)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.39.0...v0.39.1)

---

## v0.39.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- **cloudflare**: Support Worker.domains for custom domains &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/468 [<samp>(7a357)</samp>](https://github.com/sam-goodwin/alchemy/commit/7a357763)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.38.1...v0.39.0)

---

## v0.38.1

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**: Do state store fails to upload &nbsp;-&nbsp; by **John Royal** in https://github.com/sam-goodwin/alchemy/issues/465 [<samp>(ca966)</samp>](https://github.com/sam-goodwin/alchemy/commit/ca966235)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.38.0...v0.38.1)

---

## v0.38.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- **cli**:
  - Complete cli overhaul with trpc-cli, zod, and clack/prompts &nbsp;-&nbsp; by **Aman Varshney** in https://github.com/sam-goodwin/alchemy/issues/405 [<samp>(dea9e)</samp>](https://github.com/sam-goodwin/alchemy/commit/dea9ed1e)
- **cloudflare**:
  - Pin default worker compatibility date to build time &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/460 [<samp>(10035)</samp>](https://github.com/sam-goodwin/alchemy/commit/100355b0)
  - Add URL support to WorkerStub &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/464 [<samp>(4fda9)</samp>](https://github.com/sam-goodwin/alchemy/commit/4fda99da)
- **core**:
  - Replace Resource &nbsp;-&nbsp; by **Michael K** in https://github.com/sam-goodwin/alchemy/issues/417 [<samp>(27133)</samp>](https://github.com/sam-goodwin/alchemy/commit/271331e1)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.37.2...v0.38.0)

---

## v0.37.2

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**: Defensively resolve __dirname and worker.ts > worker.js in DOStateStore &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/452 [<samp>(c63fd)</samp>](https://github.com/sam-goodwin/alchemy/commit/c63fdd60)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.37.1...v0.37.2)

---

## v0.37.1

### &nbsp;&nbsp;&nbsp;🚀 Features

- **cloudflare**: Relax Durable Object RPC type constraint &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/445 [<samp>(107e7)</samp>](https://github.com/sam-goodwin/alchemy/commit/107e79de)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**: DOStateStore init uploads a worker and not a version &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/447 [<samp>(30cc6)</samp>](https://github.com/sam-goodwin/alchemy/commit/30cc6424)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.37.0...v0.37.1)

---

## v0.37.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- **cloudflare**: Add `run_worker_first: string[]` option &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/sam-goodwin/alchemy/issues/440 [<samp>(d4b0d)</samp>](https://github.com/sam-goodwin/alchemy/commit/d4b0de34)
- **stripe**: Price meter support &nbsp;-&nbsp; by **Nick Balestra-Foster** in https://github.com/sam-goodwin/alchemy/issues/410 [<samp>(9315d)</samp>](https://github.com/sam-goodwin/alchemy/commit/9315d742)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**:
  - Adopt DO that have migration tags &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/437 [<samp>(bcbd7)</samp>](https://github.com/sam-goodwin/alchemy/commit/bcbd7fdb)
  - Website resource respects cwd prop for wrangler.jsonc placement &nbsp;-&nbsp; by **John Royal** in https://github.com/sam-goodwin/alchemy/issues/443 [<samp>(bef17)</samp>](https://github.com/sam-goodwin/alchemy/commit/bef17985)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.36.0...v0.37.0)

---

## v0.36.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- **docker**: Docker provider &nbsp;-&nbsp; by **Pavitra Golchha** in https://github.com/sam-goodwin/alchemy/issues/189 [<samp>(6f973)</samp>](https://github.com/sam-goodwin/alchemy/commit/6f973983)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cli**: Improve package manager handling in create-alchemy &nbsp;-&nbsp; by **Nico Baier** in https://github.com/sam-goodwin/alchemy/issues/423 [<samp>(d0c7c)</samp>](https://github.com/sam-goodwin/alchemy/commit/d0c7ce83)
- **core**: Allow colors in CI environments, only disable for NO_COLOR &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/429 [<samp>(a194a)</samp>](https://github.com/sam-goodwin/alchemy/commit/a194ab5a)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.35.1...v0.36.0)

---

## v0.35.1

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **fs**: Better support for windows file system &nbsp;-&nbsp; by **Michael K** in https://github.com/sam-goodwin/alchemy/issues/430 [<samp>(8dd9f)</samp>](https://github.com/sam-goodwin/alchemy/commit/8dd9f196)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.35.0...v0.35.1)

---

## v0.35.0

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**:
  - Set force=true when deleting a Worker &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/432 [<samp>(2b21d)</samp>](https://github.com/sam-goodwin/alchemy/commit/2b21d41e)
  - Call wfp endpoint when deleting workers &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/434 [<samp>(d109d)</samp>](https://github.com/sam-goodwin/alchemy/commit/d109d984)
- **core**:
  - Ensure alchemy providers are globally registered &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/433 [<samp>(b0528)</samp>](https://github.com/sam-goodwin/alchemy/commit/b05284f6)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.34.3...v0.35.0)

---

## v0.34.3

### &nbsp;&nbsp;&nbsp;🚀 Features

- **cloudflare**:
  - Support RPC type in WorkerStub &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/425 [<samp>(0b682)</samp>](https://github.com/sam-goodwin/alchemy/commit/0b682dac)
  - Support adopting Queue Consumer &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/431 [<samp>(82b2d)</samp>](https://github.com/sam-goodwin/alchemy/commit/82b2d018)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.34.2...v0.34.3)

---

## v0.34.2

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**: Export WorkerStub &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/424 [<samp>(34cb0)</samp>](https://github.com/sam-goodwin/alchemy/commit/34cb09b8)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.34.1...v0.34.2)

---

## v0.34.1

### &nbsp;&nbsp;&nbsp;🚀 Features

- **aws**: S3StateStore &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/419 [<samp>(73b90)</samp>](https://github.com/sam-goodwin/alchemy/commit/73b907b5)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.34.0...v0.34.1)

---

## v0.34.0

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**: Add preview IDs for KV, D1, and R2 in wrangler.json &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/413 [<samp>(4a59d)</samp>](https://github.com/sam-goodwin/alchemy/commit/4a59d3a3)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.33.1...v0.34.0)

---

## v0.33.1

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**: Use dispatch namespace asset upload for WFP &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/412 [<samp>(bf6b5)</samp>](https://github.com/sam-goodwin/alchemy/commit/bf6b5b80)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.33.0...v0.33.1)

---

## v0.33.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- **stripe**: Add Full Tier Support for Stripe Prices &nbsp;-&nbsp; by **Nick Balestra-Foster** in https://github.com/sam-goodwin/alchemy/issues/406 [<samp>(7691c)</samp>](https://github.com/sam-goodwin/alchemy/commit/7691c2ce)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**: Configure Websites to support SSR by default &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/409 [<samp>(72521)</samp>](https://github.com/sam-goodwin/alchemy/commit/72521e8f)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.32.1...v0.33.0)

---

## v0.32.1

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**: Fix SSR for astro by setting not_found_hanlding=none &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/407 [<samp>(7750f)</samp>](https://github.com/sam-goodwin/alchemy/commit/7750f024)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.32.0...v0.32.1)

---

## v0.32.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- **cloudflare**: Add Worker version/preview support with labels &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/351 [<samp>(615fc)</samp>](https://github.com/sam-goodwin/alchemy/commit/615fc9d1)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.31.0...v0.32.0)

---

## v0.31.0

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Bug in create vitejs &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(4efe2)</samp>](https://github.com/sam-goodwin/alchemy/commit/4efe232e)
- Move required and internal peerDeps to deps &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/402 [<samp>(31d92)</samp>](https://github.com/sam-goodwin/alchemy/commit/31d924d2)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.30.1...v0.31.0)

---

## v0.30.1

### &nbsp;&nbsp;&nbsp;🚀 Features

- **cloudflare**:
  - Auto-create default secrets store &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/395 [<samp>(3251d)</samp>](https://github.com/sam-goodwin/alchemy/commit/3251d1e1)
  - Add SecretKey binding support for Cloudflare Workers &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/385 [<samp>(08278)</samp>](https://github.com/sam-goodwin/alchemy/commit/082785a1)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**: Secret binding type &nbsp;-&nbsp; by **Tyler van Hensbergen** in https://github.com/sam-goodwin/alchemy/issues/398 [<samp>(724d9)</samp>](https://github.com/sam-goodwin/alchemy/commit/724d9c26)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.30.0...v0.30.1)

---

## v0.30.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- Implement alchemy create CLI &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/376 [<samp>(85a8e)</samp>](https://github.com/sam-goodwin/alchemy/commit/85a8e2f8)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.29.3...v0.30.0)

---

## v0.29.3

### &nbsp;&nbsp;&nbsp;🚀 Features

- **cloudflare**: Allow binding individual secrets &nbsp;-&nbsp; by **Tyler van Hensbergen** in https://github.com/sam-goodwin/alchemy/issues/393 [<samp>(39483)</samp>](https://github.com/sam-goodwin/alchemy/commit/394833a4)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **core**: Ensure global Secret list is stored on globalThis &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(8733a)</samp>](https://github.com/sam-goodwin/alchemy/commit/8733a38f)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.29.2...v0.29.3)

---

## v0.29.2

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **core**: Use Symbol instead of instanceof for checking Secret and Scope &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/391 [<samp>(be1c1)</samp>](https://github.com/sam-goodwin/alchemy/commit/be1c156e)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.29.1...v0.29.2)

---

## v0.29.1

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **core**: Ensure Scope AsyncLocalStorage is unique singleton even with multiple alchemy instances &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/390 [<samp>(1c113)</samp>](https://github.com/sam-goodwin/alchemy/commit/1c113177)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.29.0...v0.29.1)

---

## v0.29.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- Add automatic CLI argument parsing to alchemy() function &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/356 [<samp>(ddf55)</samp>](https://github.com/sam-goodwin/alchemy/commit/ddf55085)
- **github**: Add GitHub Comment resource for issue and PR comments &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/365 [<samp>(a4a82)</samp>](https://github.com/sam-goodwin/alchemy/commit/a4a82185)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**:
  - Handle null upload result &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/367 [<samp>(d6681)</samp>](https://github.com/sam-goodwin/alchemy/commit/d66817af)
  - SecretsStore adoption logic to check existing store before creating &nbsp;-&nbsp; by **Tyler van Hensbergen** in https://github.com/sam-goodwin/alchemy/issues/378 [<samp>(3d542)</samp>](https://github.com/sam-goodwin/alchemy/commit/3d542533)
  - 404 error when deploying dofs state store &nbsp;-&nbsp; by **John Royal** in https://github.com/sam-goodwin/alchemy/issues/379 [<samp>(f5b7e)</samp>](https://github.com/sam-goodwin/alchemy/commit/f5b7e5d9)
- **core**:
  - Export Scope class &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(78877)</samp>](https://github.com/sam-goodwin/alchemy/commit/788773ca)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.28.0...v0.29.0)

---

## v0.28.0

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Remove interactive CLI that brought in Ink and React from alchemy dependency and &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/360 [<samp>(e7797)</samp>](https://github.com/sam-goodwin/alchemy/commit/e77976f7)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.27.0...v0.28.0)

---

## v0.27.0

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**: Rename dispatchNamespace property to namespace &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(3e6c6)</samp>](https://github.com/sam-goodwin/alchemy/commit/3e6c6f6f)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.26.1...v0.27.0)

---

## v0.26.1

### &nbsp;&nbsp;&nbsp;🚀 Features

- **cloudflare**: Implement DispatchNamespace resource and Worker dispatch namespace support &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/343 [<samp>(0a13a)</samp>](https://github.com/sam-goodwin/alchemy/commit/0a13aa15)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.26.0...v0.26.1)

---

## v0.26.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- Anonymous telemetry with opt-out &nbsp;-&nbsp; by **John Royal** in https://github.com/sam-goodwin/alchemy/issues/302 [<samp>(d2c53)</samp>](https://github.com/sam-goodwin/alchemy/commit/d2c53f5c)
- Add fancy deployment CLI &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/sam-goodwin/alchemy/issues/315 [<samp>(5efac)</samp>](https://github.com/sam-goodwin/alchemy/commit/5efac184)
- **cloudflare**:
  - Add Cloudflare Email Routing resources &nbsp;-&nbsp; by **Sam Goodwin** and **sam-goodwin** in https://github.com/sam-goodwin/alchemy/issues/314 [<samp>(5a3df)</samp>](https://github.com/sam-goodwin/alchemy/commit/5a3df036)
  - Add adopt support to Pipeline resource &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/318 [<samp>(c9f23)</samp>](https://github.com/sam-goodwin/alchemy/commit/c9f2387b)
  - Add SvelteKit on Cloudflare Workers guide using Alchemy &nbsp;-&nbsp; by **Jordan Coeyman** in https://github.com/sam-goodwin/alchemy/issues/271 [<samp>(c516c)</samp>](https://github.com/sam-goodwin/alchemy/commit/c516c47d)
  - Add Astro resource for Cloudflare deployment &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/330 [<samp>(dbea5)</samp>](https://github.com/sam-goodwin/alchemy/commit/dbea5738)
  - Add routes support to Worker and Website resources &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/336 [<samp>(510e2)</samp>](https://github.com/sam-goodwin/alchemy/commit/510e29a4)
  - Add Cloudflare Images binding support &nbsp;-&nbsp; in https://github.com/sam-goodwin/alchemy/issues/239 [<samp>(a785d)</samp>](https://github.com/sam-goodwin/alchemy/commit/a785d28f)
  - Secrets Store and Secret &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/296 [<samp>(b1979)</samp>](https://github.com/sam-goodwin/alchemy/commit/b1979873)
- **planetscale**:
  - Planetscale databases & branch &nbsp;-&nbsp; by **NickBlow** in https://github.com/sam-goodwin/alchemy/issues/268 [<samp>(3b79a)</samp>](https://github.com/sam-goodwin/alchemy/commit/3b79a49a)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Fallback to console if no scope is available &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/sam-goodwin/alchemy/issues/325 [<samp>(34e0a)</samp>](https://github.com/sam-goodwin/alchemy/commit/34e0aa8b)
- Log tasks in destroy &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(f2465)</samp>](https://github.com/sam-goodwin/alchemy/commit/f2465b42)
- Use logical OR operator for BRANCH_PREFIX fallback &nbsp;-&nbsp; by **Sam Goodwin** and **sam-goodwin** in https://github.com/sam-goodwin/alchemy/issues/327 [<samp>(66990)</samp>](https://github.com/sam-goodwin/alchemy/commit/66990e81)
- **aws**:
  - Include output attributes in generated resource types &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/322 [<samp>(b87b3)</samp>](https://github.com/sam-goodwin/alchemy/commit/b87b3560)
- **cloudflare**:
  - Filter duplicate compat flags &nbsp;-&nbsp; by **NickBlow** in https://github.com/sam-goodwin/alchemy/issues/300 [<samp>(5d53c)</samp>](https://github.com/sam-goodwin/alchemy/commit/5d53c52f)
  - Error on R2Bucket name change during update &nbsp;-&nbsp; in https://github.com/sam-goodwin/alchemy/issues/246 [<samp>(640d7)</samp>](https://github.com/sam-goodwin/alchemy/commit/640d71ed)
- **telemetry**:
  - Remove file buffer to resolve "enoent" error &nbsp;-&nbsp; by **John Royal** in https://github.com/sam-goodwin/alchemy/issues/333 [<samp>(eb8e5)</samp>](https://github.com/sam-goodwin/alchemy/commit/eb8e5f59)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.25.0...v0.26.0)

---

## v0.25.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- **cloudflare**: Add getZoneByDomain function &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/313 [<samp>(17f55)</samp>](https://github.com/sam-goodwin/alchemy/commit/17f558b8)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **aws**: Update fast-json-patch import for Node.js compatibility &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/316 [<samp>(d0ea5)</samp>](https://github.com/sam-goodwin/alchemy/commit/d0ea5a6c)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.24.1...v0.25.0)

---

## v0.24.1

### &nbsp;&nbsp;&nbsp;🚀 Features

- **cloudflare**:
  - DOFS state store &nbsp;-&nbsp; by **John Royal** in https://github.com/sam-goodwin/alchemy/issues/266 [<samp>(19dea)</samp>](https://github.com/sam-goodwin/alchemy/commit/19deabd)
  - Support binding to an external worker by name &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/280 [<samp>(383e4)</samp>](https://github.com/sam-goodwin/alchemy/commit/383e420)
  - Allow skipping or memoizing build in Website &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/281 [<samp>(087b2)</samp>](https://github.com/sam-goodwin/alchemy/commit/087b2f0)
- **fs**:
  - Allow overriding .alchemy dir &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/274 [<samp>(24896)</samp>](https://github.com/sam-goodwin/alchemy/commit/2489642)
- **stripe**:
  - Implement 10 missing Stripe resources for terraform parity &nbsp;-&nbsp; in https://github.com/sam-goodwin/alchemy/issues/251 [<samp>(c938b)</samp>](https://github.com/sam-goodwin/alchemy/commit/c938be6)
  - Add adoption pattern to all Stripe resources &nbsp;-&nbsp; in https://github.com/sam-goodwin/alchemy/issues/275 [<samp>(18ae6)</samp>](https://github.com/sam-goodwin/alchemy/commit/18ae67a)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.24.0...v0.24.1)

---

## v0.24.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- **cloudflare**: Add dead letter queue support to Cloudflare Queue &nbsp;-&nbsp; in https://github.com/sam-goodwin/alchemy/issues/243 [<samp>(bdd12)</samp>](https://github.com/sam-goodwin/alchemy/commit/bdd12e1)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **aws**: AWS Control API type generation &nbsp;-&nbsp; by **Tyler van Hensbergen** in https://github.com/sam-goodwin/alchemy/issues/265 [<samp>(12835)</samp>](https://github.com/sam-goodwin/alchemy/commit/12835a2)
- **cloudflare**: Version Metadata Type Mapping &nbsp;-&nbsp; in https://github.com/sam-goodwin/alchemy/issues/252 [<samp>(32035)</samp>](https://github.com/sam-goodwin/alchemy/commit/32035e3)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.23.0...v0.24.0)

---

## v0.23.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- **aws**:
  - SSMParameter &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(3202a)</samp>](https://github.com/sam-goodwin/alchemy/commit/3202a51)
- **cloudflare**:
  - Implement Cloudflare Version Metadata binding &nbsp;-&nbsp; in https://github.com/sam-goodwin/alchemy/issues/240 [<samp>(de057)</samp>](https://github.com/sam-goodwin/alchemy/commit/de05723)
  - Support cross-binding to Workflow &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/254 [<samp>(abaea)</samp>](https://github.com/sam-goodwin/alchemy/commit/abaeae7)
  - Default Worker.url to true &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/255 [<samp>(d9403)</samp>](https://github.com/sam-goodwin/alchemy/commit/d94031a)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Export analytics engine dataset binding from cloudflare &nbsp;-&nbsp; by **Oliver Stenbom** in https://github.com/sam-goodwin/alchemy/issues/267 [<samp>(2f79e)</samp>](https://github.com/sam-goodwin/alchemy/commit/2f79e9e)
- **aws**:
  - Include types.d.ts file in lib &nbsp;-&nbsp; by **Tyler van Hensbergen** in https://github.com/sam-goodwin/alchemy/issues/264 [<samp>(47bc4)</samp>](https://github.com/sam-goodwin/alchemy/commit/47bc4d3)
  - Include typeName when destroying Cloud Control Resources &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/256 [<samp>(cb4b9)</samp>](https://github.com/sam-goodwin/alchemy/commit/cb4b966)
- **cloudflare**:
  - Always write wrangler.json &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(b1830)</samp>](https://github.com/sam-goodwin/alchemy/commit/b183081)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.22.3...v0.23.0)

---

## v0.22.4

### &nbsp;&nbsp;&nbsp;🚀 Features

- **cloudflare**: Implement Cloudflare Version Metadata binding &nbsp;-&nbsp; in https://github.com/sam-goodwin/alchemy/issues/240 [<samp>(de057)</samp>](https://github.com/sam-goodwin/alchemy/commit/de05723)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**: Always write wrangler.json &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(b1830)</samp>](https://github.com/sam-goodwin/alchemy/commit/b183081)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.22.3...v0.22.4)
---
## v0.22.3

### &nbsp;&nbsp;&nbsp;🚀 Features

- **cloudflare**: Worker supports noBundle to upload multiple modules &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/238 [<samp>(672e5)</samp>](https://github.com/sam-goodwin/alchemy/commit/672e508)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.22.2...v0.22.3)
---
## v0.22.2

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**: Always write wrangler.json &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/235 [<samp>(3c8b4)</samp>](https://github.com/sam-goodwin/alchemy/commit/3c8b4e8)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.22.1...v0.22.2)
---
## v0.22.1

### &nbsp;&nbsp;&nbsp;🚀 Features

- **cloudflare**: Bundle wasm modules &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/231 [<samp>(df72e)</samp>](https://github.com/sam-goodwin/alchemy/commit/df72e58)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**: Pass through custom loaders to bundleWorker &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(fca7c)</samp>](https://github.com/sam-goodwin/alchemy/commit/fca7cba)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.22.0...v0.22.1)
---
## v0.22.0

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**: React Router and generate Website's wrangler.json before build &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/225 [<samp>(e44e5)</samp>](https://github.com/sam-goodwin/alchemy/commit/e44e5b4)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.21.0...v0.22.0)
---
## v0.21.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- **cloudflare**:
  - Determine DO class migrations using server-side state &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/222 [<samp>(d7c0d)</samp>](https://github.com/sam-goodwin/alchemy/commit/d7c0d2c)
  - Worker RPC binding types &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/223 [<samp>(05535)</samp>](https://github.com/sam-goodwin/alchemy/commit/055354c)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.20.1...v0.21.0)
---
## v0.20.1

### &nbsp;&nbsp;&nbsp;🚀 Features

- **cloudflare**: Support binding to a DO hosted in another Worker &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/219 [<samp>(4d8ac)</samp>](https://github.com/sam-goodwin/alchemy/commit/4d8ac51)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.20.0...v0.20.1)
---
## v0.20.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- **cloudflare**: Durable Object RPC types &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/212 [<samp>(78bab)</samp>](https://github.com/sam-goodwin/alchemy/commit/78bab20)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Better documentation for missing Secret password &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/211 [<samp>(78c2a)</samp>](https://github.com/sam-goodwin/alchemy/commit/78c2ab3)
- **cloudflare**:
  - Do not include eventSources when uploading stub worker during delete phase &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/216 [<samp>(c8fb3)</samp>](https://github.com/sam-goodwin/alchemy/commit/c8fb357)
  - Do not polyfill non-node.js modules &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/214 [<samp>(423e8)</samp>](https://github.com/sam-goodwin/alchemy/commit/423e8ca)
  - Improve error message when failing to resolve Cloudflare Account ID &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/213 [<samp>(15c9a)</samp>](https://github.com/sam-goodwin/alchemy/commit/15c9adc)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.19.0...v0.20.0)
---
## v0.19.0

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**: Default Website.wrangler to true &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/210 [<samp>(b8b29)</samp>](https://github.com/sam-goodwin/alchemy/commit/b8b29b4)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.18.0...v0.19.0)
---
## v0.18.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- Add AWS Cloud Control API support &nbsp;-&nbsp; by **Naor Peled** in https://github.com/sam-goodwin/alchemy/issues/132 [<samp>(08d3a)</samp>](https://github.com/sam-goodwin/alchemy/commit/08d3a17)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.17.2...v0.18.0)
---
## v0.17.2

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **vercel**: Do not patch name or resourceConfig in Project &nbsp;-&nbsp; by **Eric Clemmons** in https://github.com/sam-goodwin/alchemy/issues/206 [<samp>(7d2c8)</samp>](https://github.com/sam-goodwin/alchemy/commit/7d2c8d5)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.17.1...v0.17.2)
---
## v0.17.1

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**: Set d1 read replication on create &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/204 [<samp>(c3aee)</samp>](https://github.com/sam-goodwin/alchemy/commit/c3aee63)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.17.0...v0.17.1)
---
## v0.17.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- Bootstrap &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/169 [<samp>(78603)</samp>](https://github.com/sam-goodwin/alchemy/commit/78603bb)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.16.10...v0.17.0)
---
## v0.16.10

### &nbsp;&nbsp;&nbsp;🚀 Features

- **cloudflare**: Cloudflare workers analytics engine binding &nbsp;-&nbsp; by **Oliver Stenbom** in https://github.com/sam-goodwin/alchemy/issues/187 [<samp>(be2cb)</samp>](https://github.com/sam-goodwin/alchemy/commit/be2cb82)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- VercelProject 400 with gitRepository &nbsp;-&nbsp; by **Eric Clemmons** in https://github.com/sam-goodwin/alchemy/issues/202 [<samp>(d0f1a)</samp>](https://github.com/sam-goodwin/alchemy/commit/d0f1ae7)
- **cloudflare**:
  - Pass cwd to Exec in Website &nbsp;-&nbsp; by **Nick Balestra-Foster** in https://github.com/sam-goodwin/alchemy/issues/196 [<samp>(a0437)</samp>](https://github.com/sam-goodwin/alchemy/commit/a043730)
  - Write cron triggers to wrangler.json &nbsp;-&nbsp; by **sam** and **Jonas Templestein** in https://github.com/sam-goodwin/alchemy/issues/203 [<samp>(74208)</samp>](https://github.com/sam-goodwin/alchemy/commit/7420885)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.16.9...v0.16.10)
---
## v0.16.9

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**: Allow no-op update of vectorize index and metadata index &nbsp;-&nbsp; by **sam** in https://github.com/sam-goodwin/alchemy/issues/198 [<samp>(de74c)</samp>](https://github.com/sam-goodwin/alchemy/commit/de74c4c)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.16.8...v0.16.9)
---
## v0.16.8

### &nbsp;&nbsp;&nbsp;🚀 Features

- **vercel**: Add Project and ProjectDomain Resources &nbsp;-&nbsp; by **Eric Clemmons** in https://github.com/sam-goodwin/alchemy/issues/191 [<samp>(67692)</samp>](https://github.com/sam-goodwin/alchemy/commit/67692ab)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.16.7...v0.16.8)
---
## v0.16.7

### &nbsp;&nbsp;&nbsp;🚀 Features

- **cloudflare**: Add Cloudflare AccountId resource &nbsp;-&nbsp; by **Andrew Jefferson** and **Bun Peek** in https://github.com/sam-goodwin/alchemy/issues/195 [<samp>(bf037)</samp>](https://github.com/sam-goodwin/alchemy/commit/bf037e9)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**:
  - Open up policy and scope types for AccountApiToken &nbsp;-&nbsp; by **sam** in https://github.com/sam-goodwin/alchemy/issues/194 [<samp>(ab27b)</samp>](https://github.com/sam-goodwin/alchemy/commit/ab27bac)
  - Update vectorize_indexes to vectorize in wrangler.json.ts &nbsp;-&nbsp; by **Ryan Mierzejewski** in https://github.com/sam-goodwin/alchemy/issues/197 [<samp>(deb7e)</samp>](https://github.com/sam-goodwin/alchemy/commit/deb7ed1)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.16.6...v0.16.7)
---
## v0.16.6

### &nbsp;&nbsp;&nbsp;🚀 Features

- **sentry**: Team, Project, ClientKey &nbsp;-&nbsp; by **Eric Clemmons** in https://github.com/sam-goodwin/alchemy/issues/190 [<samp>(94814)</samp>](https://github.com/sam-goodwin/alchemy/commit/9481450)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.16.5...v0.16.6)
---
## v0.16.5

### &nbsp;&nbsp;&nbsp;🚀 Features

- **cloudflare**: Allow binding to a KV namespace by UUID &nbsp;-&nbsp; by **sam** in https://github.com/sam-goodwin/alchemy/issues/188 [<samp>(e3fc3)</samp>](https://github.com/sam-goodwin/alchemy/commit/e3fc34b)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.16.4...v0.16.5)
---
## v0.16.4

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Alchemy.run throws exception when phase === "read" &nbsp;-&nbsp; by **Eric Clemmons** in https://github.com/sam-goodwin/alchemy/issues/184 [<samp>(753b8)</samp>](https://github.com/sam-goodwin/alchemy/commit/753b889)
- **cloudflare**: Default to ./dist/client for Vite.js &nbsp;-&nbsp; by **sam** in https://github.com/sam-goodwin/alchemy/issues/182 [<samp>(5e470)</samp>](https://github.com/sam-goodwin/alchemy/commit/5e470c4)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.16.3...v0.16.4)
---
## v0.16.3

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**: Allow D1 update read replication mode when primary location hint is explcitly set &nbsp;-&nbsp; by **sam** in https://github.com/sam-goodwin/alchemy/issues/181 [<samp>(9a87b)</samp>](https://github.com/sam-goodwin/alchemy/commit/9a87b2f)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.16.2...v0.16.3)
---
## v0.16.2

### &nbsp;&nbsp;&nbsp;🚀 Features

- **os**: Memoize exec from file patterns &nbsp;-&nbsp; by **John Royal** in https://github.com/sam-goodwin/alchemy/issues/180 [<samp>(fd737)</samp>](https://github.com/sam-goodwin/alchemy/commit/fd73742)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.16.1...v0.16.2)
---
## v0.16.1

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Move core Resource properties to Symbols &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/177 [<samp>(500e2)</samp>](https://github.com/sam-goodwin/alchemy/commit/500e22f)
- **cloudflare**: Use Worker name for Worker to Worker binding &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/178 [<samp>(fbc9a)</samp>](https://github.com/sam-goodwin/alchemy/commit/fbc9a77)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.16.0...v0.16.1)
---
## v0.16.0

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Do not always write a Scope and validate READ phase &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/176 [<samp>(2e135)</samp>](https://github.com/sam-goodwin/alchemy/commit/2e1352f)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.15.14...v0.16.0)
---
## v0.15.14

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Scope.phase is undefined when initializing stateStore &nbsp;-&nbsp; by **Eric Clemmons** in https://github.com/sam-goodwin/alchemy/issues/173 [<samp>(963a3)</samp>](https://github.com/sam-goodwin/alchemy/commit/963a37b)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.15.13...v0.15.14)
---
## v0.15.13

### &nbsp;&nbsp;&nbsp;🚀 Features

- **upstash**: Add alchemy/upstash with UpstashRedis Resource &nbsp;-&nbsp; by **Eric Clemmons** [<samp>(0f26f)</samp>](https://github.com/sam-goodwin/alchemy/commit/0f26fad)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.15.12...v0.15.13)
---
## v0.15.12

### &nbsp;&nbsp;&nbsp;🚀 Features

- **cloudflare**: Auto-resolve permission group IDs in AccountApiToken and simplify interface &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/171 [<samp>(f5e07)</samp>](https://github.com/sam-goodwin/alchemy/commit/f5e0751)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.15.11...v0.15.12)
---
## v0.15.11

### &nbsp;&nbsp;&nbsp;🚀 Features

- **cloudflare**: Clone D1 Database &nbsp;-&nbsp; by **sam** in https://github.com/sam-goodwin/alchemy/issues/170 [<samp>(b7da2)</samp>](https://github.com/sam-goodwin/alchemy/commit/b7da276)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.15.10...v0.15.11)
---
## v0.15.10

### &nbsp;&nbsp;&nbsp;🚀 Features

- Add Lookup Key to Stripe Price &nbsp;-&nbsp; by **NickBlow** in https://github.com/sam-goodwin/alchemy/issues/162 [<samp>(7f7a1)</samp>](https://github.com/sam-goodwin/alchemy/commit/7f7a18d)
- **aws**: Support lambda layers in aws/Function &nbsp;-&nbsp; by **Austin Blythe** in https://github.com/sam-goodwin/alchemy/issues/161 [<samp>(329c1)</samp>](https://github.com/sam-goodwin/alchemy/commit/329c1da)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.15.9...v0.15.10)
---
## v0.15.9

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**: Include workflows in wrangler.json &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/160 [<samp>(9bb74)</samp>](https://github.com/sam-goodwin/alchemy/commit/9bb74ba)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.15.8...v0.15.9)
---
## v0.15.8

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**: Mark cloudflare:workflows as external &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/159 [<samp>(5146d)</samp>](https://github.com/sam-goodwin/alchemy/commit/5146d5f)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.15.7...v0.15.8)
---
## v0.15.7

### &nbsp;&nbsp;&nbsp;🚀 Features

- **stripe**: Meter Resource &nbsp;-&nbsp; by **NickBlow** in https://github.com/sam-goodwin/alchemy/issues/155 [<samp>(ff080)</samp>](https://github.com/sam-goodwin/alchemy/commit/ff08054)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.15.6...v0.15.7)
---
## v0.15.6

### &nbsp;&nbsp;&nbsp;🚀 Features

- **cloudflare**:
  - `adopt` and `delete` switches for KV namespace &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/153 [<samp>(60236)</samp>](https://github.com/sam-goodwin/alchemy/commit/602369f)
  - Route resource &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/154 [<samp>(55ec3)</samp>](https://github.com/sam-goodwin/alchemy/commit/55ec3da)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**: Include migrations for DOs new_classes and new_sqlite_classes in generated wrangler.json &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/156 [<samp>(eed04)</samp>](https://github.com/sam-goodwin/alchemy/commit/eed044b)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.15.5...v0.15.6)
---
## v0.15.5

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**:
  - Add preview_* properties to wrangler json type &nbsp;-&nbsp; by **Eric Clemmons** in https://github.com/sam-goodwin/alchemy/issues/129 [<samp>(66f01)</samp>](https://github.com/sam-goodwin/alchemy/commit/66f012f)
  - Use worker name for self binding &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(bf300)</samp>](https://github.com/sam-goodwin/alchemy/commit/bf300d4)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.15.4...v0.15.5)
---
## v0.15.4

### &nbsp;&nbsp;&nbsp;🚀 Features

- **cloudflare**: Allow binding a Worker to itself &nbsp;-&nbsp; by **sam** in https://github.com/sam-goodwin/alchemy/issues/151 [<samp>(e0d50)</samp>](https://github.com/sam-goodwin/alchemy/commit/e0d50ae)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**: Do not apply new_class_migration to a Workflow &nbsp;-&nbsp; by **sam** in https://github.com/sam-goodwin/alchemy/issues/152 [<samp>(b5d9f)</samp>](https://github.com/sam-goodwin/alchemy/commit/b5d9f73)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.15.3...v0.15.4)
---
## v0.15.3

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- CF_ACCOUNT_ID and include status code in CloudflareApiError &nbsp;-&nbsp; by **sam** in https://github.com/sam-goodwin/alchemy/issues/141 [<samp>(26a66)</samp>](https://github.com/sam-goodwin/alchemy/commit/26a6656)
- Support resolving account ID for account access token &nbsp;-&nbsp; by **sam** in https://github.com/sam-goodwin/alchemy/issues/142 [<samp>(ae143)</samp>](https://github.com/sam-goodwin/alchemy/commit/ae14370)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.15.2...v0.15.3)
---
## v0.15.2

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- CreateRequire if require is not defined &nbsp;-&nbsp; by **sam** in https://github.com/sam-goodwin/alchemy/issues/139 [<samp>(d96dd)</samp>](https://github.com/sam-goodwin/alchemy/commit/d96dd0f)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.15.1...v0.15.2)
---
## v0.15.1

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**: Use / as delimiter when listing in r2 rest state store &nbsp;-&nbsp; by **sam** in https://github.com/sam-goodwin/alchemy/issues/138 [<samp>(57a45)</samp>](https://github.com/sam-goodwin/alchemy/commit/57a4584)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.15.0...v0.15.1)
---
## v0.15.0

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Propagate state store to nested scopes &nbsp;-&nbsp; by **sam** in https://github.com/sam-goodwin/alchemy/issues/136 [<samp>(a52a4)</samp>](https://github.com/sam-goodwin/alchemy/commit/a52a438)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.14.1...v0.15.0)
---
## v0.14.1

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **aws**: Parse Function handler properly &nbsp;-&nbsp; by **sam** in https://github.com/sam-goodwin/alchemy/issues/137 [<samp>(b9c15)</samp>](https://github.com/sam-goodwin/alchemy/commit/b9c15eb)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.14.0...v0.14.1)
---
## v0.14.0

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Respect CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN &nbsp;-&nbsp; by **sam** in https://github.com/sam-goodwin/alchemy/issues/133 [<samp>(c81b8)</samp>](https://github.com/sam-goodwin/alchemy/commit/c81b813)
- **cloudflare**: Align with wrangler bundling for v1, aliases, als &nbsp;-&nbsp; by **sam** in https://github.com/sam-goodwin/alchemy/issues/125 [<samp>(46758)</samp>](https://github.com/sam-goodwin/alchemy/commit/4675892)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.13.0...v0.14.0)
---
## v0.13.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- Read phase for reconstructing state without applying changes &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/128 [<samp>(4f8b8)</samp>](https://github.com/sam-goodwin/alchemy/commit/4f8b8da)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.12.21...v0.13.0)
---
## v0.12.21

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- .js import of dedent &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(7b9ff)</samp>](https://github.com/sam-goodwin/alchemy/commit/7b9ff3c)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.12.20...v0.12.21)
---
## v0.12.20

*No significant changes*

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.12.19...v0.12.20)
---
## v0.12.19

### &nbsp;&nbsp;&nbsp;🚀 Features

- Neon now supports pg 17, make 16 default &nbsp;-&nbsp; by **Ryan Mierzejewski** in https://github.com/sam-goodwin/alchemy/issues/122 [<samp>(ec95a)</samp>](https://github.com/sam-goodwin/alchemy/commit/ec95a77)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**: Polyfill node apis with unenv &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/123 [<samp>(709a3)</samp>](https://github.com/sam-goodwin/alchemy/commit/709a381)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.12.18...v0.12.19)
---
## v0.12.18

### &nbsp;&nbsp;&nbsp;🚀 Features

- **cloudflare**: Ai binding &nbsp;-&nbsp; by **sam** in https://github.com/sam-goodwin/alchemy/issues/121 [<samp>(48bf9)</samp>](https://github.com/sam-goodwin/alchemy/commit/48bf9a9)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.12.17...v0.12.18)
---
## v0.12.17

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Export serde &nbsp;-&nbsp; by **Eric Clemmons** [<samp>(1fe7d)</samp>](https://github.com/sam-goodwin/alchemy/commit/1fe7d8a)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.12.16...v0.12.17)
---
## v0.12.16

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**: Output 'browser' binding to wrangler.jsonc &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/113 [<samp>(6e139)</samp>](https://github.com/sam-goodwin/alchemy/commit/6e1399b)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.12.15...v0.12.16)
---
## v0.12.15

### &nbsp;&nbsp;&nbsp;🚀 Features

- **cloudflare**:
  - BrowserRendering &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/110 [<samp>(3caad)</samp>](https://github.com/sam-goodwin/alchemy/commit/3caad13)
  - Support disabling deletion of Cloudflare Zone &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/111 [<samp>(3c8c4)</samp>](https://github.com/sam-goodwin/alchemy/commit/3c8c4f7)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.12.14...v0.12.15)
---
## v0.12.14

### &nbsp;&nbsp;&nbsp;🚀 Features

- Export Bindings.Runtime and Bound &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(2e469)</samp>](https://github.com/sam-goodwin/alchemy/commit/2e469f1)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.12.13...v0.12.14)
---
## v0.12.13

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Export AlchemyOptions from root &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(bc365)</samp>](https://github.com/sam-goodwin/alchemy/commit/bc3657f)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.12.12...v0.12.13)
---
## v0.12.12

### &nbsp;&nbsp;&nbsp;🚀 Features

- WranglerJson returns `spec` for re-use &nbsp;-&nbsp; by **Eric Clemmons** in https://github.com/sam-goodwin/alchemy/issues/107 [<samp>(70fe7)</samp>](https://github.com/sam-goodwin/alchemy/commit/70fe7be)
- **cloudflare**: Default R2RestStateStore bucketName to alchemy-state &nbsp;-&nbsp; by **Eric Clemmons** in https://github.com/sam-goodwin/alchemy/issues/102 [<samp>(99f0b)</samp>](https://github.com/sam-goodwin/alchemy/commit/99f0b5d)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Website bundling for all frameworks and add smoke tests &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/99 [<samp>(29c6a)</samp>](https://github.com/sam-goodwin/alchemy/commit/29c6aa6)
- Exec should throw on non-zero exit code &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/106 [<samp>(0a6eb)</samp>](https://github.com/sam-goodwin/alchemy/commit/0a6eb17)
- **os**: Pipe exec stdout and stderr &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(be927)</samp>](https://github.com/sam-goodwin/alchemy/commit/be9279b)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.12.9...v0.12.12)
---
## v0.12.9

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- R2 rest state store list &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/98 [<samp>(ca36c)</samp>](https://github.com/sam-goodwin/alchemy/commit/ca36cc6)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.12.8...v0.12.9)
---
## v0.12.8

### &nbsp;&nbsp;&nbsp;🚀 Features

- Default Worker and D1 names to id &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/93 [<samp>(058e9)</samp>](https://github.com/sam-goodwin/alchemy/commit/058e938)
- **cloudflare**: Configure QueueConsumer for Worker &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/96 [<samp>(5eb91)</samp>](https://github.com/sam-goodwin/alchemy/commit/5eb91e5)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.12.7...v0.12.8)
---
## v0.12.7

### &nbsp;&nbsp;&nbsp;🚀 Features

- Cloudflare Hyperdrive & Neon Project &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/87 [<samp>(a3a79)</samp>](https://github.com/sam-goodwin/alchemy/commit/a3a79d5)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.12.6...v0.12.7)
---
## v0.12.6

### &nbsp;&nbsp;&nbsp;🚀 Features

- Worker cron triggers &nbsp;-&nbsp; by **Jake Correa** in https://github.com/sam-goodwin/alchemy/issues/86 [<samp>(191db)</samp>](https://github.com/sam-goodwin/alchemy/commit/191dbc3)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.12.5...v0.12.6)
---
## v0.12.5

### &nbsp;&nbsp;&nbsp;🚀 Features

- **cloudflare**: AI Gateway &nbsp;-&nbsp; by **Murzin Artem** [<samp>(a0b8e)</samp>](https://github.com/sam-goodwin/alchemy/commit/a0b8e23)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.12.4...v0.12.5)
---
## v0.12.4

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Add .js suffix to imports and node:* external to Website &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/84 [<samp>(a9be8)</samp>](https://github.com/sam-goodwin/alchemy/commit/a9be80e)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.12.3...v0.12.4)
---
## v0.12.3

### &nbsp;&nbsp;&nbsp;🚀 Features

- Add Nuxt site with CF Pipeline example &nbsp;-&nbsp; by **Murzin Artem** [<samp>(9351d)</samp>](https://github.com/sam-goodwin/alchemy/commit/9351d2c)
- **cloudflare**: Redwood website &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/83 [<samp>(4d7d9)</samp>](https://github.com/sam-goodwin/alchemy/commit/4d7d960)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.12.2...v0.12.3)
---
## v0.12.2

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Tanstack start create wrangler.jsonc, add externals and shim cloudflare:workers during dev &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/82 [<samp>(2d586)</samp>](https://github.com/sam-goodwin/alchemy/commit/2d586da)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.12.1...v0.12.2)
---
## v0.12.1

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Respect 'main' property in Website &nbsp;-&nbsp; by **sam** in https://github.com/sam-goodwin/alchemy/issues/81 [<samp>(de243)</samp>](https://github.com/sam-goodwin/alchemy/commit/de243e2)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.12.0...v0.12.1)
---
## v0.12.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- Generic Website & TanStackStart, Vite variants &nbsp;-&nbsp; by **sam** in https://github.com/sam-goodwin/alchemy/issues/78 [<samp>(3d892)</samp>](https://github.com/sam-goodwin/alchemy/commit/3d892de)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.11.4...v0.12.0)
---
## v0.11.4

### &nbsp;&nbsp;&nbsp;🚀 Features

- **cloudflare**: Support configuring Worker Asset Config &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/74 [<samp>(3f593)</samp>](https://github.com/sam-goodwin/alchemy/commit/3f593d5)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.11.3...v0.11.4)
---
## v0.11.3

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Respect assets property in ViteSite &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/75 [<samp>(39b35)</samp>](https://github.com/sam-goodwin/alchemy/commit/39b350f)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.11.2...v0.11.3)
---
## v0.11.2

### &nbsp;&nbsp;&nbsp;🚀 Features

- Add invokemode to aws function &nbsp;-&nbsp; by **Nick Balestra-Foster** in https://github.com/sam-goodwin/alchemy/issues/73 [<samp>(73cca)</samp>](https://github.com/sam-goodwin/alchemy/commit/73cca76)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.11.1...v0.11.2)
---
## v0.11.1

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**:
  - Add `migrations_dir` in wrangler.json if defined in D1Database &nbsp;-&nbsp; by **Simon Depelchin** in https://github.com/sam-goodwin/alchemy/issues/71 [<samp>(71b40)</samp>](https://github.com/sam-goodwin/alchemy/commit/71b40cc)
  - Support non-existing config files &nbsp;-&nbsp; by **Simon Depelchin** in https://github.com/sam-goodwin/alchemy/issues/72 [<samp>(b58bb)</samp>](https://github.com/sam-goodwin/alchemy/commit/b58bbdb)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.11.0...v0.11.1)
---
## v0.11.0

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Operator precedence in test.yml environment selection &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(e0f8a)</samp>](https://github.com/sam-goodwin/alchemy/commit/e0f8a84)
- In-memory bundle and update aws/Function to accept bundle instead of zipPath &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/70 [<samp>(21db7)</samp>](https://github.com/sam-goodwin/alchemy/commit/21db776)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.10.3...v0.11.0)
---
## v0.10.3

*No significant changes*

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.10.2...v0.10.3)
---
## v0.10.2

*No significant changes*

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.10.1...v0.10.2)
---
## v0.10.1

*No significant changes*

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.10.0...v0.10.1)
---
## v0.10.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- Github repository environment and secrets &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/61 [<samp>(260a0)</samp>](https://github.com/sam-goodwin/alchemy/commit/260a091)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.9.2...v0.10.0)
---
## v0.9.2

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Lambda function url &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/58 [<samp>(31cc8)</samp>](https://github.com/sam-goodwin/alchemy/commit/31cc81e)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.9.1...v0.9.2)
---
## v0.9.1

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Add d1_databases to wrangler.json spec &nbsp;-&nbsp; by **Simon Depelchin** in https://github.com/sam-goodwin/alchemy/issues/57 [<samp>(f90ae)</samp>](https://github.com/sam-goodwin/alchemy/commit/f90aeb9)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.9.0...v0.9.1)
---
## v0.9.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- Cloudflare vite site &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/55 [<samp>(df6f3)</samp>](https://github.com/sam-goodwin/alchemy/commit/df6f353)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.8.1...v0.9.0)
---
## v0.8.1

### &nbsp;&nbsp;&nbsp;🚀 Features

- Cloudflare vectorize index and metadata index &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/54 [<samp>(4ee7b)</samp>](https://github.com/sam-goodwin/alchemy/commit/4ee7bab)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.8.0...v0.8.1)
---
## v0.8.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- Support TanStack Start &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/53 [<samp>(2fba8)</samp>](https://github.com/sam-goodwin/alchemy/commit/2fba851)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Harden retry logic of aws dynamodb table &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/52 [<samp>(be3ca)</samp>](https://github.com/sam-goodwin/alchemy/commit/be3ca9f)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.7.3...v0.8.0)
---
## v0.7.3

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Configure .json and .sql loader options in Worker esbuild &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/51 [<samp>(8811e)</samp>](https://github.com/sam-goodwin/alchemy/commit/8811e9c)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.7.2...v0.7.3)
---
## v0.7.2

### &nbsp;&nbsp;&nbsp;🚀 Features

- Cloudflare pipelines and bindings &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/50 [<samp>(cdc8c)</samp>](https://github.com/sam-goodwin/alchemy/commit/cdc8cd8)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.7.1...v0.7.2)
---
## v0.7.1

### &nbsp;&nbsp;&nbsp;🚀 Features

- Generate wrangler.json for local dev &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/47 [<samp>(b5fa1)</samp>](https://github.com/sam-goodwin/alchemy/commit/b5fa185)
- Implement D1 database and bindings &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/48 [<samp>(d5320)</samp>](https://github.com/sam-goodwin/alchemy/commit/d5320c6)
- Cloudflare queue resource and bindings &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/49 [<samp>(f412f)</samp>](https://github.com/sam-goodwin/alchemy/commit/f412f45)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.7.0...v0.7.1)
---
## v0.7.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- Cloudflare workflow &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/46 [<samp>(4c667)</samp>](https://github.com/sam-goodwin/alchemy/commit/4c66739)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Remove 404 pages for concepts, guides and providers pages &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(6f17b)</samp>](https://github.com/sam-goodwin/alchemy/commit/6f17b02)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.6.0...v0.7.0)
---
## v0.6.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- Support OAuth wrangler login &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/45 [<samp>(7b35c)</samp>](https://github.com/sam-goodwin/alchemy/commit/7b35c46)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.5.2...v0.6.0)
---
## v0.5.2

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Export type Scope &nbsp;-&nbsp; by **Cole Lawrence** in https://github.com/sam-goodwin/alchemy/issues/43 [<samp>(457b3)</samp>](https://github.com/sam-goodwin/alchemy/commit/457b33f)
- Retry transient network failures in cloudflare API &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/44 [<samp>(850ab)</samp>](https://github.com/sam-goodwin/alchemy/commit/850ab59)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.5.1...v0.5.2)
---
## v0.5.1

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Opt-in to empty R2 bucket and document CF credentials in Guide &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/42 [<samp>(0d274)</samp>](https://github.com/sam-goodwin/alchemy/commit/0d27415)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.5.0...v0.5.1)
---
## v0.5.0

*No significant changes*

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.4.1...v0.5.0)
---
## v0.4.1

### &nbsp;&nbsp;&nbsp;🚀 Features

- Assets resource & Worker Binding &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/40 [<samp>(bdfc2)</samp>](https://github.com/sam-goodwin/alchemy/commit/bdfc2f1)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Add exponential backoff in r2 rest store &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/39 [<samp>(3ef24)</samp>](https://github.com/sam-goodwin/alchemy/commit/3ef2476)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.4.0...v0.4.1)
---
## v0.4.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- Import DNS records and upload to Cloudflare &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/30 [<samp>(2a0c1)</samp>](https://github.com/sam-goodwin/alchemy/commit/2a0c18a)
- Astro component and static site &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/31 [<samp>(b3ef6)</samp>](https://github.com/sam-goodwin/alchemy/commit/b3ef678)
- R2 state store &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/33 [<samp>(934f3)</samp>](https://github.com/sam-goodwin/alchemy/commit/934f30f)
- Publish website &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/37 [<samp>(3b262)</samp>](https://github.com/sam-goodwin/alchemy/commit/3b262df)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Clean up empty bucket, account api token, access key &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/36 [<samp>(7cd42)</samp>](https://github.com/sam-goodwin/alchemy/commit/7cd4246)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.2.5...v0.4.0)
---
## v0.2.5

### &nbsp;&nbsp;&nbsp;🚀 Features

- Object -> data, generate website &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/27 [<samp>(305fc)</samp>](https://github.com/sam-goodwin/alchemy/commit/305fc1c)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.2.3...v0.2.5)
---
## v0.2.3

### &nbsp;&nbsp;&nbsp;🚀 Features

- Document Resource & Vitepress template &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/25 [<samp>(630ee)</samp>](https://github.com/sam-goodwin/alchemy/commit/630ee25)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.2.2...v0.2.3)
---
## v0.2.2

### &nbsp;&nbsp;&nbsp;🚀 Features

- Setup tailwind tanstack router and shadcn &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/24 [<samp>(26158)</samp>](https://github.com/sam-goodwin/alchemy/commit/261582d)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.2.1...v0.2.2)
---
## v0.2.1

### &nbsp;&nbsp;&nbsp;🚀 Features

- Cloudflare Zone resource &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/19 [<samp>(4bc03)</samp>](https://github.com/sam-goodwin/alchemy/commit/4bc03c7)
- Delete orphans during scope finalize &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/20 [<samp>(e7c1a)</samp>](https://github.com/sam-goodwin/alchemy/commit/e7c1ab4)
- Vitejs template resource &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/22 [<samp>(78e0d)</samp>](https://github.com/sam-goodwin/alchemy/commit/78e0db9)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Memoize logic by awaiting serialize &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/21 [<samp>(8c2e6)</samp>](https://github.com/sam-goodwin/alchemy/commit/8c2e64b)
- Detect error in scope and do not orphan resources &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/23 [<samp>(d9d6a)</samp>](https://github.com/sam-goodwin/alchemy/commit/d9d6aa9)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.2.0...v0.2.1)
---
## v0.2.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- Async Resources &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/17 [<samp>(a431f)</samp>](https://github.com/sam-goodwin/alchemy/commit/a431f2d)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Secret tests and compile errors in examples &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/16 [<samp>(17588)</samp>](https://github.com/sam-goodwin/alchemy/commit/175889f)
- CI &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/18 [<samp>(ab939)</samp>](https://github.com/sam-goodwin/alchemy/commit/ab939c0)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.1.18...v0.2.0)
---
## v0.1.18

### &nbsp;&nbsp;&nbsp;🚀 Features

- R2 bucket &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/13 [<samp>(92738)</samp>](https://github.com/sam-goodwin/alchemy/commit/927387b)
- Infer cloudflare env from Worker &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/14 [<samp>(0096b)</samp>](https://github.com/sam-goodwin/alchemy/commit/0096b2f)
- Encrypted secret in state with password &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/15 [<samp>(4128d)</samp>](https://github.com/sam-goodwin/alchemy/commit/4128d55)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Exports &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(37a56)</samp>](https://github.com/sam-goodwin/alchemy/commit/37a564f)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.1.16...v0.1.18)
---
## v0.1.16

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Log update/delete errors &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/12 [<samp>(3344a)</samp>](https://github.com/sam-goodwin/alchemy/commit/3344ab3)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.1.15...v0.1.16)
---
## v0.1.15

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Cloduflare-vite example &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(7b979)</samp>](https://github.com/sam-goodwin/alchemy/commit/7b97989)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.1.14...v0.1.15)
---
## v0.1.14

### &nbsp;&nbsp;&nbsp;🚀 Features

- Bindings as key-value pairs of KVNamespace &nbsp;-&nbsp; by ** Worker ** [<samp>( Dura)</samp>](https://github.com/sam-goodwin/alchemy/commit/ DurableObject )
- OIDC identity provider, GitHub CI/CD, GitHub Secret Resource &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/sam-goodwin/alchemy/issues/6 [<samp>(9c81a)</samp>](https://github.com/sam-goodwin/alchemy/commit/9c81a5a)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.1.13...v0.1.14)
---
## v0.1.13

### &nbsp;&nbsp;&nbsp;🚀 Features

- Enable observability for workers by default &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(3a630)</samp>](https://github.com/sam-goodwin/alchemy/commit/3a63075)
- Route to backend worker from static site handler &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(b2635)</samp>](https://github.com/sam-goodwin/alchemy/commit/b2635d0)
- Set environment on a CF worker &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(4a9cc)</samp>](https://github.com/sam-goodwin/alchemy/commit/4a9cceb)
- Allow routing from static site root &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(08bb2)</samp>](https://github.com/sam-goodwin/alchemy/commit/08bb2db)
- Print resource &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(a691f)</samp>](https://github.com/sam-goodwin/alchemy/commit/a691ffa)
- Callbacks and $ &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(a1630)</samp>](https://github.com/sam-goodwin/alchemy/commit/a1630c0)
- Durable object auto migration &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(7029b)</samp>](https://github.com/sam-goodwin/alchemy/commit/7029bfb)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Pass through quiet mode to apply in worker and static site &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(86990)</samp>](https://github.com/sam-goodwin/alchemy/commit/86990c7)
- Cloudflare:workers is external to bundle &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(6b474)</samp>](https://github.com/sam-goodwin/alchemy/commit/6b474e8)
- Memoize call to update for same resource instance &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(f59f6)</samp>](https://github.com/sam-goodwin/alchemy/commit/f59f608)
- Use new_sqlite_classes when sqlite: true &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(3840e)</samp>](https://github.com/sam-goodwin/alchemy/commit/3840e53)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.1.12...v0.1.13)
---
## v0.1.12

### &nbsp;&nbsp;&nbsp;🚀 Features

- Alchemy/aws/auto &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(097bc)</samp>](https://github.com/sam-goodwin/alchemy/commit/097bc99)
- Stripe webhook, product, price &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(b2472)</samp>](https://github.com/sam-goodwin/alchemy/commit/b247235)
- Cloudflare workers, kv namespaces, durable objects &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(05aa4)</samp>](https://github.com/sam-goodwin/alchemy/commit/05aa478)
- Cloudflare state store &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(447f1)</samp>](https://github.com/sam-goodwin/alchemy/commit/447f178)
- Aws ses &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(5daca)</samp>](https://github.com/sam-goodwin/alchemy/commit/5dacafc)
- **cloudflare**: Static site &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(a73ae)</samp>](https://github.com/sam-goodwin/alchemy/commit/a73ae7e)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Generate aws script &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(eee5a)</samp>](https://github.com/sam-goodwin/alchemy/commit/eee5ad3)
- Stripe/index.ts &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(ce648)</samp>](https://github.com/sam-goodwin/alchemy/commit/ce6481d)
- Compile and publish &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(20340)</samp>](https://github.com/sam-goodwin/alchemy/commit/203406e)
- Static site &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(18480)</samp>](https://github.com/sam-goodwin/alchemy/commit/1848043)
- Exports and resolved outputs &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(69927)</samp>](https://github.com/sam-goodwin/alchemy/commit/69927b1)
- **cloudflare**: Static site router &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(0b71c)</samp>](https://github.com/sam-goodwin/alchemy/commit/0b71c8f)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.1.4...v0.1.12)
---
## v0.1.4

### &nbsp;&nbsp;&nbsp;🚀 Features

- Aws resources and a re-worked Output chain &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(ce2e7)</samp>](https://github.com/sam-goodwin/alchemy/commit/ce2e71c)
- Apply working e2e &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(4bff4)</samp>](https://github.com/sam-goodwin/alchemy/commit/4bff4ee)
- Destroy a graph &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(66cb3)</samp>](https://github.com/sam-goodwin/alchemy/commit/66cb35b)
- Allow re-defining a resource by ID and calling apply to update it &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(79883)</samp>](https://github.com/sam-goodwin/alchemy/commit/79883a8)
- Pass through past output in ctx and use that to delete inline policies in Role &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(f65b0)</samp>](https://github.com/sam-goodwin/alchemy/commit/f65b081)
- Table creation, deletion and waiting for stabilization &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(57123)</samp>](https://github.com/sam-goodwin/alchemy/commit/571230a)
- Add an exponential backoff when creating a function to deal with IAM stabilization &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(2de18)</samp>](https://github.com/sam-goodwin/alchemy/commit/2de1808)
- Remove stack concept &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(b3515)</samp>](https://github.com/sam-goodwin/alchemy/commit/b3515db)
- Add alchemize for deploying all resources &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(b24a5)</samp>](https://github.com/sam-goodwin/alchemy/commit/b24a56f)
- Extract evaluate from apply &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(895f5)</samp>](https://github.com/sam-goodwin/alchemy/commit/895f5ef)
- Destroy orphaned resources &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(11a98)</samp>](https://github.com/sam-goodwin/alchemy/commit/11a9840)
- Remove stage global and instead accept an argument in alchemize/apply/destroy. &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(c0bd4)</samp>](https://github.com/sam-goodwin/alchemy/commit/c0bd434)
- Support providing stateStore in alchemize, apply, destroy &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(20cee)</samp>](https://github.com/sam-goodwin/alchemy/commit/20ceee9)
- Implement recursive delete &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(6d5b2)</samp>](https://github.com/sam-goodwin/alchemy/commit/6d5b2aa)
- Implement SQS Queue and record a demo fix: handle 60s timeout after queue deletion &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(f8ff8)</samp>](https://github.com/sam-goodwin/alchemy/commit/f8ff8db)
- Codegen agents and fixes to state store &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(05d3d)</samp>](https://github.com/sam-goodwin/alchemy/commit/05d3dd8)
- Tool to scrape web pages to inform requirements &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(f7dc0)</samp>](https://github.com/sam-goodwin/alchemy/commit/f7dc000)
- Skip update if inputs have not changed &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(fc099)</samp>](https://github.com/sam-goodwin/alchemy/commit/fc099e3)
- Implement scope for recursive IaC &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(27fdb)</samp>](https://github.com/sam-goodwin/alchemy/commit/27fdb2f)
- Recursive materialization &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(9e68a)</samp>](https://github.com/sam-goodwin/alchemy/commit/9e68a6b)
- Implement generator for aws CFN spec &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(4cb97)</samp>](https://github.com/sam-goodwin/alchemy/commit/4cb97b3)
- Use o3-mini to define requirements, implement with claude-3.5 sonnet &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(12d2a)</samp>](https://github.com/sam-goodwin/alchemy/commit/12d2a1a)
- Fallback to o3-mini if typescript errors can't be resolved &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(9ee87)</samp>](https://github.com/sam-goodwin/alchemy/commit/9ee874b)
- Include relevant terraform implementation in context &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(d3b2b)</samp>](https://github.com/sam-goodwin/alchemy/commit/d3b2ba9)
- E2e generation of cfn resources &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(40d3f)</samp>](https://github.com/sam-goodwin/alchemy/commit/40d3f98)
- Markdown driven programming &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(94762)</samp>](https://github.com/sam-goodwin/alchemy/commit/9476230)
- Quiet mode &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(5cc9c)</samp>](https://github.com/sam-goodwin/alchemy/commit/5cc9c4f)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Consolidate apply and evaluate &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(ed889)</samp>](https://github.com/sam-goodwin/alchemy/commit/ed889af)
- Throw error if role already exists when trying to create &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(bc543)</samp>](https://github.com/sam-goodwin/alchemy/commit/bc5433c)
- InvokeArn in lambda function &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(61453)</samp>](https://github.com/sam-goodwin/alchemy/commit/614534d)
- Broken link to table.ts &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(7ac5f)</samp>](https://github.com/sam-goodwin/alchemy/commit/7ac5fd6)
- Store tags on role and handle "already exists" after a crash &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(69427)</samp>](https://github.com/sam-goodwin/alchemy/commit/69427a2)
- .output location for tests &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(12055)</samp>](https://github.com/sam-goodwin/alchemy/commit/12055f5)
- Explicitly type the output of Table and Role &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(2717b)</samp>](https://github.com/sam-goodwin/alchemy/commit/2717bef)
- Input<array> and test PackageJson, TypeScriptConfig, etc. &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(9e347)</samp>](https://github.com/sam-goodwin/alchemy/commit/9e3475d)
- Compute scope path recursively using parent &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(4366d)</samp>](https://github.com/sam-goodwin/alchemy/commit/4366d9d)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/sam-goodwin/alchemy/compare/v0.0.0...v0.1.4)
---
