// Next.js App Router root layout — stub.
// Panel sections: Overview/Hub | Assistant | Projects | Git | Agents | Mind | Settings

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
