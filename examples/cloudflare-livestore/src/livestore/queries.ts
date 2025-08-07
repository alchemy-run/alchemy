import { queryDb } from "@livestore/livestore";

import { tables } from "./tables.ts";

export const uiState$ = queryDb(tables.uiState.get(), { label: "uiState" });
