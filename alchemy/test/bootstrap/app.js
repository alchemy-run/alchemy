var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// alchemy/src/alchemy.ts
function alchemy() {
}
__name(alchemy, "alchemy");

// node_modules/aws4fetch/dist/aws4fetch.esm.mjs
var encoder = new TextEncoder();

// alchemy/src/scope.ts
import { AsyncLocalStorage } from "node:async_hooks";

// alchemy/src/fs/file-system-state-store.ts
import path from "node:path";

// alchemy/src/encrypt.ts
import sodium from "libsodium-wrappers";

// alchemy/src/secret.ts
var Secret = class {
  constructor(unencrypted) {
    this.unencrypted = unencrypted;
  }
  static {
    __name(this, "Secret");
  }
  type = "secret";
};
function secret(unencrypted) {
  if (unencrypted === void 0) {
    throw new Error("Secret cannot be undefined");
  }
  return new Secret(unencrypted);
}
__name(secret, "secret");
((secret2) => {
  secret2.env = new Proxy(_env, {
    get: /* @__PURE__ */ __name((_, name) => _env(name), "get"),
    apply: /* @__PURE__ */ __name((_, __, args) => _env(...args), "apply")
  });
  async function _env(name, value, error) {
    const result = await alchemy.env(name, value, error);
    if (typeof result === "string") {
      return secret2(result);
    }
    throw new Error(`Secret environment variable ${name} is not a string`);
  }
  __name(_env, "_env");
})(secret || (secret = {}));

// alchemy/src/fs/file-system-state-store.ts
var stateRootDir = path.join(process.cwd(), ".alchemy");

// alchemy/src/scope.ts
var scopeStorage = new AsyncLocalStorage();
var DEFAULT_STAGE = process.env.ALCHEMY_STAGE ?? process.env.USER ?? "dev";

// alchemy/src/cloudflare/auth.ts
import path2 from "node:path";

// alchemy/src/cloudflare/bucket.ts
var R2Bucket = /* @__PURE__ */ __name((id) => STATE.get(id), "R2Bucket");

// alchemy/test/bootstrap/app.ts
var app = await (async () => {
});
var bucket = await R2Bucket("bucket");
/*! Bundled license information:

aws4fetch/dist/aws4fetch.esm.mjs:
  (**
   * @license MIT <https://opensource.org/licenses/MIT>
   * @copyright Michael Hart 2024
   *)
*/
