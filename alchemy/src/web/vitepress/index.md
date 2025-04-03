# Docs Index

```ts twoslash
// @noErrors
import path from "path";

import alchemy, { Resource, Context } from "alchemy";

import { Zone } from "alchemy/cloudflare";

type alchemy = any;

await using app = alchemy("github:alchemy", {
  //          ^?
  stage: "prod",
  phase: process.argv.includes("--destroy") ? "destroy" : "up",
  // pass the password in (you can get it from anywhere, e.g. stdin)
  password: process.env.SECRET_PASSPHRASE,
  quiet: process.argv.includes("--verbose") ? false : true,
});

export interface Product {}

export const Product = Resource(
  "stripe::Product",
  async function (
    this: Context<any>,
    id: string,
    props: any,
  ): Promise<Product> {
    this.
    //   ^|
  }
);
```

```ts twoslash
// @noErrors
// @esModuleInterop
import express from "express"
const app = {
  get(path: string, fn: (req: any, res: { send(): void }))
}
app.get("/", function (req, res) {
  res.sen
//       ^|
})
app.listen(3000)
```

```ts twoslash
// @module: esnext
// @filename: maths.ts
export function absolute(num: number) {
  if (num < 0) return num * -1;
  return num;
}
// @filename: index.ts
import { absolute } from "./maths";
const value = absolute(-1);
```

```ts twoslash
// @module: esnext
// @filename: maths.ts
export function absolute(num: number) {
  if (num < 0) return num * -1;
  return num;
}
// @filename: index.ts
// ---cut---
import { absolute } from "./maths";
const value = absolute(-1);
//    ^?
```
