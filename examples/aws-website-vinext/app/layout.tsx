import "./globals.css";

export const metadata = {
  title: "vinext on AWS",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-slate-50 p-8 text-slate-900">{children}</body>
    </html>
  );
}
