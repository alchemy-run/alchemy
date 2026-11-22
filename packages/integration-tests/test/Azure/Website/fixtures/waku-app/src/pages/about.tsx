/** @jsxImportSource react */
export default function AboutPage() {
  return (
    <div>
      <div data-testid="about-marker">WAKU_AZURE_STATIC_MARKER</div>
    </div>
  );
}

// Static: prerendered at build time.
export const getConfig = async () => ({ render: "static" }) as const;
