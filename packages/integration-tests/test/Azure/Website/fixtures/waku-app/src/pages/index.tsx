/** @jsxImportSource react */
import { getEnv } from "waku";

export default async function HomePage() {
  return (
    <div>
      <div data-testid="page-marker">WAKU_AZURE_PAGE_MARKER</div>
      {/* Read on the Function at request time. */}
      <div data-testid="greeting">{getEnv("GREETING") ?? "no greeting"}</div>
    </div>
  );
}

// Dynamic: the server Function renders it on every request.
export const getConfig = async () => ({ render: "dynamic" }) as const;
