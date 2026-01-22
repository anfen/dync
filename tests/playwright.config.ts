import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    testDir: './e2e',
    fullyParallel: false, // Run sequentially to avoid resource conflicts
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    workers: 1,
    reporter: [['html', { open: 'never' }], ['list']],
    timeout: 300_000, // 5 minutes per test (stress tests are slow)

    use: {
        baseURL: 'http://localhost:5174',
        trace: 'on-first-retry',
        video: 'retain-on-failure',
    },

    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
        // Firefox and WebKit can be enabled if needed
        // {
        //     name: 'firefox',
        //     use: { ...devices['Desktop Firefox'] },
        // },
        // {
        //     name: 'webkit',
        //     use: { ...devices['Desktop Safari'] },
        // },
    ],

    webServer: {
        command: 'pnpm vite --config vite.browser.config.ts',
        url: 'http://localhost:5174',
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
    },
});
