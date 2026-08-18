// Shared resource declarations — imported by the backend, the Durable
// Object, and the Workflow. Narrow subpaths only (no provider barrel):
// every module here is compiled into Next's server bundle AND the
// rolldown prebundle next to the OpenNext artifact.
import * as KV from "alchemy/Cloudflare/KV";
import * as Queues from "alchemy/Cloudflare/Queues";

/** KV namespace shared by the backend program, the DO, and the Workflow. */
export const Visits = KV.Namespace("Visits");

/** Queue produced to by the backend's RPC and consumed on the same class. */
export const Jobs = Queues.Queue("Jobs");
