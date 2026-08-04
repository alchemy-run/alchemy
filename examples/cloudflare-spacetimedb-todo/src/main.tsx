import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SpacetimeDBProvider } from "spacetimedb/react";
import { App } from "./App.tsx";
import { DbConnection } from "./module_bindings/index.ts";
import "./styles.css";

const uri =
  import.meta.env.VITE_SPACETIMEDB_URI || "ws://127.0.0.1:3000";
const databaseName =
  import.meta.env.VITE_SPACETIMEDB_DATABASE_NAME || "alchemy-todo";

const connectionBuilder = DbConnection.builder()
  .withUri(uri)
  .withDatabaseName(databaseName)
  .onConnect((_conn, identity) => {
    console.log("connected", identity?.toHexString?.() ?? identity);
  })
  .onConnectError((_ctx, err) => {
    console.error("connect error", err);
  })
  .onDisconnect(() => {
    console.log("disconnected");
  });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SpacetimeDBProvider connectionBuilder={connectionBuilder}>
      <App />
    </SpacetimeDBProvider>
  </StrictMode>,
);
