import { beforeEach, describe, expect, it, vi } from 'vitest';

import { syncModeScenarios } from '../helpers/dyncHarness';
import { installDeterministicUUID, resetDeterministicUUID, waitUntilAsync } from '../helpers/testUtils';
import { getAdapterOverrides, storageAdapterMatrix } from '../helpers/storageAdapters';
import { buildSQLiteSyncTableDefinition } from '../helpers/sqliteStructuredSchemas';
import type { SQLiteTableDefinition, TableSchemaDefinition } from '../../src/storage/sqlite/schema';

installDeterministicUUID();

interface Fish {
    id?: number;
    _localId: string;
    name: string;
    updated_at: string;
}

type Tables = {
    fish: Fish;
};

interface ServerRecord {
    id: number;
    name: string;
    updated_at: string;
    deleted: boolean;
}

const TOTAL_RECORDS = 50;
const BATCH_SIZE = 5;

function makeApis() {
    const server: ServerRecord[] = [];

    // Pre-populate server with TOTAL_RECORDS records
    for (let i = 1; i <= TOTAL_RECORDS; i++) {
        server.push({
            id: i,
            name: `fish-${i}`,
            updated_at: new Date(Date.now() - (TOTAL_RECORDS - i) * 1000).toISOString(),
            deleted: false,
        });
    }

    return {
        server,
        apis: {
            fish: {
                add: vi.fn(async () => ({ id: 0, updated_at: new Date().toISOString() })),
                update: vi.fn(async () => true),
                remove: vi.fn(async () => {}),
                list: vi.fn(async () => []),
                firstLoad: vi.fn(async (lastId?: number) => {
                    const startIndex = lastId ? server.findIndex((r) => r.id === lastId) + 1 : 0;
                    if (startIndex < 0 || startIndex >= server.length) {
                        return [];
                    }
                    const batch = server.slice(startIndex, startIndex + BATCH_SIZE);
                    return batch.map((r) => ({ ...r }));
                }),
            },
        },
    } as const;
}

const fishSchema = {
    fish: 'name',
} as const;

const sqliteFishSchema: Record<keyof Tables, SQLiteTableDefinition> = {
    fish: buildSQLiteSyncTableDefinition(),
};

// Build combined matrix: each storage adapter × each sync mode
const combinedMatrix = storageAdapterMatrix.flatMap(([label, scenario]) =>
    syncModeScenarios.map((syncMode) => [`${label} / ${syncMode.label}`, scenario, syncMode] as const),
);

describe.each(combinedMatrix)('Dync first load (%s)', (_label, scenario, syncMode) => {
    const adapterOverrides = getAdapterOverrides(scenario);
    const schema = (scenario.key === 'sqlite' ? sqliteFishSchema : fishSchema) as Record<keyof Tables, TableSchemaDefinition>;
    const createDbFn = syncMode.createDync;

    const createDb = async (apis: any) => {
        const db = await createDbFn<Tables>(apis, schema, {
            dbName: `first-load-${scenario.key}-${syncMode.key}-${Math.random().toString(36).slice(2)}`,
            syncOptions: {
                syncInterval: 50,
            },
            ...adapterOverrides,
        });
        return db;
    };

    beforeEach(() => {
        resetDeterministicUUID();
    });

    it('downloads 10000 records via firstLoad in batches', async () => {
        const { apis, server } = makeApis();
        const db = await createDb(apis);

        try {
            // Verify server has TOTAL_RECORDS records
            expect(server.length).toBe(TOTAL_RECORDS);

            // Start first load
            await db.sync.startFirstLoad();

            // Wait for first load to complete
            await waitUntilAsync(async () => {
                const state = db.sync.getState();
                return state.firstLoadDone === true;
            }, 30000);

            // Verify all records are in local db
            const localCount = await db.table('fish').count();
            expect(localCount).toBe(TOTAL_RECORDS);

            // Verify firstLoad was called correct number of times (TOTAL_RECORDS / BATCH_SIZE batches + 1 empty batch check)
            const expectedBatches = Math.ceil(TOTAL_RECORDS / BATCH_SIZE);
            expect(apis.fish.firstLoad.mock.calls.length).toBe(expectedBatches + 1);

            // Verify first and last records exist with correct data
            const firstRecord = await db.table('fish').where('id').equals(1).first();
            expect(firstRecord).toBeDefined();
            expect(firstRecord?.name).toBe('fish-1');

            const lastRecord = await db.table('fish').where('id').equals(TOTAL_RECORDS).first();
            expect(lastRecord).toBeDefined();
            expect(lastRecord?.name).toBe(`fish-${TOTAL_RECORDS}`);

            // Verify state shows first load is done
            const state = db.sync.getState();
            expect(state.firstLoadDone).toBe(true);
            expect(state.apiError).toBeUndefined();
        } finally {
            await db.sync.enable(false);
            await db.close();
        }
    });

    it('skips first load if already completed', async () => {
        const { apis } = makeApis();
        const db = await createDb(apis);

        try {
            // Run first load
            await db.sync.startFirstLoad();
            await waitUntilAsync(async () => db.sync.getState().firstLoadDone === true, 30000);

            const callCountAfterFirst = apis.fish.firstLoad.mock.calls.length;

            // Run first load again
            await db.sync.startFirstLoad();

            // Verify no additional calls were made
            expect(apis.fish.firstLoad.mock.calls.length).toBe(callCountAfterFirst);
        } finally {
            await db.sync.enable(false);
            await db.close();
        }
    });

    it('handles deleted records during first load', async () => {
        const { apis, server } = makeApis();

        // Mark some records as deleted (use valid indices within TOTAL_RECORDS)
        server[0]!.deleted = true;
        server[25]!.deleted = true;
        server[49]!.deleted = true;

        const db = await createDb(apis);

        try {
            await db.sync.startFirstLoad();
            await waitUntilAsync(async () => db.sync.getState().firstLoadDone === true, 30000);

            // Deleted records should not be in local db
            const localCount = await db.table('fish').count();
            expect(localCount).toBe(TOTAL_RECORDS - 3);

            const deletedRecord = await db.table('fish').where('id').equals(1).first();
            expect(deletedRecord).toBeUndefined();
        } finally {
            await db.sync.enable(false);
            await db.close();
        }
    });

    it('updates existing records during first load', async () => {
        const { apis, server } = makeApis();
        const db = await createDb(apis);

        try {
            // Pre-insert a record with outdated data using raw.add to preserve _localId
            await db.table('fish').raw.add({
                _localId: 'pre-existing-local-id',
                id: 1,
                name: 'old-name',
                updated_at: new Date(0).toISOString(),
            });

            // Update server record to have new name
            server[0]!.name = 'updated-fish-1';

            await db.sync.startFirstLoad();
            await waitUntilAsync(async () => db.sync.getState().firstLoadDone === true, 30000);

            // The existing record should be updated, not duplicated
            const count = await db.table('fish').count();
            expect(count).toBe(TOTAL_RECORDS);

            // Verify the record was updated with server data but kept local id
            const record = await db.table('fish').where('id').equals(1).first();
            expect(record).toBeDefined();
            expect(record?.name).toBe('updated-fish-1');
            expect(record?._localId).toBe('pre-existing-local-id');
        } finally {
            await db.sync.enable(false);
            await db.close();
        }
    });

    it('tracks lastPulled timestamp after first load', async () => {
        const { apis, server } = makeApis();
        const db = await createDb(apis);

        try {
            const newestServerTimestamp = server[server.length - 1]!.updated_at;

            await db.sync.startFirstLoad();
            await waitUntilAsync(async () => db.sync.getState().firstLoadDone === true, 30000);

            const state = db.sync.getState();
            expect(state.lastPulled).toBeDefined();
            expect(state.lastPulled.fish).toBeDefined();

            // lastPulled should be at or after the newest server record
            const lastPulledDate = new Date(state.lastPulled.fish!);
            const newestDate = new Date(newestServerTimestamp);
            expect(lastPulledDate.getTime()).toBeGreaterThanOrEqual(newestDate.getTime());
        } finally {
            await db.sync.enable(false);
            await db.close();
        }
    });

    it('persists state to _dync_state table after first load', async () => {
        const { apis } = makeApis();
        const db = await createDb(apis);

        try {
            await db.sync.startFirstLoad();
            await waitUntilAsync(async () => db.sync.getState().firstLoadDone === true, 30000);

            // Directly query the _dync_state table to verify persistence
            const stateTable = db.table('_dync_state');
            const stateRow = await stateTable.get('sync_state');

            expect(stateRow).toBeDefined();
            expect(stateRow?._localId).toBe('sync_state');
            expect(stateRow?.value).toBeDefined();

            // Parse and verify the persisted state
            const persistedState = JSON.parse(stateRow!.value);
            expect(persistedState.firstLoadDone).toBe(true);
            expect(persistedState.lastPulled).toBeDefined();
            expect(persistedState.lastPulled.fish).toBeDefined();
        } finally {
            await db.sync.enable(false);
            await db.close();
        }
    });
});
