import { test, expect, type Page } from '@playwright/test';

/**
 * Browser Stress Tests using Playwright
 *
 * These tests run the same stress test logic as the Vitest tests,
 * but in a real browser environment with actual IndexedDB and WaSQLite.
 */

interface StressTestResult {
    success: boolean;
    clientCount: number;
    serverCount: number;
    duration: number;
    error?: string;
}

type TestResults = Record<string, StressTestResult>;

// Helper to wait for test completion
async function waitForTestResults(page: Page, timeoutMs = 300_000): Promise<TestResults> {
    await page.waitForFunction(() => (window as any).__STRESS_TEST_RESULTS__ !== undefined, { timeout: timeoutMs });
    return page.evaluate(() => (window as any).__STRESS_TEST_RESULTS__);
}

// Helper to clear IndexedDB databases with wa-sqlite prefix
async function clearWaSQLiteState(page: Page): Promise<void> {
    await page.evaluate(async () => {
        // Get all IndexedDB databases and delete ones that match our test patterns
        const databases = await indexedDB.databases?.();
        if (databases) {
            for (const db of databases) {
                if (db.name && (db.name.includes('stress-browser') || db.name.includes('persist-test'))) {
                    indexedDB.deleteDatabase(db.name);
                }
            }
        }
        // Small delay to let deletions complete
        await new Promise((r) => setTimeout(r, 100));
    });
}

// Configuration for different test scenarios
const testConfigs = {
    quick: { opCount: 200, description: 'Quick (200 ops)' },
    standard: { opCount: 500, description: 'Standard (500 ops)' },
    full: { opCount: 1000, description: 'Full (1000 ops)' },
};

const config = testConfigs[process.env.STRESS_TEST_SIZE as keyof typeof testConfigs] || testConfigs.standard;

test.describe('Browser Stress Tests', () => {
    test.describe.configure({ mode: 'serial' });

    // Clear state before the WaSQLite tests to ensure clean slate
    test.beforeEach(async ({ page }) => {
        // Navigate to clear any pending state
        await page.goto('/');
        await clearWaSQLiteState(page);
    });

    test('Dexie (IndexedDB) stress test', async ({ page }) => {
        await page.goto(`/?autorun=true&opCount=${config.opCount}&adapters=dexie`);

        const results = await waitForTestResults(page);
        const result = results['dexie'];

        expect(result).toBeDefined();
        expect(result?.success).toBe(true);
        expect(result?.clientCount).toBe(result?.serverCount);

        console.log(`Dexie: ${result?.clientCount} items synced in ${result?.duration}ms`);
    });

    test('MemoryAdapter stress test', async ({ page }) => {
        await page.goto(`/?autorun=true&opCount=${config.opCount}&adapters=memory`);

        const results = await waitForTestResults(page);
        const result = results['memory'];

        expect(result).toBeDefined();
        expect(result?.success).toBe(true);
        expect(result?.clientCount).toBe(result?.serverCount);

        console.log(`Memory: ${result?.clientCount} items synced in ${result?.duration}ms`);
    });

    test('WaSQLite (IDBBatchAtomicVFS) stress test', async ({ page }) => {
        await page.goto(`/?autorun=true&opCount=${config.opCount}&adapters=wa-sqlite-idb`);

        const results = await waitForTestResults(page);
        const result = results['wa-sqlite-idb'];

        expect(result).toBeDefined();
        expect(result?.success).toBe(true);
        expect(result?.clientCount).toBe(result?.serverCount);

        console.log(`WaSQLite IDB: ${result?.clientCount} items synced in ${result?.duration}ms`);
    });

    test('WaSQLite (IDBMirrorVFS) stress test', async ({ page }) => {
        await page.goto(`/?autorun=true&opCount=${config.opCount}&adapters=wa-sqlite-idb-mirror`);

        const results = await waitForTestResults(page);
        const result = results['wa-sqlite-idb-mirror'];

        expect(result).toBeDefined();
        expect(result?.success).toBe(true);
        expect(result?.clientCount).toBe(result?.serverCount);

        console.log(`WaSQLite Mirror: ${result?.clientCount} items synced in ${result?.duration}ms`);
    });
});

test.describe('Browser Persistence Tests', () => {
    test('WaSQLite data persists across page reloads', async ({ page }) => {
        // This test verifies that data written to WaSQLite via Dync actually persists in IndexedDB

        await page.goto('/');

        // Wait for the page to load and Dync to be exposed
        await page.waitForFunction(() => (window as any).__Dync__ !== undefined);

        // Create a test database with some data
        const testDbName = `persistence-test-${Date.now()}`;

        const insertResult = await page.evaluate(async (dbName) => {
            const Dync = (window as any).__Dync__;
            const WaSQLiteDriver = (window as any).__WaSQLiteDriver__;
            const SQLiteAdapter = (window as any).__SQLiteAdapter__;

            // Mock API (no-op since we're just testing persistence)
            const mockApi = {
                add: async () => ({ id: 1, updated_at: new Date().toISOString() }),
                update: async () => true,
                remove: async () => {},
                list: async () => [],
                firstLoad: async () => [],
            };

            const driver = new WaSQLiteDriver(dbName, { vfs: 'IDBBatchAtomicVFS' });
            const adapter = new SQLiteAdapter(driver);

            const db = new Dync({
                databaseName: dbName,
                storageAdapter: adapter,
                sync: { test_items: mockApi },
                options: {
                    syncIntervalMs: 1000,
                    minLogLevel: 'none',
                },
            });

            db.version(1).stores({
                test_items: {
                    columns: {
                        name: { type: 'TEXT' },
                    },
                },
            });

            await db.open();

            // Insert data using Dync table API
            const table = db.table('test_items');
            await table.add({ _localId: 'local-1', name: 'test-item-1' });
            await table.add({ _localId: 'local-2', name: 'test-item-2' });

            // Read back to verify
            const items = await table.toArray();
            await db.close();

            return { items: items.map((i: any) => ({ _localId: i._localId, name: i.name })) };
        }, testDbName);

        expect(insertResult.items).toHaveLength(2);
        expect(insertResult.items).toContainEqual({ _localId: 'local-1', name: 'test-item-1' });

        // Reload the page
        await page.reload();

        // Wait for Dync to be exposed again
        await page.waitForFunction(() => (window as any).__Dync__ !== undefined);

        // Re-open the database and verify data persists
        const persistedData = await page.evaluate(async (dbName) => {
            const Dync = (window as any).__Dync__;
            const WaSQLiteDriver = (window as any).__WaSQLiteDriver__;
            const SQLiteAdapter = (window as any).__SQLiteAdapter__;

            const mockApi = {
                add: async () => ({ id: 1, updated_at: new Date().toISOString() }),
                update: async () => true,
                remove: async () => {},
                list: async () => [],
                firstLoad: async () => [],
            };

            const driver = new WaSQLiteDriver(dbName, { vfs: 'IDBBatchAtomicVFS' });
            const adapter = new SQLiteAdapter(driver);

            const db = new Dync({
                databaseName: dbName,
                storageAdapter: adapter,
                sync: { test_items: mockApi },
                options: {
                    syncIntervalMs: 1000,
                    minLogLevel: 'none',
                },
            });

            db.version(1).stores({
                test_items: {
                    columns: {
                        name: { type: 'TEXT' },
                    },
                },
            });

            await db.open();
            const table = db.table('test_items');
            const items = await table.toArray();
            await db.close();

            // Clean up - delete the database
            await db.delete();

            return items.map((i: any) => ({ _localId: i._localId, name: i.name }));
        }, testDbName);

        expect(persistedData).toHaveLength(2);
        expect(persistedData).toContainEqual({ _localId: 'local-1', name: 'test-item-1' });
        expect(persistedData).toContainEqual({ _localId: 'local-2', name: 'test-item-2' });
    });
});
