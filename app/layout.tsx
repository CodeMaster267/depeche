import type { Metadata, Viewport } from "next";
import { Archivo, Atkinson_Hyperlegible, Baloo_2, Caveat, Comic_Neue, Fraunces, Geist, Geist_Mono, Lora, Nunito, Playfair_Display, Space_Grotesk } from "next/font/google";
import "./globals.css";
import { PressFeedback } from "@/components/Press";
import { GlassEffects } from "@/components/Glass";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });
const archivo = Archivo({ subsets: ["latin"], axes: ["wdth"], variable: "--font-archivo" });
// Fonts a person's own design can use (lib/design/spec.ts). Not preloaded: a font is only
// downloaded by someone whose design uses it.
const nunito = Nunito({ subsets: ["latin"], preload: false, display: "swap", variable: "--font-nunito" });
const baloo = Baloo_2({ subsets: ["latin"], preload: false, display: "swap", variable: "--font-baloo" });
const comic = Comic_Neue({ subsets: ["latin"], preload: false, display: "swap", weight: ["400", "700"], variable: "--font-comic" });
const atkinson = Atkinson_Hyperlegible({ subsets: ["latin"], preload: false, display: "swap", weight: ["400", "700"], variable: "--font-atkinson" });
const grotesk = Space_Grotesk({ subsets: ["latin"], preload: false, display: "swap", variable: "--font-grotesk" });
const lora = Lora({ subsets: ["latin"], preload: false, display: "swap", variable: "--font-lora" });
const fraunces = Fraunces({ subsets: ["latin"], preload: false, display: "swap", variable: "--font-fraunces" });
const playfair = Playfair_Display({ subsets: ["latin"], preload: false, display: "swap", variable: "--font-playfair" });
const caveat = Caveat({ subsets: ["latin"], preload: false, display: "swap", variable: "--font-caveat" });
const designFonts = [nunito, baloo, comic, atkinson, grotesk, lora, fraunces, playfair, caveat];

export const metadata: Metadata = {
  title: "Depeche",
  description: "Private AI chat for your people.",
  robots: { index: false, follow: false },
  // Opened from the iPhone home screen, Depeche runs full screen like an app.
  appleWebApp: { capable: true, title: "Depeche", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={[geist, geistMono, archivo, ...designFonts].map((f) => f.variable).join(" ")}>
      <body>
        <PressFeedback />
        <GlassEffects />
        {children}
      </body>
    </html>
  );
}
