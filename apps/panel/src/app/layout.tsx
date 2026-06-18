import type { ReactNode } from "react";
import { Inter } from "next/font/google";
import "./globals.css";
import { Sidebar } from "../components/Sidebar";
import { Header } from "../components/Header";
import { ConfirmProvider } from "../components/ConfirmDialog";
import { SidebarProvider } from "../lib/sidebar";
import { ProjectsProvider } from "../lib/projects-context";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata = {
  title: "Bureau",
  description: "Local-first AI agent team for your GitHub repos",
};

// Apply the saved appearance before first paint (no flash) — mirrors applyAppearance()
// in lib/appearance.ts (keep the accent map in sync). Defaults to dark.
const THEME_SCRIPT = `(function(){try{
var d=document.documentElement,ls=localStorage;
var m=ls.getItem('bureau.theme');
var sys=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches;
var dark=m==='light'?false:m==='system'?sys:true;
d.classList.toggle('dark',dark);
if(ls.getItem('bureau.motion')==='reduce')d.classList.add('reduce-motion');
var ac=ls.getItem('bureau.accent');if(ac&&ac!=='default')d.setAttribute('data-accent',ac);
var sc=ls.getItem('bureau.scale');if(sc==='compact')d.style.fontSize='14px';else if(sc==='large')d.style.fontSize='18px';
}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`dark ${inter.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="font-sans antialiased">
        <ConfirmProvider>
          <ProjectsProvider>
            <SidebarProvider>
              <div className="flex h-screen overflow-hidden">
                <Sidebar />
                <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                  <Header />
                  <main className="flex flex-1 flex-col overflow-hidden bg-muted/30">{children}</main>
                </div>
              </div>
            </SidebarProvider>
          </ProjectsProvider>
        </ConfirmProvider>
      </body>
    </html>
  );
}
