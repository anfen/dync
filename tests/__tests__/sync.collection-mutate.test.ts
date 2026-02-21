/**
 * Tests that StorageCollection.modify() and StorageCollection.delete() are
 * sync-aware — i.e. they create pending changes that are pushed to the server
 * just like the equivalent table-level methods.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { addRecordAndGetLocalId, syncModeScenarios, type SyncModeScenario, waitForSyncIdle } from '../helpers/dyncHarness';
import { installDeterministicUUID, resetDeterministicUUID } from '../helpers/testUtils';
import { getAdapterOverrides, storageAdapterMatrix } from '../helpers/storageAdapters';
import { buildSQLiteSyncTableDefinition } from '../helpers/sqliteStructuredSchemas';
import type { SQLiteTableDefinition, TableSchemaDefinition } from '../../src/storage/sqlite/schema';
import { LOCAL_PK } from '../../src/types';

installDeterministicUUID();

// ============================================================================
// Shared types and server helpers
// ============================================================================

interface Fish {
    id?: number;
    _localId: string;
    name: string;
    age: number;
    updated_at: string;
}

interface ServerFish {
    id: number;
    name: string;
    age: number;
    updated_at: string;
    deleted: boolean;
}

type Tables = { fish: Fish };

function makeApis() {
    let counter = 0;
    const server: ServerFish[] = [];

    const apis = {
        fish: {
            add: vi.fn(async (item: any) => {
                const rec: ServerFish = { ...item, id: ++counter, updated_at: new Date().toISOString(), deleted: false };
                server.push(rec);
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
            list: vi.fn(async (newestUpdatedAt: Date) => {
                return server.filter((r) => new Date(r.updated_at) > newestUpdatedAt).map((r) => ({ ...r }));
            }),
            firstLoad: vi.fn(async () => [] as any[]),
        },
    } as const;

    return { apis, server };
}

const fishSchema = { fish: 'name, age' } as const;
const sqliteFishSchema: Record<keyof Tables, SQLiteTableDefinition> = {
    fish: buildSQLiteSyncTableDefinition({ age: { type: 'INTEGER' } }),
};

// ============================================================================
// Test matrix
// ============================================================================

const combinedMatrix = storageAdapterMatrix.flatMap(([storageLabel, storageScenario]) =>
    syncModeScenarios.map((syncMode) => [`${storageLabel} + ${syncMode.label}`, storageScenario, syncMode] as const),
);

describe.each(combinedMatrix)('collection mutation sync (%s)', (_label, storageScenario, syncMode: SyncModeScenario) => {
    const adapterOverrides = getAdapterOverrides(storageScenario);
    const schema = (storageScenario.key === 'sqlite' ? sqliteFishSchema : fishSchema) as Record<keyof Tables, TableSchemaDefinition>;

    const createDb = async (apis: any) => {
        const db = await syncMode.createDync<Tables>(apis, schema, {
            dbName: `coll-mutate-${storageScenario.key}-${syncMode.key}-${Math.random().toString(36).slice(2)}`,
            syncOptions: { syncIntervalMs: 30 },
            ...adapterOverrides,
        });
        await db.sync.enable(true);
        return db;
    };

    beforeEach(() => {
        resetDeterministicUUID();
    });

    // -------------------------------------------------------------------------
    it('collection.modify(object) pushes update to server', async () => {
        const { apis, server } = makeApis();
        const db = await createDb(apis);

        try {
            const { localId } = await addRecordAndGetLocalId(db, 'fish', { name: 'nemo', age: 1 });
            await waitForSyncIdle(db, 3000);

            // Rename via collection modify
            const table = db.table('fish');
            await table.where(LOCAL_PK).equals(localId).modify({ name: 'dory' });

            await waitForSyncIdle(db, 3000);

            // Local record reflects new name
            const local = await table.get(localId);
            expect(local?.name).toBe('dory');

            // Server has been updated
            const serverRec = server.find((r) => !r.deleted);
            expect(serverRec?.name).toBe('dory');
            expect(apis.fish.update).toHaveBeenCalledTimes(1);
        } finally {
            await db.sync.enable(false);
            await db.close();
        }
    });

    // -------------------------------------------------------------------------
    it('collection.modify(fn) pushes update to server', async () => {
        const { apis, server } = makeApis();
        const db = await createDb(apis);

        try {
            const { localId } = await addRecordAndGetLocalId(db, 'fish', { name: 'nemo', age: 1 });
            await waitForSyncIdle(db, 3000);

            // Increment age via function-based modify
            const table = db.table('fish');
            await table
                .where(LOCAL_PK)
                .equals(localId)
                .modify((item: any) => {
                    item.age = item.age + 10;
                });

            await waitForSyncIdle(db, 3000);

            const local = await table.get(localId);
            expect(local?.age).toBe(11);

            const serverRec = server.find((r) => !r.deleted);
            expect(serverRec?.age).toBe(11);
            expect(apis.fish.update).toHaveBeenCalledTimes(1);
        } finally {
            await db.sync.enable(false);
            await db.close();
        }
    });

    // -------------------------------------------------------------------------
    it('collection.delete() pushes remove to server', async () => {
        const { apis, server } = makeApis();
        const db = await createDb(apis);

        try {
            const { localId } = await addRecordAndGetLocalId(db, 'fish', { name: 'nemo', age: 1 });
            await waitForSyncIdle(db, 3000);

            // Delete via collection
            const table = db.table('fish');
            const deleted = await table.where(LOCAL_PK).equals(localId).delete();
            expect(deleted).toBe(1);

            await waitForSyncIdle(db, 3000);

            // Locally gone
            const local = await table.get(localId);
            expect(local).toBeUndefined();

            // Server soft-deleted
            const serverRec = server[0];
            expect(serverRec?.deleted).toBe(true);
            expect(apis.fish.remove).toHaveBeenCalledTimes(1);
        } finally {
            await db.sync.enable(false);
            await db.close();
        }
    });

    // -------------------------------------------------------------------------
    it('collection.modify(object) on multiple records pushes all updates', async () => {
        const { apis, server } = makeApis();
        const db = await createDb(apis);

        try {
            const table = db.table('fish');
            await table.add({ name: 'alpha', age: 5 } as any);
            await table.add({ name: 'beta', age: 5 } as any);
            await table.add({ name: 'gamma', age: 99 } as any);
            await waitForSyncIdle(db, 3000);

            // Rename all age-5 fish
            await table.where('age').equals(5).modify({ name: 'renamed' });
            await waitForSyncIdle(db, 3000);

            const updatedOnServer = server.filter((r) => !r.deleted && r.name === 'renamed');
            expect(updatedOnServer).toHaveLength(2);

            const unchanged = server.find((r) => !r.deleted && r.name === 'gamma');
            expect(unchanged).toBeDefined();

            // Two update calls
            expect(apis.fish.update).toHaveBeenCalledTimes(2);
        } finally {
            await db.sync.enable(false);
            await db.close();
        }
    });

    // -------------------------------------------------------------------------
    it('chained collection.limit().modify() only updates the limited set', async () => {
        const { apis, server } = makeApis();
        const db = await createDb(apis);

        try {
            const table = db.table('fish');
            await table.add({ name: 'one', age: 3 } as any);
            await table.add({ name: 'two', age: 3 } as any);
            await waitForSyncIdle(db, 3000);

            // Only modify 1 of the 2 age-3 fish
            await table.where('age').equals(3).limit(1).modify({ name: 'limited' });
            await waitForSyncIdle(db, 3000);

            const renamed = server.filter((r) => !r.deleted && r.name === 'limited');
            expect(renamed).toHaveLength(1);
            expect(apis.fish.update).toHaveBeenCalledTimes(1);
        } finally {
            await db.sync.enable(false);
            await db.close();
        }
    });

    // -------------------------------------------------------------------------
    it('collection.delete() on multiple records removes all from server', async () => {
        const { apis, server } = makeApis();
        const db = await createDb(apis);

        try {
            const table = db.table('fish');
            await table.add({ name: 'doomed-a', age: 7 } as any);
            await table.add({ name: 'doomed-b', age: 7 } as any);
            await table.add({ name: 'survivor', age: 8 } as any);
            await waitForSyncIdle(db, 3000);

            const count = await table.where('age').equals(7).delete();
            expect(count).toBe(2);

            await waitForSyncIdle(db, 3000);

            const active = server.filter((r) => !r.deleted);
            expect(active).toHaveLength(1);
            expect(active[0]?.name).toBe('survivor');
            expect(apis.fish.remove).toHaveBeenCalledTimes(2);
        } finally {
            await db.sync.enable(false);
            await db.close();
        }
    });
});
