// Shared resource declarations — imported by the backend, the Durable
// Object, and the Workflow. Narrow subpaths only (no provider barrel):
// every module here joins the waku RSC server graph.
import * as KV from "alchemy/Cloudflare/KV";
import * as Queues from "alchemy/Cloudflare/Queues";

/** KV namespace shared by the backend program, the DO, and the Workflow. */
export const Visits = KV.Namespace("Visits");

/** Queue produced to by the backend's fetch/RPC and consumed on the same class. */
export const Jobs = Queues.Queue("Jobs");
