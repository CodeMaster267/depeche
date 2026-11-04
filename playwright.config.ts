import { defineConfig, devices } from "@playwright/test";
import nextEnv from "@next/env";

// The same settings the app uses (`.env.local`), so the tests can reach the local Supabase.
nextEnv.loadEnvConfig(process.cwd());

/**
 * Every UI change is checked in Chrome (Chromium) and Safari (WebKit), on desktop and on a
 * phone-sized viewport. WebKit is the engine behind every browser on iPhone and iPad.
 * The app runs against a local Supabase started with `npx supabase start` (see README).
 */
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: "http://localhost:3100", trace: "retain-on-failure" },
  projects: [
    // Wipes the local database and sets Depeche up the way Hasan will on day one.
    { name: "setup", testMatch: /setup\.spec\.ts/, use: { ...devices["Desktop Chrome"] } },
    ...[
      { name: "chrome-desktop", use: { ...devices["Desktop Chrome"] } },
      { name: "chrome-android", use: { ...devices["Pixel 7"] } },
      { name: "safari-desktop", use: { ...devices["Desktop Safari"] } },
      { name: "safari-iphone", use: { ...devices["iPhone 15"] } },
      // Hasan reads on an iPad: replies (tables especially) are checked at that width too.
      { name: "safari-ipad", use: { ...devices["iPad Pro 11 landscape"] }, testMatch: /chat(-menu)?\.spec\.ts/ },
    ].map((p) => ({ ...p, dependencies: ["setup"], testIgnore: /setup\.spec\.ts/ })),
  ],
  webServer: {
    command: "npm run start -- -p 3100",
    url: "http://localhost:3100",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
