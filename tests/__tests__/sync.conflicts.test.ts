import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getRecordByLocalId, updateRecordByLocalId, waitForSyncIdle, runSyncCycle, syncModeScenarios, type SyncModeScenario } from '../helpers/dyncHarness';
import { installDeterministicUUID, resetDeterministicUUID, wait, waitUntil } from '../helpers/testUtils';
import { getAdapterOverrides, storageAdapterMatrix } from '../helpers/storageAdapters';
import { buildSQLiteSyncTableDefinition } from '../helpers/sqliteStructuredSchemas';
import type { SQLiteTableDefinition, TableSchemaDefinition } from '../../src/storage/sqlite/schema';
import type { StorageAdapter } from '../../src/storage/types';

installDeterministicUUID();

type Item = {
    id?: number;
    _localId: string;
    name: string;
    updated_at: string;
    extra?: string;
};

type Tables = {
    items: Item;
};

const conflictSchema = {
    items: 'name, extra',
} as const;

const sqliteConflictSchema: Record<keyof Tables, SQLiteTableDefinition> = {
    items: buildSQLiteSyncTableDefinition({
        extra: { type: 'TEXT', nullable: true },
    }),
};

function buildApis(latency = 10) {
    let idCounter = 0;
    const server: any[] = [];

    return {
        server,
        apis: {
            items: {
                add: vi.fn(async (item: any) => {
                    await wait(latency);
                    const rec = { id: ++idCounter, ...item, updated_at: new Date().toISOString() };
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
                firstLoad: vi.fn(async (_lastId: any) => []),
            },
        },
    } as const;
}

interface CreateConflictDbOptions {
    dbName?: string;
    storageAdapterFactory: (dbName: string) => StorageAdapter;
    schema?: Record<keyof Tables, TableSchemaDefinition>;
}

async function createDb(
    apis: any,
    conflictStrategy: 'local-wins' | 'remote-wins' | 'try-shallow-merge',
    options: CreateConflictDbOptions,
    syncMode: SyncModeScenario = syncModeScenarios[0]!,
) {
    const { dbName: providedDbName, storageAdapterFactory, schema = conflictSchema } = options;
    const dbName = providedDbName ?? `conflict-${conflictStrategy}-${Math.random().toString(36).slice(2)}`;
    const createFn = syncMode.createDync;
    const db = await createFn<Tables>(apis, schema as Record<keyof Tables, TableSchemaDefinition>, {
        dbName,
        storageAdapterFactory,
        syncOptions: {
            conflictResolutionStrategy: conflictStrategy,
            syncInterval: 50,
        },
    });
    await db.sync.enable(true);
    return db;
}

async function pullInitialRecord(db: any, server: any[]) {
    await wait(120);
    await waitForSyncIdle(db, 4000);
    expect(server.length).toBeGreaterThan(0);
    const local = await db.table('items').where('id').equals(server[0].id).first();
    expect(local).toBeTruthy();
    return local!;
}

// Build combined matrix: each storage adapter × each sync mode
const combinedMatrix = storageAdapterMatrix.flatMap(([label, scenario]) =>
    syncModeScenarios.map((syncMode) => [`${label} / ${syncMode.label}`, scenario, syncMode] as const),
);

describe.each(combinedMatrix)('Dync conflict resolution (%s)', (_label, scenario, syncMode) => {
    const adapterOverrides = getAdapterOverrides(scenario);
    const schema = (scenario.key === 'sqlite' ? sqliteConflictSchema : conflictSchema) as Record<keyof Tables, TableSchemaDefinition>;

    beforeEach(() => {
        resetDeterministicUUID();
    });

    it('local-wins keeps local change when remote also modified', async () => {
        const { apis, server } = buildApis();
        server.push({ id: 1, name: 'srv', updated_at: new Date().toISOString() });
        const db = await createDb(
            apis,
            'local-wins',
            {
                dbName: `conflict-local-wins-${scenario.key}-${syncMode.key}-${Math.random().toString(36).slice(2)}`,
                storageAdapterFactory: adapterOverrides.storageAdapterFactory,
                schema,
            },
            syncMode,
        );

        try {
            const local = await pullInitialRecord(db, server);
            const localId = local._localId;

            await db.sync.enable(false);
            await updateRecordByLocalId(db, 'items', localId, { name: 'local-change' });

            server[0].name = 'remote-change';
            server[0].updated_at = new Date(Date.now() + 50).toISOString();

            await db.sync.enable(true);
            await runSyncCycle(db, { timeout: 4000, keepEnabled: true });
            await waitForSyncIdle(db, 4000);

            const final = await getRecordByLocalId(db, 'items', localId);
            expect(final?.name).toBe('local-change');
        } finally {
            await db.sync.enable(false);
            await db.close();
        }
    });

    it('remote-wins overwrites local change when remote modified', async () => {
        const { apis, server } = buildApis();
        server.push({ id: 1, name: 'srv', updated_at: new Date().toISOString() });
        const db = await createDb(
            apis,
            'remote-wins',
            {
                dbName: `conflict-remote-wins-${scenario.key}-${syncMode.key}-${Math.random().toString(36).slice(2)}`,
                storageAdapterFactory: adapterOverrides.storageAdapterFactory,
                schema,
            },
            syncMode,
        );

        try {
            const local = await pullInitialRecord(db, server);
            const localId = local._localId;

            await db.sync.enable(false);
            await updateRecordByLocalId(db, 'items', localId, { name: 'local-change' });

            server[0].name = 'remote-change';
            server[0].updated_at = new Date(Date.now() + 50).toISOString();

            await db.sync.enable(true);
            await runSyncCycle(db, { timeout: 4000, keepEnabled: true });
            await waitForSyncIdle(db, 4000);

            const final = await getRecordByLocalId(db, 'items', localId);
            expect(final?.name).toBe('remote-change');
        } finally {
            await db.sync.enable(false);
            await db.close();
        }
    });

    it('try-shallow-merge records conflicts when both sides mutate same field', async () => {
        const { apis, server } = buildApis();
        server.push({ id: 1, name: 'srv', updated_at: new Date().toISOString() });
        const db = await createDb(
            apis,
            'try-shallow-merge',
            {
                dbName: `conflict-shallow-${scenario.key}-${syncMode.key}-${Math.random().toString(36).slice(2)}`,
                storageAdapterFactory: adapterOverrides.storageAdapterFactory,
                schema,
            },
            syncMode,
        );

        try {
            const local = await pullInitialRecord(db, server);
            const localId = local._localId;

            await db.sync.enable(false);
            await updateRecordByLocalId(db, 'items', localId, { name: 'local-change' });

            server[0].name = 'remote-change';
            server[0].updated_at = new Date(Date.now() + 50).toISOString();

            await db.sync.enable(true);
            await runSyncCycle(db, { timeout: 2000, keepEnabled: true });
            await waitUntil(() => !!db.sync.state.conflicts?.[localId], 2000);

            const conflicts = db.sync.state.conflicts;
            expect(conflicts?.[localId]).toBeDefined();
            expect(conflicts?.[localId]?.fields?.length).toBeGreaterThan(0);
        } finally {
            await db.sync.enable(false);
            await db.close();
        }
    });

    it('try-shallow-merge merges non-conflicting fields from remote', async () => {
        const { apis, server } = buildApis();
        server.push({ id: 1, name: 'srv', extra: 'x', updated_at: new Date(Date.now() - 10_000).toISOString() });
        const db = await createDb(
            apis,
            'try-shallow-merge',
            {
                dbName: `conflict-merge-${scenario.key}-${syncMode.key}-${Math.random().toString(36).slice(2)}`,
                storageAdapterFactory: adapterOverrides.storageAdapterFactory,
                schema,
            },
            syncMode,
        );

        try {
            const local = await pullInitialRecord(db, server);
            const localId = local._localId;

            await db.sync.enable(false);
            await updateRecordByLocalId(db, 'items', localId, { name: 'local-change' });

            server[0].extra = 'remote-extra';
            server[0].updated_at = new Date(Date.now() + 50).toISOString();

            await db.sync.enable(true);
            await runSyncCycle(db, { timeout: 4000, keepEnabled: true });
            await waitForSyncIdle(db, 4000);

            const final = await getRecordByLocalId(db, 'items', localId);
            expect(final?.name).toBe('local-change');
            expect(final?.extra).toBe('remote-extra');
            expect(db.sync.state.conflicts?.[localId]).toBeUndefined();
        } finally {
            await db.sync.enable(false);
            await db.close();
        }
    });
});
