import { defineConfig, devices } from "@playwright/test";

/**
 * Every UI change is checked in Chrome (Chromium) and Safari (WebKit), on desktop and on a
 * phone-sized viewport. WebKit is the engine behind every browser on iPhone and iPad.
 */
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: "http://localhost:3100", trace: "retain-on-failure" },
  projects: [
    { name: "chrome-desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "chrome-android", use: { ...devices["Pixel 7"] } },
    { name: "safari-desktop", use: { ...devices["Desktop Safari"] } },
    { name: "safari-iphone", use: { ...devices["iPhone 15"] } },
  ],
  webServer: {
    command: "npm run start -- -p 3100",
    url: "http://localhost:3100",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
