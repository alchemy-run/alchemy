import * as Layer from "effect/Layer";
import { Ledger, LedgerProvider } from "./Ledger.ts";
import { LedgerRoleAssignment, LedgerRoleAssignmentProvider } from "./LedgerRoleAssignment.ts";

export const resources = [Ledger, LedgerRoleAssignment];
export const layers = () => Layer.mergeAll(LedgerProvider(), LedgerRoleAssignmentProvider());
