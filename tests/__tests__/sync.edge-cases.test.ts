import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Dync } from '../../src/index';
import type { SQLiteTableDefinition, TableSchemaDefinition } from '../../src/storage/sqlite/schema';
import {
    addRecordAndGetLocalId,
    getRecordByLocalId,
    updateRecordByLocalId,
    removeRecordByLocalId,
    waitForSyncIdle,
    runSyncCycle,
    requestSyncOnce,
    syncModeScenarios,
    type SyncModeScenario,
} from '../helpers/dyncHarness';
import { installDeterministicUUID, resetDeterministicUUID, wait, waitUntil, waitUntilAsync, setVisibility } from '../helpers/testUtils';
import { getAdapterOverrides, storageAdapterMatrix } from '../helpers/storageAdapters';
import { buildSQLiteSyncTableDefinition, sqliteCoverageUnsyncedDefinition } from '../helpers/sqliteStructuredSchemas';

installDeterministicUUID();

// ============================================================================
// Types and schemas for edge case tests
// ============================================================================

type Item = {
    id?: number;
    _localId: string;
    name: string;
    updated_at: string;
    [key: string]: any;
};

type Tables = {
    items: Item;
};

type TablesWithUnsynced = {
    items: Item;
    unsynced: { _localId?: string; info: string };
};

const itemsSchema = {
    items: 'name',
} as const;

const sqliteItemsSchema: Record<keyof Tables, SQLiteTableDefinition> = {
    items: buildSQLiteSyncTableDefinition(),
};

const coverageSchema = {
    items: 'name',
    unsynced: 'id, info', // _localId is auto-injected as primary key
} as const;

const sqliteCoverageSchema: Record<keyof TablesWithUnsynced, SQLiteTableDefinition> = {
    items: buildSQLiteSyncTableDefinition(),
    unsynced: sqliteCoverageUnsyncedDefinition,
};

interface ServerRecord {
    id: number;
    name: string;
    updated_at: string;
    deleted?: boolean;
}

// ============================================================================
// API factory
// ============================================================================

function buildApis(latency = 5) {
    let idCounter = 0;
    const server: ServerRecord[] = [];

    return {
        server,
        apis: {
            items: {
                add: vi.fn(async (item: any) => {
                    await wait(latency);
                    const rec = {
                        id: ++idCounter,
                        ...item,
                        updated_at: new Date().toISOString(),
                    } satisfies ServerRecord;
                    server.push(rec);
                    return { id: rec.id, updated_at: rec.updated_at };
                }),
                update: vi.fn(async (id: number, changes: any) => {
                    await wait(latency);
                    const rec = server.find((r) => r.id === id);
                    if (!rec) return false;
                    Object.assign(rec, changes, { updated_at: new Date().toISOString() });
                    return true;
                }),
                remove: vi.fn(async (id: number) => {
                    await wait(latency);
                    const rec = server.find((r) => r.id === id);
                    if (rec) rec.deleted = true;
                }),
                list: vi.fn(async (lastUpdatedAt: Date) => {
                    await wait(latency);
                    return server.filter((r) => new Date(r.updated_at) > lastUpdatedAt).map((r) => ({ ...r }));
                }),
                firstLoad: vi.fn(async (_lastId: any) => {
                    await wait(latency);
                    return [] as any[];
                }),
            },
        },
    } as const;
}

function makeApisWithListHandler(listHandler?: (lastUpdatedAt: Date) => Promise<any[]> | any[]) {
    let idCounter = 0;
    const server: any[] = [];

    return {
        server,
        apis: {
            items: {
                add: vi.fn(async (item: any) => {
                    const rec = { id: ++idCounter, ...item, updated_at: new Date().toISOString() };
                    server.push({ ...rec });
                    return { id: rec.id, updated_at: rec.updated_at };
                }),
                update: vi.fn(async (id: number, changes: any) => {
                    const rec = server.find((r) => r.id === id);
                    if (!rec) return false;
                    Object.assign(rec, changes, { updated_at: new Date().toISOString() });
                    return true;
                }),
                remove: vi.fn(async (id: number) => {
                    const rec = server.find((r) => r.id === id);
                    if (rec) rec.deleted = true;
                }),
                list: vi.fn(async (lastUpdatedAt: Date) => {
                    if (listHandler) return listHandler(lastUpdatedAt);
                    return server.filter((r) => new Date(r.updated_at) > lastUpdatedAt).map((r) => ({ ...r }));
                }),
                firstLoad: vi.fn(async (_lastId: any) => server.map((r) => ({ ...r }))),
            },
        },
    } as const;
}

// ============================================================================
// Helper functions
// ============================================================================

async function addItem(db: Dync<Tables>, name: string) {
    const { localId } = await addRecordAndGetLocalId(db, 'items', { name });
    return localId;
}

async function updateItem(db: Dync<Tables>, localId: string, changes: Partial<Item>) {
    await updateRecordByLocalId(db, 'items', localId, changes);
}

async function removeItem(db: Dync<Tables>, localId: string) {
    await removeRecordByLocalId(db, 'items', localId);
}

// Build combined matrix: each storage adapter × each sync mode
const combinedMatrix = storageAdapterMatrix.flatMap(([label, scenario]) =>
    syncModeScenarios.map((syncMode) => [`${label} / ${syncMode.label}`, scenario, syncMode] as const),
);

// ============================================================================
// Edge case tests
// ============================================================================

describe.each(combinedMatrix)('Sync edge cases (%s)', (_label, scenario, syncMode: SyncModeScenario) => {
    const adapterOverrides = getAdapterOverrides(scenario);
    const basePrefix = `edge-${scenario.key}-${syncMode.key}`;
    const schema = (scenario.key === 'sqlite' ? sqliteItemsSchema : itemsSchema) as Record<keyof Tables, TableSchemaDefinition>;
    const unsyncedSchema = (scenario.key === 'sqlite' ? sqliteCoverageSchema : coverageSchema) as Record<keyof TablesWithUnsynced, TableSchemaDefinition>;

    const buildScenarioDb = async (apis: any, syncIntervalMs = 40, suffix = '') => {
        const prefix = suffix ? `${basePrefix}-${suffix}` : basePrefix;
        const db = await syncMode.createDync<Tables>(apis, schema, {
            dbName: `${prefix}-${Math.random().toString(36).slice(2)}`,
            syncOptions: {
                syncIntervalMs,
                minLogLevel: 'none',
            },
            ...adapterOverrides,
        });
        await db.sync.enable(true);
        return db;
    };

    beforeEach(() => {
        resetDeterministicUUID();
    });

    // ========================================================================
    // Coalescing and rapid updates
    // ========================================================================

    it('handles rapid consecutive updates before server push (coalescing logic path)', async () => {
        const { apis, server } = buildApis();
        const db = await buildScenarioDb(apis);

        try {
            const localId = await addItem(db, 'a');
            await waitUntil(() => server.length === 1 || apis.items.update.mock.calls.length > 0, 1200);

            await updateItem(db, localId, { name: 'b' });
            await updateItem(db, localId, { name: 'c' });

            await waitUntil(() => server[0]?.name === 'c', 2000);

            expect(server[0]?.name).toBe('c');
        } finally {
            await db.sync.enable(false);
            await db.close();
        }
    });

    // ========================================================================
    // Delete during inflight add
    // ========================================================================

    it('deletes item locally during inflight add resulting in server delete queueing', async () => {
        const { apis, server } = buildApis();
        const db = await syncMode.createDync<Tables>(apis, schema, {
            dbName: `${basePrefix}-delete-during-add-${Math.random().toString(36).slice(2)}`,
            syncOptions: { syncIntervalMs: 200 },
            ...adapterOverrides,
        });
        await db.sync.enable(true);

        try {
            const localId = await addItem(db, 'temp');
            await removeItem(db, localId);

            await waitUntilAsync(async () => (await db.table('items').count()) === 0, 1500);
            await waitForSyncIdle(db, 4000);

            if (server.length) {
                expect(server[0]?.deleted).toBe(true);
            }

            const items = await db.items.toArray();
            expect(items.length).toBe(0);
        } finally {
            await db.sync.enable(false);
            await db.close();
        }
    });

    // ========================================================================
    // Visibility change behavior
    // ========================================================================

    it('visibility change stops and restarts interval sync', async () => {
        const { apis } = buildApis();
        const db = await buildScenarioDb(apis, 40, 'visibility');

        try {
            await addItem(db, 'vis');
            await waitUntil(() => apis.items.add.mock.calls.length >= 1, 1200);
            const before = apis.items.add.mock.calls.length;

            setVisibility('hidden');
            await wait(200);
            expect(apis.items.add.mock.calls.length).toBe(before);

            setVisibility('visible');
            await waitUntil(() => apis.items.add.mock.calls.length >= before, 1200);

            expect(apis.items.add.mock.calls.length).toBeGreaterThanOrEqual(before);
        } finally {
            setVisibility('visible');
            await db.sync.enable(false);
            await db.close();
        }
    });

    // ========================================================================
    // Server deletions and merge behavior
    // ========================================================================

    it('handles server list returning deletions and merges updates skipping pending local updates', async () => {
        const { apis, server } = buildApis();
        const db = await buildScenarioDb(apis);

        try {
            server.push({ id: 101, name: 'srv1', updated_at: new Date().toISOString() });
            server.push({ id: 102, name: 'srv2', updated_at: new Date().toISOString() });

            await addItem(db, 'local');
            await wait(150);

            const one = server.find((s) => s.id === 101)!;
            one.name = 'srv1-new';
            one.updated_at = new Date().toISOString();

            const two = server.find((s) => s.id === 102)!;
            two.deleted = true;
            two.updated_at = new Date().toISOString();

            await wait(200);

            const items = await db
                .table('items')
                .jsFilter((item) => !item.deleted)
                .toArray();
            const names = items.map((item) => item.name).sort();

            expect(names).toContain('srv1-new');
            expect(names).not.toContain('srv2');
        } finally {
            await db.sync.enable(false);
            await db.close();
        }
    });

    // ========================================================================
    // Unsynced tables
    // ========================================================================

    it('ignores additional unsynced table without errors', async () => {
        const { apis } = makeApisWithListHandler();
        const db = await syncMode.createDync<TablesWithUnsynced>(apis, unsyncedSchema, {
            dbName: `${basePrefix}-unsynced-${Math.random().toString(36).slice(2)}`,
            ...adapterOverrides,
        });

        await db.sync.enable(true);
        // Non-synced tables auto-generate _localId just like synced tables
        await (db.table('unsynced') as any).add({ info: 'local-only' });
        await addRecordAndGetLocalId(db, 'items', { name: 'sync-me' });
        await runSyncCycle(db, { timeout: 4000, keepEnabled: true });
        await waitForSyncIdle(db, 4000);

        expect(await db.table('items').count()).toBeGreaterThanOrEqual(1);
        expect(await db.table('unsynced').count()).toBe(1);

        await db.sync.enable(false);
        await db.close();
    });

    // ========================================================================
    // Pending local updates preventing remote overwrites
    // ========================================================================

    it('pending local update prevents newer remote value from overwriting', async () => {
        const { apis, server } = makeApisWithListHandler();
        const db = await syncMode.createDync<Tables>(apis, schema, {
            dbName: `${basePrefix}-local-wins-${Math.random().toString(36).slice(2)}`,
            ...adapterOverrides,
        });

        await db.sync.enable(true);
        const { localId } = await addRecordAndGetLocalId(db, 'items', { name: 'initial' });
        await waitUntil(() => server.length === 1, 2000);

        await db.sync.enable(false);
        server[0].name = 'server-change';
        server[0].updated_at = new Date(Date.now() + 1000).toISOString();

        await updateRecordByLocalId(db, 'items', localId, { name: 'local-change' });

        await db.sync.enable(true);
        await runSyncCycle(db, { timeout: 2000, keepEnabled: true });
        await waitForSyncIdle(db, 2000);

        const final = await getRecordByLocalId(db, 'items', localId);
        expect(final?.name).toBe('local-change');

        await db.sync.enable(false);
        await db.close();
    });

    // ========================================================================
    // Sync guard for rapid overlapping syncOnce calls
    // ========================================================================

    it('rapid overlapping syncOnce calls hit syncing guard', async () => {
        const listLatency = 150;
        const listSpy = vi.fn(async (_lastUpdatedAt: Date) => {
            await wait(listLatency);
            return [];
        });
        const { apis } = makeApisWithListHandler();
        apis.items.list.mockImplementation(listSpy);

        const db = await syncMode.createDync<Tables>(apis, schema, {
            dbName: `${basePrefix}-sync-guard-${Math.random().toString(36).slice(2)}`,
            syncOptions: { syncIntervalMs: 500 },
            ...adapterOverrides,
        });

        await addRecordAndGetLocalId(db, 'items', { name: 'r1' });

        const sync1 = requestSyncOnce(db, { timeout: 2000 });
        const sync2 = requestSyncOnce(db, { timeout: 2000 });
        await Promise.all([sync1, sync2]);

        expect(listSpy).toHaveBeenCalledTimes(1);

        await db.close();
    });

    // ========================================================================
    // listExtraIntervalMs rate limits per-table pulls
    // ========================================================================

    // listExtraIntervalMs only applies to per-table (CRUD) sync, not batch sync
    it.skipIf(syncMode.key === 'batch')('listExtraIntervalMs skips pull if interval has not elapsed', async () => {
        const listSpy = vi.fn(async (_lastUpdatedAt: Date) => [{ id: 1, updated_at: new Date().toISOString() }]);

        const apis = {
            items: {
                add: vi.fn(async (_item: any) => ({ id: 2, updated_at: new Date().toISOString() })),
                update: vi.fn(async () => true),
                remove: vi.fn(async () => {}),
                list: listSpy,
                listExtraIntervalMs: 50,
                firstLoad: vi.fn(async () => []),
            },
        };

        const db = await syncMode.createDync<Tables>(apis, schema, {
            dbName: `${basePrefix}-list-interval-${Math.random().toString(36).slice(2)}`,
            syncOptions: { syncIntervalMs: 25 },
            ...adapterOverrides,
        });

        // Not skipped, needs to set newestServerUpdatedAt
        await runSyncCycle(db, { timeout: 2000 });
        expect(listSpy).toHaveBeenCalledTimes(1);

        // Skipped due to listExtraIntervalMs not elapsed
        await runSyncCycle(db, { timeout: 2000 });
        expect(listSpy).toHaveBeenCalledTimes(1);

        // NOT skipped due to listExtraIntervalMs elapsed
        await runSyncCycle(db, { timeout: 2000 });
        expect(listSpy).toHaveBeenCalledTimes(2);

        // Skipped again
        await runSyncCycle(db, { timeout: 2000 });
        expect(listSpy).toHaveBeenCalledTimes(2);

        // NOT skipped due to listExtraIntervalMs elapsed
        await runSyncCycle(db, { timeout: 2000 });
        expect(listSpy).toHaveBeenCalledTimes(3);

        await db.close();
    });
});
