import { newLogger, type Logger, type LogLevel } from './logger';
import { sleep } from './helpers';
import {
    type CrudSyncApi,
    type BatchSync,
    type DyncOptions,
    type SyncOptions,
    type SyncState,
    type SyncedRecord,
    type MissingRemoteRecordStrategy,
    type ConflictResolutionStrategy,
    type SyncStatus,
    type SyncApi,
    type TableMap,
    type MutationEvent,
    LOCAL_PK,
    SERVER_PK,
    UPDATED_AT,
} from './types';
import { addVisibilityChangeListener } from './addVisibilityChangeListener';
import { type StorageAdapter, type StorageTable, type TransactionMode } from './storage/types';
import type { StorageSchemaDefinitionOptions, SQLiteVersionMigration } from './storage/sqlite/types';
import type { TableSchemaDefinition, SQLiteTableDefinition } from './storage/sqlite/schema';
import { enhanceSyncTable, setupEnhancedTables as setupEnhancedTablesHelper, wrapWithMutationEmitter } from './core/tableEnhancers';
import { pullAll as runPullAll, pullAllBatch as runPullAllBatch } from './core/pullOperations';
import { pushAll as runPushAll, pushAllBatch as runPushAllBatch } from './core/pushOperations';
import { startFirstLoad as runFirstLoad, startFirstLoadBatch as runFirstLoadBatch } from './core/firstLoad';
import type { FirstLoadProgressCallback, VisibilitySubscription } from './types';
import { StateManager, DYNC_STATE_TABLE, type StateHelpers } from './core/StateManager';
import type { MemoryQueryContext } from './storage/memory/MemoryQueryContext';
import type { SQLiteQueryContext } from './storage/sqlite/SQLiteQueryContext';
import type { DexieQueryContext } from './storage/dexie/DexieQueryContext';

const DEFAULT_SYNC_INTERVAL_MILLIS = 2000;
const DEFAULT_LOGGER: Logger = console;
const DEFAULT_MIN_LOG_LEVEL: LogLevel = 'debug';
const DEFAULT_MISSING_REMOTE_RECORD_STRATEGY: MissingRemoteRecordStrategy = 'insert-remote-record';
const DEFAULT_CONFLICT_RESOLUTION_STRATEGY: ConflictResolutionStrategy = 'try-shallow-merge';

class DyncBase<_TStoreMap extends Record<string, any> = Record<string, any>> {
    private readonly adapter: StorageAdapter;
    private readonly tableCache = new Map<string, StorageTable<any>>();
    private readonly mutationWrappedTables = new Set<string>();
    private readonly syncEnhancedTables = new Set<string>();
    private readonly mutationListeners = new Set<(event: MutationEvent) => void>();
    private visibilitySubscription?: VisibilitySubscription;
    private openPromise?: Promise<void>;
    private disableSyncPromise?: Promise<void>;
    private disableSyncPromiseResolver?: () => void;
    private sleepAbortController?: AbortController;
    private closing = false;
    // Per-table sync mode
    private syncApis: Record<string, CrudSyncApi> = {};
    // Batch sync mode
    private batchSync?: BatchSync;
    private syncedTables: Set<string> = new Set();
    private syncOptions: SyncOptions;
    private logger: Logger;
    private syncTimerStarted = false;
    private mutationsDuringSync = false;
    private state!: StateHelpers;
    readonly name: string;

    /**
     * Create a new Dync instance.
     *
     * @example Per-table sync mode
     * ```ts
     * const db = new Dync<Store>({
     *     databaseName: 'my-app',
     *     storageAdapter: new SQLiteAdapter(driver),
     *     sync: { todos: todoSyncApi },
     * });
     * ```
     *
     * @example Batch sync mode
     * ```ts
     * const db = new Dync<Store>({
     *     databaseName: 'my-app',
     *     storageAdapter: new SQLiteAdapter(driver),
     *     sync: { syncTables: ['todos'], push, pull },
     * });
     * ```
     */
    constructor(config: DyncOptions<_TStoreMap>) {
        const { databaseName, storageAdapter, sync: syncConfig, options } = config;

        if (syncConfig) {
            // Detect mode based on whether sync config has batch sync shape
            const isBatchMode = typeof syncConfig.push === 'function' && typeof syncConfig.pull === 'function';

            if (isBatchMode) {
                this.batchSync = syncConfig as BatchSync;
                this.syncedTables = new Set(this.batchSync.syncTables);
            } else {
                this.syncApis = syncConfig as Record<string, CrudSyncApi>;
                this.syncedTables = new Set(Object.keys(this.syncApis));
            }
        }

        this.adapter = storageAdapter;
        this.name = databaseName;
        this.syncOptions = {
            syncInterval: DEFAULT_SYNC_INTERVAL_MILLIS,
            logger: DEFAULT_LOGGER,
            minLogLevel: DEFAULT_MIN_LOG_LEVEL,
            missingRemoteRecordDuringUpdateStrategy: DEFAULT_MISSING_REMOTE_RECORD_STRATEGY,
            conflictResolutionStrategy: DEFAULT_CONFLICT_RESOLUTION_STRATEGY,
            ...(options ?? {}),
        };

        this.logger = newLogger(this.syncOptions.logger!, this.syncOptions.minLogLevel!);
        this.state = new StateManager({
            storageAdapter: this.adapter,
        });

        // Define state getter on sync object (can't use getter syntax in object literal with proper `this` binding)
        Object.defineProperty(this.sync, 'state', {
            get: () => this.getSyncState(),
            enumerable: true,
        });

        const driverInfo = 'driverType' in this.adapter ? ` (Driver: ${this.adapter.driverType})` : '';
        this.logger.debug(`[dync] Initialized with ${this.adapter.type}${driverInfo}`);
    }

    version(versionNumber: number) {
        /* eslint-disable  @typescript-eslint/no-this-alias */
        const self = this;
        const schemaOptions: StorageSchemaDefinitionOptions = {};
        let storesDefined = false;

        const builder = {
            stores(schema: Record<string, TableSchemaDefinition>) {
                // Detect if any user table uses structured schema (for SQLite)
                const usesStructuredSchema = Object.values(schema).some((def) => typeof def !== 'string');

                // Inject internal state table for sync state persistence
                // Use structured schema if user is using structured schema, otherwise use string schema
                // Note: SQLite adapter requires _localId column as primary key
                const stateTableSchema: TableSchemaDefinition = usesStructuredSchema
                    ? {
                          columns: {
                              [LOCAL_PK]: { type: 'TEXT' },
                              value: { type: 'TEXT' },
                          },
                      }
                    : LOCAL_PK;

                const fullSchema: Record<string, TableSchemaDefinition> = {
                    ...schema,
                    [DYNC_STATE_TABLE]: stateTableSchema,
                };

                for (const [tableName, tableSchema] of Object.entries(schema)) {
                    const isSyncTable = self.syncedTables.has(tableName);

                    if (typeof tableSchema === 'string') {
                        if (isSyncTable) {
                            // Auto-inject sync fields for sync tables
                            // Note: updated_at is indexed to support user queries like orderBy('updated_at')
                            fullSchema[tableName] = `${LOCAL_PK}, &${SERVER_PK}, ${tableSchema}, ${UPDATED_AT}`;
                        } else {
                            // Auto-inject _localId as primary key for non-sync tables
                            fullSchema[tableName] = `${LOCAL_PK}, ${tableSchema}`;
                        }

                        self.logger.debug(
                            `[dync] Defining ${isSyncTable ? '' : 'non-'}sync table '${tableName}' with primary key & indexes '${fullSchema[tableName]}'`,
                        );
                    } else {
                        if (isSyncTable) {
                            // Auto-inject sync columns for structured schemas
                            fullSchema[tableName] = self.injectSyncColumns(tableSchema);
                        } else {
                            // Auto-inject _localId column for non-sync structured schemas
                            fullSchema[tableName] = self.injectLocalIdColumn(tableSchema);
                        }

                        const schemaColumns = Object.keys((fullSchema[tableName] as SQLiteTableDefinition).columns ?? {}).join(', ');
                        const schemaIndexes = ((fullSchema[tableName] as SQLiteTableDefinition).indexes ?? []).map((idx) => idx.columns.join('+')).join(', ');

                        self.logger.debug(
                            `[dync] Defining ${isSyncTable ? '' : 'non-'}sync table '${tableName}' with columns ${schemaColumns} and indexes ${schemaIndexes}`,
                        );
                    }
                }

                storesDefined = true;
                self.adapter.defineSchema(versionNumber, fullSchema, schemaOptions);
                self.setupEnhancedTables(Object.keys(schema));

                // Define getters for direct table access (e.g., db.todos)
                for (const tableName of Object.keys(schema)) {
                    if (!(tableName in self)) {
                        Object.defineProperty(self, tableName, {
                            get() {
                                return self.table(tableName);
                            },
                            enumerable: true,
                            configurable: false,
                        });
                    }
                }

                return builder;
            },
            sqlite(migrations: SQLiteVersionMigration) {
                if (!storesDefined) {
                    throw new Error('Call stores() before registering sqlite migrations');
                }
                const sqliteOptions = (schemaOptions.sqlite ??= {});
                sqliteOptions.migrations = migrations;
                return builder;
            },
        };

        return builder;
    }

    async open(): Promise<void> {
        if (this.closing) {
            return;
        }
        if (this.openPromise) {
            return this.openPromise;
        }

        this.openPromise = (async () => {
            if (this.closing) return;
            await this.adapter.open();
            if (this.closing) return;
            await this.state.hydrate();
        })();

        return this.openPromise;
    }

    async close(): Promise<void> {
        // Mark as closing to abort any pending opens
        this.closing = true;
        // Wait for any pending open to complete before closing
        if (this.openPromise) {
            await this.openPromise.catch(() => {});
            this.openPromise = undefined;
        }
        await this.enableSync(false);
        await this.adapter.close();
        this.tableCache.clear();
        this.mutationWrappedTables.clear();
        this.syncEnhancedTables.clear();
    }

    async delete(): Promise<void> {
        await this.adapter.delete();
        // Clear any cached table wrappers that may reference a deleted/closed database.
        this.tableCache.clear();
        this.mutationWrappedTables.clear();
        this.syncEnhancedTables.clear();
    }

    async query<R>(callback: (ctx: DexieQueryContext | SQLiteQueryContext | MemoryQueryContext) => Promise<R>): Promise<R> {
        return this.adapter.query(callback as any);
    }

    table<K extends keyof _TStoreMap>(name: K): StorageTable<_TStoreMap[K]>;
    table<T = any>(name: string): StorageTable<T>;
    table(name: string) {
        if (this.tableCache.has(name)) {
            return this.tableCache.get(name)!;
        }

        const table = this.adapter.table(name);
        const isSyncTable = this.syncedTables.has(name);

        // For sync tables, enhanceSyncTable handles both pending changes AND mutation emission.
        // For non-sync tables, we just need mutation emission for useLiveQuery reactivity.
        if (isSyncTable && !this.syncEnhancedTables.has(name)) {
            this.enhanceSyncTable(table as StorageTable<SyncedRecord>, name);
        } else if (!isSyncTable && !this.mutationWrappedTables.has(name) && name !== DYNC_STATE_TABLE) {
            wrapWithMutationEmitter(table, name, this.emitMutation.bind(this));
            this.mutationWrappedTables.add(name);
        }

        this.tableCache.set(name, table as StorageTable<any>);
        return table;
    }

    private async withTransaction<T>(mode: TransactionMode, tableNames: string[], fn: (tables: Record<string, StorageTable<any>>) => Promise<T>): Promise<T> {
        await this.open();
        return this.adapter.transaction(mode, tableNames, async () => {
            const tables: Record<string, StorageTable<any>> = {};
            for (const tableName of tableNames) {
                tables[tableName] = this.table(tableName);
            }
            return fn(tables);
        });
    }

    private setupEnhancedTables(tableNames: string[]): void {
        setupEnhancedTablesHelper(
            {
                owner: this,
                tableCache: this.tableCache,
                enhancedTables: this.syncEnhancedTables,
                getTable: (name) => this.table(name),
            },
            tableNames,
        );
        // Also clear mutation wrapping so tables get re-wrapped on next access
        for (const tableName of tableNames) {
            this.mutationWrappedTables.delete(tableName);
        }
    }

    private injectSyncColumns(schema: SQLiteTableDefinition): SQLiteTableDefinition {
        const columns = schema.columns ?? {};

        // Validate user hasn't defined reserved sync columns
        if (columns[LOCAL_PK]) {
            throw new Error(`Column '${LOCAL_PK}' is auto-injected for sync tables and cannot be defined manually.`);
        }
        if (columns[SERVER_PK]) {
            throw new Error(`Column '${SERVER_PK}' is auto-injected for sync tables and cannot be defined manually.`);
        }
        if (columns[UPDATED_AT]) {
            throw new Error(`Column '${UPDATED_AT}' is auto-injected for sync tables and cannot be defined manually.`);
        }

        // Inject _localId, id, and updated_at columns
        const injectedColumns: Record<string, any> = {
            ...columns,
            [LOCAL_PK]: { type: 'TEXT' },
            [SERVER_PK]: { type: 'INTEGER', unique: true },
            [UPDATED_AT]: { type: 'TEXT' },
        };

        // Auto-inject updated_at index if not already defined by user
        // This supports user queries like orderBy('updated_at')
        const userIndexes = schema.indexes ?? [];
        const hasUpdatedAtIndex = userIndexes.some((idx) => idx.columns.length === 1 && idx.columns[0] === UPDATED_AT);

        const injectedIndexes = hasUpdatedAtIndex ? userIndexes : [...userIndexes, { columns: [UPDATED_AT] }];

        return {
            ...schema,
            columns: injectedColumns,
            indexes: injectedIndexes,
        };
    }

    private injectLocalIdColumn(schema: SQLiteTableDefinition): SQLiteTableDefinition {
        const columns = schema.columns ?? {};

        // Validate user hasn't defined reserved _localId column
        if (columns[LOCAL_PK]) {
            throw new Error(`Column '${LOCAL_PK}' is auto-injected and cannot be defined manually.`);
        }

        // Inject _localId column as primary key
        const injectedColumns: Record<string, any> = {
            ...columns,
            [LOCAL_PK]: { type: 'TEXT' },
        };

        return {
            ...schema,
            columns: injectedColumns,
        };
    }

    private enhanceSyncTable<T>(table: StorageTable<T & SyncedRecord>, tableName: string): void {
        enhanceSyncTable({
            table,
            tableName,
            withTransaction: this.withTransaction.bind(this),
            state: this.state,
            enhancedTables: this.syncEnhancedTables,
            emitMutation: this.emitMutation.bind(this),
        });
    }

    private async syncOnce(): Promise<void> {
        if (this.closing) {
            return;
        }
        if (this.syncStatus === 'syncing') {
            this.mutationsDuringSync = true;
            return;
        }

        this.syncStatus = 'syncing';
        this.mutationsDuringSync = false;

        const pullResult = await this.pullAll();
        const firstPushSyncError = await this.pushAll();

        // Emit pull mutation only for tables that had changes
        for (const tableName of pullResult.changedTables) {
            this.emitMutation({ type: 'pull', tableName });
        }

        this.syncStatus = 'idle';
        this.state.setApiError(pullResult.error ?? firstPushSyncError);

        if (this.mutationsDuringSync) {
            this.mutationsDuringSync = false;
            this.syncOnce().catch(() => {
                // Suppress unhandled promise rejections that occur when the database closes
            });
        }
    }

    private async pullAll(): Promise<{ error?: Error; changedTables: string[] }> {
        const baseContext = {
            logger: this.logger,
            state: this.state,
            table: this.table.bind(this),
            withTransaction: this.withTransaction.bind(this),
            conflictResolutionStrategy: this.syncOptions.conflictResolutionStrategy!,
        };

        if (this.batchSync) {
            return runPullAllBatch({
                ...baseContext,
                batchSync: this.batchSync,
            });
        }

        return runPullAll({
            ...baseContext,
            syncApis: this.syncApis,
            syncInterval: this.syncOptions.syncInterval!,
        });
    }

    private async pushAll(): Promise<Error | undefined> {
        const baseContext = {
            logger: this.logger,
            state: this.state,
            table: this.table.bind(this),
            withTransaction: this.withTransaction.bind(this),
            syncOptions: this.syncOptions,
        };

        if (this.batchSync) {
            return runPushAllBatch({
                ...baseContext,
                batchSync: this.batchSync,
            });
        }

        return runPushAll({
            ...baseContext,
            syncApis: this.syncApis,
        });
    }

    private startSyncTimer(start: boolean) {
        if (start) {
            void this.tryStart();
        } else {
            this.syncTimerStarted = false;
        }
    }

    private async tryStart() {
        if (this.syncTimerStarted) return;
        this.syncTimerStarted = true;

        while (this.syncTimerStarted) {
            this.sleepAbortController = new AbortController();
            await this.syncOnce();
            await sleep(this.syncOptions.syncInterval!, this.sleepAbortController.signal);
        }

        this.syncStatus = 'disabled';
        this.disableSyncPromiseResolver?.();
    }

    private setupVisibilityListener(add: boolean) {
        this.visibilitySubscription = addVisibilityChangeListener(add, this.visibilitySubscription, (isVisible) => this.handleVisibilityChange(isVisible));
    }

    private handleVisibilityChange(isVisible: boolean) {
        if (isVisible) {
            this.logger.debug('[dync] sync:start-in-foreground');
            this.startSyncTimer(true);
        } else {
            this.logger.debug('[dync] sync:pause-in-background');
            this.startSyncTimer(false);
        }
    }

    private async startFirstLoad(onProgress?: FirstLoadProgressCallback): Promise<void> {
        // Ensure database is open and state is hydrated before first load
        await this.open();

        const baseContext = {
            logger: this.logger,
            state: this.state,
            table: this.table.bind(this),
            withTransaction: this.withTransaction.bind(this),
            onProgress,
        };

        if (this.batchSync) {
            await runFirstLoadBatch({
                ...baseContext,
                batchSync: this.batchSync,
            });
        } else {
            await runFirstLoad({
                ...baseContext,
                syncApis: this.syncApis,
            });
        }

        // Emit pull mutation for all synced tables to trigger live query updates
        for (const tableName of this.syncedTables) {
            this.emitMutation({ type: 'pull', tableName });
        }
    }

    private getSyncState(): SyncState {
        return this.state.getSyncState();
    }

    private async resolveConflict(localId: string, keepLocal: boolean): Promise<void> {
        const conflict = this.state.getState().conflicts?.[localId];
        if (!conflict) {
            this.logger.warn(`[dync] No conflict found for localId: ${localId}`);
            return;
        }

        await this.withTransaction('rw', [conflict.tableName, DYNC_STATE_TABLE], async (tables) => {
            const txTable = tables[conflict.tableName]!;
            if (!keepLocal) {
                const item = await txTable.get(localId);
                if (item) {
                    // Use remote value(s)
                    for (const field of conflict.fields) {
                        item[field.key] = field.remoteValue;
                    }

                    await txTable.raw.update(localId, item);
                } else {
                    this.logger.warn(`[dync] No local item found for localId: ${localId} to apply remote values`);
                }

                await this.state.setState((syncState) => ({
                    ...syncState,
                    pendingChanges: syncState.pendingChanges.filter((p) => !(p.localId === localId && p.tableName === conflict.tableName)),
                }));
            }

            await this.state.setState((syncState) => {
                const ss = { ...syncState };
                delete ss.conflicts?.[localId];
                return ss;
            });
        });
    }

    private async enableSync(enabled: boolean) {
        if (!enabled) {
            // Only wait for sync to stop if it was actually running
            if (this.syncTimerStarted) {
                this.disableSyncPromise = new Promise((resolve) => {
                    this.disableSyncPromiseResolver = resolve;
                });
                this.sleepAbortController?.abort();
                this.syncStatus = 'disabling';
                this.startSyncTimer(false);
                this.setupVisibilityListener(false);
                return this.disableSyncPromise;
            }
            this.syncStatus = 'disabled';
            this.setupVisibilityListener(false);
            return Promise.resolve();
        }
        this.syncStatus = 'idle';
        this.startSyncTimer(true);
        this.setupVisibilityListener(true);
        return Promise.resolve();
    }

    get syncStatus(): SyncStatus {
        return this.state.getSyncStatus();
    }

    set syncStatus(status: SyncStatus) {
        this.state.setSyncStatus(status);
    }

    private onSyncStateChange(fn: (state: SyncState) => void): () => void {
        return this.state.subscribe(fn);
    }

    private onMutation(fn: (event: MutationEvent) => void): () => void {
        this.mutationListeners.add(fn);
        return () => this.mutationListeners.delete(fn);
    }

    private emitMutation(event: MutationEvent): void {
        // Trigger sync on data changes if sync was enabled
        if (event.type === 'add' || event.type === 'update' || event.type === 'delete') {
            if (this.syncTimerStarted) {
                this.syncOnce().catch(() => {
                    // Suppress unhandled promise rejections that occur when the database closes
                });
            }
        }

        for (const listener of this.mutationListeners) {
            listener(event);
        }
    }

    // Public API
    sync: SyncApi = {
        enable: this.enableSync.bind(this),
        startFirstLoad: this.startFirstLoad.bind(this),
        state: undefined as unknown as SyncState, // getter in constructor
        resolveConflict: this.resolveConflict.bind(this),
        onStateChange: this.onSyncStateChange.bind(this),
        onMutation: this.onMutation.bind(this),
    };
}

type DyncInstance<TStoreMap extends Record<string, any> = Record<string, any>> = DyncBase<TStoreMap> &
    TableMap<TStoreMap> & {
        table<K extends keyof TStoreMap & string>(name: K): StorageTable<TStoreMap[K]>;
        table(name: string): StorageTable<any>;
    };

// Export Dync as a class-like constructor with proper typing for direct table access
export const Dync = DyncBase as unknown as {
    <TStoreMap extends Record<string, any> = Record<string, any>>(config: DyncOptions<TStoreMap>): DyncInstance<TStoreMap>;
    new <TStoreMap extends Record<string, any> = Record<string, any>>(config: DyncOptions<TStoreMap>): DyncInstance<TStoreMap>;
};

export type Dync<TStoreMap extends Record<string, any> = Record<string, any>> = DyncInstance<TStoreMap>;
