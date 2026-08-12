import type { ReactNode } from "react";

export default function Root({ children }: { children: ReactNode }) {
  return (
    <html>
      <head>
        <title>Waku on AWS</title>
      </head>
      <body>{children}</body>
    </html>
  );
}

export const getConfig = async () => ({ render: "static" }) as const;
