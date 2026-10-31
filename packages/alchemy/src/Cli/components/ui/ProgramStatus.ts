import { useProgramStatus, type ProgramStatus } from "@alchemy.run/sigil";

/**
 * Report alchemy's state to terminals that support OSC 7501 program status
 * (working, blocked on the user, done, failed), for example as a tab badge.
 * Sigil only sends reports once the terminal confirms support. The record is
 * withdrawn when the component unmounts, unless it last reported `done` or
 * `error`, which stay for the user to find.
 *
 * `msg` is limited to alchemy's own labels and prompt headings: never user
 * input, resource values, or command output.
 */
export const useAlchemyStatus = (status: Omit<ProgramStatus, "app"> | undefined): void =>
  useProgramStatus(status === undefined ? undefined : { ...status, app: "alchemy" });
