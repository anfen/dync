import { Dync, type ApiFunctions, type BatchSync, type SyncOptions } from '../../src/index';
import type { StorageAdapter } from '../../src/storage/types';
import { waitUntil } from './testUtils';
import type { TableSchemaDefinition } from '../../src/storage/sqlite/schema';
import { LOCAL_PK } from '../../src/types';

export interface CreateDyncOptions {
    dbName?: string;
    syncOptions?: Partial<SyncOptions>;
    storageAdapterFactory: (dbName: string) => StorageAdapter;
}

async function createTestDyncInternal<TTables extends Record<string, any>>(
    sync: Record<string, ApiFunctions> | BatchSync,
    schema: Record<keyof TTables, TableSchemaDefinition>,
    options: CreateDyncOptions,
): Promise<Dync<TTables>> {
    const dbName = options.dbName ?? `dync-spec-${Math.random().toString(36).slice(2)}`;
    const syncOptions: SyncOptions = {
        syncInterval: 25,
        minLogLevel: 'none',
        logger: console,
        missingRemoteRecordDuringUpdateStrategy: 'ignore',
        conflictResolutionStrategy: 'try-shallow-merge',
        ...options.syncOptions,
    };
    const storageAdapter = options.storageAdapterFactory(dbName);

    const db = new Dync<TTables>(dbName, sync as any, storageAdapter, syncOptions);
    db.version(1).stores(schema as Record<string, TableSchemaDefinition>);
    return db;
}

export async function createTestDync<TTables extends Record<string, any>>(
    apis: Record<string, ApiFunctions>,
    schema: Record<keyof TTables, TableSchemaDefinition>,
    options: CreateDyncOptions,
): Promise<Dync<TTables>> {
    return createTestDyncInternal<TTables>(apis, schema, options);
}

/**
 * Convert per-table APIs to a BatchSync object for batch mode testing.
 */
export function apisToBatchSync(apis: Record<string, ApiFunctions>): BatchSync {
    const syncTables = Object.keys(apis);

    return {
        syncTables,
        push: async (changes) => {
            const results = [];
            for (const change of changes) {
                const api = apis[change.table];
                if (!api) {
                    results.push({ localId: change.localId, success: false, error: `Unknown table: ${change.table}` });
                    continue;
                }

                try {
                    switch (change.action) {
                        case 'add': {
                            const result = await api.add(change.data);
                            results.push({
                                localId: change.localId,
                                success: true,
                                id: result?.id,
                                updated_at: result?.updated_at,
                            });
                            break;
                        }
                        case 'update': {
                            const success = await api.update(change.id, change.data, change.data);
                            results.push({ localId: change.localId, success });
                            break;
                        }
                        case 'remove': {
                            await api.remove(change.id);
                            results.push({ localId: change.localId, success: true });
                            break;
                        }
                    }
                } catch (err: any) {
                    results.push({ localId: change.localId, success: false, error: err.message });
                }
            }
            return results;
        },
        pull: async (since) => {
            const result: Record<string, any[]> = {};
            for (const [table, api] of Object.entries(apis)) {
                const sinceDate = since[table] ?? new Date(0);
                result[table] = await api.list(sinceDate);
            }
            return result;
        },
        firstLoad: async (cursors) => {
            const data: Record<string, any[]> = {};
            const newCursors: Record<string, any> = {};
            let hasMore = false;

            for (const [table, api] of Object.entries(apis)) {
                if (api.firstLoad) {
                    const cursor = cursors[table];
                    const records = await api.firstLoad(cursor);
                    data[table] = records;
                    if (records.length > 0) {
                        newCursors[table] = records[records.length - 1].id;
                        hasMore = true;
                    } else {
                        newCursors[table] = cursor;
                    }
                } else {
                    data[table] = [];
                    newCursors[table] = cursors[table];
                }
            }

            return { data, cursors: newCursors, hasMore };
        },
    };
}

export async function createTestDyncBatch<TTables extends Record<string, any>>(
    apis: Record<string, ApiFunctions>,
    schema: Record<keyof TTables, TableSchemaDefinition>,
    options: CreateDyncOptions,
): Promise<Dync<TTables>> {
    const batchSync = apisToBatchSync(apis);
    return createTestDyncInternal<TTables>(batchSync, schema, options);
}

/** Sync mode scenario for parameterized tests */
export interface SyncModeScenario {
    key: 'per-table' | 'batch';
    label: string;
    createDync: typeof createTestDync;
}

export const syncModeScenarios: SyncModeScenario[] = [
    { key: 'per-table', label: 'per-table sync', createDync: createTestDync },
    { key: 'batch', label: 'batch sync', createDync: createTestDyncBatch },
];

export const syncModeMatrix = syncModeScenarios.map((scenario) => [scenario.label, scenario] as const);

export async function addRecordAndGetLocalId<TTables extends Record<string, any>>(
    db: Dync<TTables>,
    tableName: keyof TTables,
    data: any,
): Promise<{ localId: string; record: any }> {
    const table = db.table(tableName as string);
    const primaryKey = await table.add(data);
    const record = await table.get(primaryKey);
    if (!record?._localId) {
        throw new Error('Record missing _localId after add');
    }
    return { localId: record._localId as string, record };
}

export async function getRecordByLocalId<TTables extends Record<string, any>>(
    db: Dync<TTables>,
    tableName: keyof TTables,
    localId: string,
): Promise<any | undefined> {
    const table = db.table(tableName as string);
    return table.where(LOCAL_PK).equals(localId).first();
}

export async function updateRecordByLocalId<TTables extends Record<string, any>>(
    db: Dync<TTables>,
    tableName: keyof TTables,
    localId: string,
    changes: any,
): Promise<boolean> {
    const table = db.table(tableName as string);
    const record = await table.where(LOCAL_PK).equals(localId).first();
    if (!record) return false;
    await table.update(record._localId, changes);
    return true;
}

export async function removeRecordByLocalId<TTables extends Record<string, any>>(
    db: Dync<TTables>,
    tableName: keyof TTables,
    localId: string,
): Promise<boolean> {
    const table = db.table(tableName as string);
    const record = await table.where(LOCAL_PK).equals(localId).first();
    if (!record) return false;
    await table.delete(record._localId);
    return true;
}

export async function waitForSyncIdle<TTables extends Record<string, any>>(db: Dync<TTables>, timeout = 2000, pollInterval = 25): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const state = db.sync.getState();
        const pending = state.pendingChanges ?? [];
        if (state.status !== 'syncing') {
            const unresolvedPending = pending.filter((change) => !state.conflicts || !state.conflicts[change.localId]);
            if (unresolvedPending.length === 0) {
                return;
            }
        }
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
    throw new Error('Timed out waiting for sync to become idle');
}

export async function runSyncCycle<TTables extends Record<string, any>>(
    db: Dync<TTables>,
    options: { timeout?: number; keepEnabled?: boolean } = {},
): Promise<void> {
    const { timeout = 2000, keepEnabled = false } = options;
    const initialState = db.sync.getState();
    const wasDisabled = initialState.status === 'disabled';
    const wasSyncing = initialState.status === 'syncing';
    const hadPending = (initialState.pendingChanges?.length ?? 0) > 0;

    if (wasSyncing) {
        await waitForSyncIdle(db, timeout);
        return;
    }

    if (wasDisabled) {
        await db.sync.enable(true);
    }

    if (wasDisabled && hadPending) {
        await waitUntil(() => db.sync.getState().status === 'syncing', timeout);
    }

    await waitForSyncIdle(db, timeout);

    if (wasDisabled && !keepEnabled) {
        await db.sync.enable(false);
    }
}

export async function requestSyncOnce<TTables extends Record<string, any>>(
    db: Dync<TTables>,
    options: { timeout?: number; keepEnabled?: boolean } = {},
): Promise<void> {
    const state = db.sync.getState();
    if (state.status === 'syncing') {
        return;
    }

    await runSyncCycle(db, options);
}
