/**
 * Facts about the process this code runs in, read once when the module loads.
 * A route belongs to a process, so `pid` is the sidecar's inside the sidecar,
 * and the test process's when the providers run in-process.
 */
export const platform = process.platform;
export const pid = process.pid;
