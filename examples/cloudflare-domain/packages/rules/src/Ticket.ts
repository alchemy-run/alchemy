/**
 * Rules several aggregates share, kept in a package of their own. `Verify`
 * reads a workspace package the way it reads the aggregate's own files.
 */

/** Whether a ticket can still be closed. */
export const canClose = (ticket: { readonly open: boolean }): boolean => ticket.open;

/** The most runs a ticket takes. */
export const MAX_RUNS = 3;
