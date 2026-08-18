// The SERVER-side backend client — for RSC page modules only: the VALUE
// form dispatches backend methods in-process (no HTTP hop), and browser
// code reaches the backend exclusively through the effect fetch's /api/*
// surface. Module-scope on purpose: the client is per-request-correct
// (methods resolve their own request context) and shares the one runtime
// with the mount middleware and the generated worker entry.
import { createClient } from "alchemy/Client";
import Backend from "../backend.ts";

export const backend = createClient(Backend);
