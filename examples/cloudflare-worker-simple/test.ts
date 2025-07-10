import alchemy from "alchemy";
import { DurableObjectNamespace, Worker } from "alchemy/cloudflare";

const app = await alchemy("do-sqlite-state-store");
const store = new DurableObjectNamespace("store", {
  className: "Store",
  sqlite: true,
});
const worker = await Worker("do-sqlite-state-store", {
  entrypoint: "do-sqlite-state-store.js",
  noBundle: true,
  bindings: {
    STORE: store,
  },
});
console.log(worker.url);
await app.finalize();
