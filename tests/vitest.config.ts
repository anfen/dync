import { defineConfig, defaultExclude } from 'vitest/config';

const includeStressSuite = process.env.DYNC_INCLUDE_STRESS === 'true';

export default defineConfig({
    test: {
        name: 'dync',
        globals: true,
        environment: 'happy-dom',
        dir: '.',
        setupFiles: ['./vitest.setup.ts'],
        coverage: {
            include: ['**/src/**/*.{ts,tsx}'],
            allowExternal: true,
            reportOnFailure: true,
            reporter: ['text', 'json-summary', 'json', 'html'],
        },
        exclude: [
            ...defaultExclude,
            '**/e2e/**', // Playwright tests
            '**/browser/**', // Browser test harness
            ...(includeStressSuite ? [] : ['**/__tests__/sync.stress.test.ts']),
        ],
    },
});
