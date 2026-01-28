import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    addRecordAndGetLocalId,
    getRecordByLocalId,
    removeRecordByLocalId,
    updateRecordByLocalId,
    requestSyncOnce,
    syncModeScenarios,
} from '../helpers/dyncHarness';
import { installDeterministicUUID, resetDeterministicUUID, wait, waitUntil } from '../helpers/testUtils';
import { getAdapterOverrides, storageAdapterMatrix } from '../helpers/storageAdapters';
import { buildSQLiteSyncTableDefinition } from '../helpers/sqliteStructuredSchemas';
import type { SQLiteTableDefinition, TableSchemaDefinition } from '../../src/storage/sqlite/schema';

installDeterministicUUID();

type Thing = {
    id?: number;
    _localId: string;
    name: string;
    updated_at: string;
};

type ServerThing = Omit<Thing, '_localId'> & { deleted: boolean };

type Tables = {
    things: Thing;
};

const thingsSchema = {
    things: 'name',
} as const;

const sqliteThingsSchema: Record<keyof Tables, SQLiteTableDefinition> = {
    things: buildSQLiteSyncTableDefinition(),
};

// Build combined matrix: each storage adapter × each sync mode
const combinedMatrix = storageAdapterMatrix.flatMap(([label, scenario]) =>
    syncModeScenarios.map((syncMode) => [`${label} / ${syncMode.label}`, scenario, syncMode] as const),
);

describe.each(combinedMatrix)('Sync failures and error handling (%s)', (_label, scenario, syncMode) => {
    const adapterOverrides = getAdapterOverrides(scenario);
    const schema = (scenario.key === 'sqlite' ? sqliteThingsSchema : thingsSchema) as Record<keyof Tables, TableSchemaDefinition>;
    const createDb = syncMode.createDync;

    beforeEach(() => {
        resetDeterministicUUID();
    });

    // ========================================================================
    // API failure scenarios
    // ========================================================================

    it('list failure surfaces error', async () => {
        const apis = {
            things: {
                add: vi.fn(async () => ({})),
                update: vi.fn(async () => true),
                remove: vi.fn(async () => {}),
                list: vi.fn(async () => {
                    throw new Error('list boom');
                }),
                firstLoad: vi.fn(async () => []),
            },
        };

        const db = await createDb<Tables>(apis, schema, {
            dbName: `fail-list-${scenario.key}-${syncMode.key}-${Math.random().toString(36).slice(2)}`,
            syncOptions: { syncIntervalMs: 50 },
            ...adapterOverrides,
        });

        await db.sync.enable(true);
        await addRecordAndGetLocalId(db, 'things', { name: 'a' });
        await waitUntil(() => !!db.sync.state.apiError, 2000);

        const err = db.sync.state.apiError;
        expect(err).toBeTruthy();
        if (err && typeof (err as any).message === 'string') {
            expect((err as any).message).toMatch(/list boom/);
        }

        await db.sync.enable(false);
        await db.close();
    });

    it('network failure sets isNetworkError to true', async () => {
        const apis = {
            things: {
                add: vi.fn(async () => ({})),
                update: vi.fn(async () => true),
                remove: vi.fn(async () => {}),
                list: vi.fn(async () => {
                    // Simulate a fetch network failure (what browsers throw when offline)
                    throw new TypeError('Failed to fetch');
                }),
                firstLoad: vi.fn(async () => []),
            },
        };

        const db = await createDb<Tables>(apis, schema, {
            dbName: `fail-network-${scenario.key}-${syncMode.key}-${Math.random().toString(36).slice(2)}`,
            syncOptions: { syncIntervalMs: 50 },
            ...adapterOverrides,
        });

        await db.sync.enable(true);
        await addRecordAndGetLocalId(db, 'things', { name: 'offline-test' });
        await waitUntil(() => !!db.sync.state.apiError, 2000);

        const err = db.sync.state.apiError;
        expect(err).toBeTruthy();
        expect(err?.isNetworkError).toBe(true);
        expect(err?.message).toMatch(/Failed to fetch/);

        await db.sync.enable(false);
        await db.close();
    });

    // Note: BatchSync has different error surfacing behavior - errors may not appear in syncState.apiError
    // This test only applies to per-table sync mode
    it.skipIf(syncMode.key === 'batch')('update failure surfaces first error and keeps item queued', async () => {
        let idCounter = 0;
        const server: ServerThing[] = [];
        const apis = {
            things: {
                add: vi.fn(async (item: any) => {
                    const rec = { id: ++idCounter, ...item, updated_at: new Date().toISOString() };
                    server.push({ ...rec });
                    return { id: rec.id };
                }),
                update: vi.fn(async () => {
                    throw new Error('update fail');
                }),
                remove: vi.fn(async () => {}),
                list: vi.fn(async () => []),
                firstLoad: vi.fn(async () => []),
            },
        };

        const db = await createDb<Tables>(apis, schema, {
            dbName: `fail-update-${scenario.key}-${syncMode.key}-${Math.random().toString(36).slice(2)}`,
            syncOptions: { syncIntervalMs: 40 },
            ...adapterOverrides,
        });

        await db.sync.enable(true);
        const { localId } = await addRecordAndGetLocalId(db, 'things', { name: 'x' });
        await waitUntil(() => server.length === 1, 2000);

        await updateRecordByLocalId(db, 'things', localId, { name: 'y' });

        await waitUntil(() => !!db.sync.state.apiError, 2000);

        const err = db.sync.state.apiError;
        expect(err).toBeTruthy();
        if (err && typeof (err as any).message === 'string') {
            expect((err as any).message).toMatch(/update fail/);
        }
        expect(apis.things.update).toHaveBeenCalled();
        expect(db.sync.state.pendingChanges.length).toBeGreaterThan(0);

        await db.sync.enable(false);
        await db.close();
    });

    // Note: BatchSync has different error surfacing behavior - errors may not appear in syncState.apiError
    // This test only applies to per-table sync mode
    it.skipIf(syncMode.key === 'batch')('remove failure surfaces error and retains pending delete', async () => {
        let idCounter = 0;
        const server: ServerThing[] = [];
        const apis = {
            things: {
                add: vi.fn(async (item: any) => {
                    const rec = { id: ++idCounter, ...item, updated_at: new Date().toISOString() };
                    server.push({ ...rec });
                    return { id: rec.id };
                }),
                update: vi.fn(async () => true),
                remove: vi.fn(async () => {
                    throw new Error('remove fail');
                }),
                list: vi.fn(async () => []),
                firstLoad: vi.fn(async () => []),
            },
        };

        const db = await createDb<Tables>(apis, schema, {
            dbName: `fail-remove-${scenario.key}-${syncMode.key}-${Math.random().toString(36).slice(2)}`,
            syncOptions: { syncIntervalMs: 40 },
            ...adapterOverrides,
        });

        await db.sync.enable(true);
        const { localId } = await addRecordAndGetLocalId(db, 'things', { name: 'del' });
        await waitUntil(() => server.length === 1, 2000);

        await removeRecordByLocalId(db, 'things', localId);
        await waitUntil(() => !!db.sync.state.apiError, 2000);

        const err = db.sync.state.apiError;
        expect(err).toBeTruthy();
        if (err && typeof (err as any).message === 'string') {
            expect((err as any).message).toMatch(/remove fail/);
        }
        expect(server[0]?.deleted).toBeUndefined();

        await db.sync.enable(false);
        await db.close();
    });

    // Note: BatchSync has different error surfacing behavior - errors may not appear in syncState.apiError
    // This test only applies to per-table sync mode
    it.skipIf(syncMode.key === 'batch')('add failure surfaces error via syncState.apiError', async () => {
        const badApis = {
            things: {
                add: vi.fn(async () => {
                    throw new Error('add fail');
                }),
                update: vi.fn(async () => true),
                remove: vi.fn(async () => {}),
                list: vi.fn(async () => []),
            },
        };

        const db = await createDb<Tables>(badApis, schema, {
            dbName: `fail-add-${scenario.key}-${syncMode.key}-${Math.random().toString(36).slice(2)}`,
            syncOptions: { syncIntervalMs: 40 },
            ...adapterOverrides,
        });

        await db.sync.enable(true);

        try {
            await addRecordAndGetLocalId(db, 'things', { name: 'err' });
            await waitUntil(() => !!db.sync.state.apiError, 800);
            const err = db.sync.state.apiError;
            expect(err).toBeTruthy();
            if (err && typeof (err as any).message === 'string') {
                expect((err as any).message).toMatch(/add fail/);
            }
        } finally {
            await db.sync.enable(false);
            await db.close();
        }
    });

    // ========================================================================
    // Missing API function scenarios
    // ========================================================================

    it('missing api functions per key triggers error on first sync usage', async () => {
        const baseApis: any = {
            things: {
                add: async () => ({}),
                update: async () => true,
                remove: async () => {},
                list: async () => [],
            },
        };

        for (const key of ['add', 'update', 'remove', 'list'] as const) {
            const copy = JSON.parse(JSON.stringify(baseApis));
            delete copy.things[key];
            const db = await createDb<Tables>(copy, schema, {
                dbName: `fail-missing-${key}-${scenario.key}-${syncMode.key}-${Math.random().toString(36).slice(2)}`,
                syncOptions: { syncIntervalMs: 40 },
                ...adapterOverrides,
            });

            try {
                await db.sync.enable(true);
                await addRecordAndGetLocalId(db, 'things', { name: 'x' });
                await waitUntil(() => !!db.sync.state.apiError, 800);
                const err = db.sync.state.apiError;
                expect(err).toBeTruthy();
            } finally {
                await db.sync.enable(false);
                await db.close();
            }
        }
    });

    // ========================================================================
    // Overlapping sync cycle scenarios
    // ========================================================================

    it('overlapping sync cycles are skipped by sync status guard', async () => {
        let idCounter = 0;
        const server: ServerThing[] = [];
        const listDelay = 120;
        const apis = {
            things: {
                add: vi.fn(async (item: any) => {
                    const rec = { id: ++idCounter, ...item, updated_at: new Date().toISOString() };
                    server.push({ ...rec });
                    return { id: rec.id };
                }),
                update: vi.fn(async () => true),
                remove: vi.fn(async () => {}),
                list: vi.fn(async () => {
                    await wait(listDelay);
                    return [];
                }),
                firstLoad: vi.fn(async () => []),
            },
        };

        const db = await createDb<Tables>(apis, schema, {
            dbName: `fail-overlap-${scenario.key}-${syncMode.key}-${Math.random().toString(36).slice(2)}`,
            syncOptions: { syncIntervalMs: 500 },
            ...adapterOverrides,
        });

        // Add a record (sync not enabled yet, so no syncOnce triggered)
        const { localId } = await addRecordAndGetLocalId(db, 'things', { name: 'one' });

        // First requestSyncOnce enables sync and starts a sync cycle (slow due to listDelay)
        // Second requestSyncOnce should see 'syncing' status and wait for it to complete
        const sync1 = requestSyncOnce(db, { timeout: 2000 });
        const sync2 = requestSyncOnce(db, { timeout: 2000 });
        await Promise.all([sync1, sync2]);

        expect(apis.things.list).toHaveBeenCalledTimes(1);
        const local = await getRecordByLocalId(db, 'things', localId);
        expect(local?.name).toBe('one');

        await db.close();
    });

    it('slow add does not cause duplicate adds during overlapping triggers', async () => {
        let idCounter = 0;
        const server: ServerThing[] = [];
        const apis = {
            things: {
                add: vi.fn(async (item: any) => {
                    await wait(100);
                    const rec = { id: ++idCounter, ...item, updated_at: new Date().toISOString() };
                    server.push({ ...rec });
                    return { id: rec.id };
                }),
                update: vi.fn(async () => true),
                remove: vi.fn(async () => {}),
                list: vi.fn(async () => []),
                firstLoad: vi.fn(async () => []),
            },
        };

        const db = await createDb<Tables>(apis, schema, {
            dbName: `fail-slow-add-${scenario.key}-${syncMode.key}-${Math.random().toString(36).slice(2)}`,
            syncOptions: { syncIntervalMs: 50 },
            ...adapterOverrides,
        });

        await db.sync.enable(true);
        const { localId } = await addRecordAndGetLocalId(db, 'things', { name: 'alpha' });
        await wait(50);
        await updateRecordByLocalId(db, 'things', localId, { name: 'beta' });
        await waitUntil(() => server.length > 0, 2000);

        expect(server.length).toBe(1);
        expect(server[0]?.name).toBe('alpha');

        await db.sync.enable(false);
        await db.close();
    });
});
