import { createLocalId } from '../helpers';
import { SyncAction, type MutationEvent, type SyncedRecord } from '../types';
import type { AddItem, StorageTable } from '../storage/types';
import { DYNC_STATE_TABLE, type StateHelpers } from './StateManager';
import type { WithTransaction } from './types';
export type EmitMutation = (event: MutationEvent) => void;

/**
 * Wraps a table with mutation emission for reactive updates and auto-generates _localId.
 * This allows useLiveQuery to work with any table.
 */
export function wrapWithMutationEmitter<T>(table: StorageTable<T>, tableName: string, emitMutation: EmitMutation): void {
    const rawAdd = table.raw.add;
    const rawPut = table.raw.put;
    const rawUpdate = table.raw.update;
    const rawDelete = table.raw.delete;
    const rawBulkAdd = table.raw.bulkAdd;
    const rawBulkPut = table.raw.bulkPut;
    const rawBulkUpdate = table.raw.bulkUpdate;
    const rawBulkDelete = table.raw.bulkDelete;
    const rawClear = table.raw.clear;

    table.add = async (item: AddItem<T>) => {
        const itemWithLocalId = { ...item, _localId: (item as any)._localId || createLocalId() } as T;
        const result = await rawAdd(itemWithLocalId);
        emitMutation({ type: 'add', tableName, keys: [result] });
        return result;
    };

    table.put = async (item: T) => {
        const itemWithLocalId = { ...item, _localId: (item as any)._localId || createLocalId() } as T;
        const result = await rawPut(itemWithLocalId);
        emitMutation({ type: 'update', tableName, keys: [result] });
        return result;
    };

    table.update = async (key: string, changes: Partial<T>) => {
        const result = await rawUpdate(key, changes);
        if (result > 0) {
            emitMutation({ type: 'update', tableName, keys: [key] });
        }
        return result;
    };

    table.delete = async (key: string) => {
        await rawDelete(key);
        emitMutation({ type: 'delete', tableName, keys: [key] });
    };

    table.bulkAdd = async (items: AddItem<T>[]) => {
        const itemsWithLocalIds = items.map((item) => ({
            ...item,
            _localId: (item as any)._localId || createLocalId(),
        })) as T[];
        const result = await rawBulkAdd(itemsWithLocalIds);
        if (items.length > 0) {
            emitMutation({ type: 'add', tableName });
        }
        return result;
    };

    table.bulkPut = async (items: T[]) => {
        const itemsWithLocalIds = items.map((item) => ({
            ...item,
            _localId: (item as any)._localId || createLocalId(),
        })) as T[];
        const result = await rawBulkPut(itemsWithLocalIds);
        if (items.length > 0) {
            emitMutation({ type: 'update', tableName });
        }
        return result;
    };

    table.bulkUpdate = async (keysAndChanges: Array<{ key: string; changes: Partial<T> }>) => {
        const result = await rawBulkUpdate(keysAndChanges);
        if (result > 0) {
            emitMutation({ type: 'update', tableName, keys: keysAndChanges.map((kc) => kc.key) });
        }
        return result;
    };

    table.bulkDelete = async (keys: string[]) => {
        await rawBulkDelete(keys);
        if (keys.length > 0) {
            emitMutation({ type: 'delete', tableName });
        }
    };

    table.clear = async () => {
        await rawClear();
        emitMutation({ type: 'delete', tableName });
    };
}

interface SetupOptions {
    owner: object;
    tableCache: Map<string, StorageTable<any>>;
    enhancedTables: Set<string>;
    getTable: (name: string) => StorageTable<any>;
}

export function setupEnhancedTables({ owner, tableCache, enhancedTables, getTable }: SetupOptions, tableNames: string[]): void {
    for (const tableName of tableNames) {
        tableCache.delete(tableName);
        enhancedTables.delete(tableName);

        if (!Object.prototype.hasOwnProperty.call(owner, tableName)) {
            Object.defineProperty(owner, tableName, {
                get: () => getTable(tableName),
                enumerable: true,
                configurable: true,
            });
        }
    }
}

interface EnhanceOptions<T> {
    table: StorageTable<T & SyncedRecord>;
    tableName: string;
    withTransaction: WithTransaction;
    state: StateHelpers;
    enhancedTables: Set<string>;
    emitMutation: EmitMutation;
}

export function enhanceSyncTable<T>({ table, tableName, withTransaction, state, enhancedTables, emitMutation }: EnhanceOptions<T>): void {
    const rawAdd = table.raw.add;
    const rawPut = table.raw.put;
    const rawUpdate = table.raw.update;
    const rawDelete = table.raw.delete;
    const rawBulkAdd = table.raw.bulkAdd;
    const rawBulkPut = table.raw.bulkPut;
    const rawBulkUpdate = table.raw.bulkUpdate;
    const rawBulkDelete = table.raw.bulkDelete;
    const rawClear = table.raw.clear;

    const wrappedAdd = async (item: any) => {
        let localId = item._localId;
        if (!localId) localId = createLocalId();

        const syncedItem = {
            ...item,
            _localId: localId,
            updated_at: new Date().toISOString(),
        };

        let result!: string;
        await withTransaction('rw', [tableName, DYNC_STATE_TABLE], async () => {
            result = await rawAdd(syncedItem);

            await state.addPendingChange({
                action: SyncAction.Create,
                tableName,
                localId,
                changes: syncedItem,
                before: null,
                after: syncedItem,
            });
        });

        emitMutation({ type: 'add', tableName, keys: [localId] });
        return result;
    };

    const wrappedPut = async (item: any) => {
        let localId = item._localId;
        if (!localId) localId = createLocalId();

        const syncedItem = {
            ...item,
            _localId: localId,
            updated_at: new Date().toISOString(),
        };

        let result!: string;
        let isUpdate = false;
        let existingRecord: any;

        await withTransaction('rw', [tableName, DYNC_STATE_TABLE], async (tables) => {
            const txTable = tables[tableName]!;
            existingRecord = await txTable.get(localId);
            isUpdate = !!existingRecord;

            result = await rawPut(syncedItem);

            await state.addPendingChange({
                action: isUpdate ? SyncAction.Update : SyncAction.Create,
                tableName,
                localId,
                id: existingRecord?.id,
                changes: syncedItem,
                before: existingRecord ?? null,
                after: syncedItem,
            });
        });

        emitMutation({ type: isUpdate ? 'update' : 'add', tableName, keys: [localId] });
        return result;
    };

    const wrappedUpdate = async (key: any, changes: any) => {
        const updatedChanges = {
            ...changes,
            updated_at: new Date().toISOString(),
        };

        let result = 0;
        await withTransaction('rw', [tableName, DYNC_STATE_TABLE], async (tables) => {
            const txTable = tables[tableName]!;
            const record = await txTable.get(key);
            if (!record) {
                throw new Error(`Record with key=${key} not found`);
            }

            result = (await rawUpdate(key, updatedChanges as any)) ?? 0;
            if (result > 0) {
                await state.addPendingChange({
                    action: SyncAction.Update,
                    tableName,
                    localId: key,
                    id: record.id,
                    changes: updatedChanges,
                    before: record,
                    after: { ...record, ...updatedChanges },
                });
            }
        });

        if (result > 0) {
            emitMutation({ type: 'update', tableName, keys: [key] });
        }
        return result;
    };

    const wrappedDelete = async (key: any) => {
        let deletedLocalId: string | undefined;
        await withTransaction('rw', [tableName, DYNC_STATE_TABLE], async (tables) => {
            const txTable = tables[tableName]!;
            const record = await txTable.get(key);

            await rawDelete(key);

            if (record) {
                deletedLocalId = record._localId;
                await state.addPendingChange({
                    action: SyncAction.Remove,
                    tableName,
                    localId: record._localId,
                    id: record.id,
                    changes: null,
                    before: record,
                });
            }
        });

        if (deletedLocalId) {
            emitMutation({ type: 'delete', tableName, keys: [deletedLocalId] });
        }
    };

    const wrappedBulkAdd = async (items: any[]): Promise<string[]> => {
        if (items.length === 0) return [];

        const now = new Date().toISOString();
        const syncedItems = items.map((item) => {
            const localId = item._localId || createLocalId();
            return {
                ...item,
                _localId: localId,
                updated_at: now,
            };
        });

        let result!: string[];
        await withTransaction('rw', [tableName, DYNC_STATE_TABLE], async () => {
            result = await rawBulkAdd(syncedItems);

            for (const syncedItem of syncedItems) {
                await state.addPendingChange({
                    action: SyncAction.Create,
                    tableName,
                    localId: syncedItem._localId,
                    changes: syncedItem,
                    before: null,
                    after: syncedItem,
                });
            }
        });

        emitMutation({ type: 'add', tableName, keys: syncedItems.map((i) => i._localId) });
        return result;
    };

    const wrappedBulkPut = async (items: any[]): Promise<string[]> => {
        if (items.length === 0) return [];

        const now = new Date().toISOString();
        const syncedItems = items.map((item) => {
            const localId = item._localId || createLocalId();
            return {
                ...item,
                _localId: localId,
                updated_at: now,
            };
        });
        const localIds = syncedItems.map((i) => i._localId);

        let result!: string[];
        await withTransaction('rw', [tableName, DYNC_STATE_TABLE], async (tables) => {
            const txTable = tables[tableName]!;

            // Check which items already exist
            const existingRecords = await txTable.bulkGet(localIds);
            const existingMap = new Map<string, any>();
            for (let i = 0; i < localIds.length; i++) {
                if (existingRecords[i]) {
                    existingMap.set(localIds[i], existingRecords[i]);
                }
            }

            result = await rawBulkPut(syncedItems);

            for (const syncedItem of syncedItems) {
                const existing = existingMap.get(syncedItem._localId);
                await state.addPendingChange({
                    action: existing ? SyncAction.Update : SyncAction.Create,
                    tableName,
                    localId: syncedItem._localId,
                    id: existing?.id,
                    changes: syncedItem,
                    before: existing ?? null,
                    after: syncedItem,
                });
            }
        });

        emitMutation({ type: 'update', tableName, keys: localIds });
        return result;
    };

    const wrappedBulkUpdate = async (keysAndChanges: Array<{ key: any; changes: any }>) => {
        if (keysAndChanges.length === 0) return 0;

        const now = new Date().toISOString();
        const updatedKeysAndChanges = keysAndChanges.map(({ key, changes }) => ({
            key,
            changes: {
                ...changes,
                updated_at: now,
            },
        }));

        let result = 0;
        const updatedKeys: string[] = [];

        await withTransaction('rw', [tableName, DYNC_STATE_TABLE], async (tables) => {
            const txTable = tables[tableName]!;

            // Get all records before updating
            const keys = updatedKeysAndChanges.map((kc) => kc.key);
            const records = await txTable.bulkGet(keys);
            const recordMap = new Map<string, any>();
            for (let i = 0; i < keys.length; i++) {
                if (records[i]) {
                    recordMap.set(String(keys[i]), records[i]);
                }
            }

            result = await rawBulkUpdate(updatedKeysAndChanges);

            for (const { key, changes } of updatedKeysAndChanges) {
                const record = recordMap.get(String(key));
                if (record) {
                    updatedKeys.push(record._localId);
                    await state.addPendingChange({
                        action: SyncAction.Update,
                        tableName,
                        localId: record._localId,
                        id: record.id,
                        changes,
                        before: record,
                        after: { ...record, ...changes },
                    });
                }
            }
        });

        if (updatedKeys.length > 0) {
            emitMutation({ type: 'update', tableName, keys: updatedKeys });
        }
        return result;
    };

    const wrappedBulkDelete = async (keys: any[]) => {
        if (keys.length === 0) return;

        const deletedLocalIds: string[] = [];
        await withTransaction('rw', [tableName, DYNC_STATE_TABLE], async (tables) => {
            const txTable = tables[tableName]!;

            // Get all records before deleting
            const records = await txTable.bulkGet(keys);

            await rawBulkDelete(keys);

            for (const record of records) {
                if (record) {
                    deletedLocalIds.push(record._localId);
                    await state.addPendingChange({
                        action: SyncAction.Remove,
                        tableName,
                        localId: record._localId,
                        id: record.id,
                        changes: null,
                        before: record,
                    });
                }
            }
        });

        if (deletedLocalIds.length > 0) {
            emitMutation({ type: 'delete', tableName, keys: deletedLocalIds });
        }
    };

    const wrappedClear = async () => {
        const deletedLocalIds: string[] = [];
        await withTransaction('rw', [tableName, DYNC_STATE_TABLE], async (tables) => {
            const txTable = tables[tableName]!;

            // Get all records before clearing
            const allRecords = await txTable.toArray();

            await rawClear();

            for (const record of allRecords) {
                if (record._localId) {
                    deletedLocalIds.push(record._localId);
                    await state.addPendingChange({
                        action: SyncAction.Remove,
                        tableName,
                        localId: record._localId,
                        id: record.id,
                        changes: null,
                        before: record,
                    });
                }
            }
        });

        if (deletedLocalIds.length > 0) {
            emitMutation({ type: 'delete', tableName, keys: deletedLocalIds });
        }
    };

    table.add = wrappedAdd;
    table.put = wrappedPut;
    table.update = wrappedUpdate;
    table.delete = wrappedDelete;
    table.bulkAdd = wrappedBulkAdd;
    table.bulkPut = wrappedBulkPut;
    table.bulkUpdate = wrappedBulkUpdate;
    table.bulkDelete = wrappedBulkDelete;
    table.clear = wrappedClear;

    enhancedTables.add(tableName);
}
