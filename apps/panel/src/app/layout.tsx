import type { ReactNode } from "react";
import { Inter } from "next/font/google";
import "./globals.css";
import { Sidebar } from "../components/Sidebar";
import { Header } from "../components/Header";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata = {
  title: "Bureau",
  description: "Local-first AI agent team for your GitHub repos",
};

// Apply the saved theme before first paint (no flash). Defaults to dark.
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('bureau.theme');document.documentElement.classList.toggle('dark', t ? t==='dark' : true);}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`dark ${inter.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="font-sans antialiased">
        <div className="flex h-screen overflow-hidden">
          <Sidebar />
          <div className="flex flex-1 flex-col overflow-hidden">
            <Header />
            <main className="flex flex-1 flex-col overflow-hidden bg-muted/30">{children}</main>
          </div>
        </div>
      </body>
    </html>
  );
}
