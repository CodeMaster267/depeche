import type { MetadataRoute } from "next";

/** Lets Depeche be added to the iPhone or Android home screen as its own app. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Depeche",
    short_name: "Depeche",
    description: "Private AI chat for your people.",
    start_url: "/",
    display: "standalone",
    background_color: "#000000",
    theme_color: "#000000",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // The D sits well inside the safe zone, so the same artwork works when Android crops it.
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
