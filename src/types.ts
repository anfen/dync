import type { Logger, LogLevel } from './logger';
import type { StorageAdapter, StorageTable } from './storage/types';

export const SERVER_PK = 'id';
export const LOCAL_PK = '_localId';
export const UPDATED_AT = 'updated_at';

export class ApiError extends Error {
    readonly isNetworkError: boolean;
    override readonly cause?: Error;

    constructor(message: string, isNetworkError: boolean, cause?: Error) {
        super(message);
        this.name = 'ApiError';
        this.isNetworkError = isNetworkError;
        this.cause = cause;
    }
}

export interface SyncedRecord {
    _localId: string;
    id?: any;
    updated_at: string;
    [k: string]: any;
}

export interface ApiFunctions {
    add: (item: any) => Promise<any | undefined>;
    update: (id: any, changes: any, item: any) => Promise<boolean>;
    remove: (id: any) => Promise<void>;
    list: (lastUpdatedAt: Date) => Promise<any[]>;
    firstLoad?: (lastId: any) => Promise<any[]>;
}

// ============================================================================
// Batch Sync Types
// ============================================================================

/**
 * Payload for a single change in a batch push request.
 */
export interface BatchPushPayload {
    table: string;
    action: 'add' | 'update' | 'remove';
    localId: string;
    // Server-assigned ID (for update/remove)
    id?: any;
    // The data to sync (for add/update)
    data?: any;
}

/**
 * Result for a single change in a batch push response.
 */
export interface BatchPushResult {
    // Client-generated local ID - used to correlate with the request
    localId: string;
    success: boolean;
    // Server-assigned ID (for successful adds)
    id?: any;
    // Server-assigned updated_at (for successful adds/updates)
    updated_at?: string;
    error?: string;
}

/**
 * Result for batch first load operation.
 */
export interface BatchFirstLoadResult {
    // Data grouped by table name
    data: Record<string, any[]>;
    // Pagination cursors by table name. Undefined value = table is complete
    cursors: Record<string, any>;
    // Whether there's more data to load for any table
    hasMore: boolean;
}

/**
 * Batch sync configuration for
 */
export interface BatchSync {
    /**
     * Array of table names to sync.
     */
    syncTables: string[];

    /**
     * Push all pending changes to the server in a single request.
     * @param changes Array of changes to push
     * @returns Array of results, one per change, correlated by localId
     */
    push: (changes: BatchPushPayload[]) => Promise<BatchPushResult[]>;

    /**
     * Pull changes from server since last sync.
     * @param since Map of table name to last pulled timestamp
     * @returns Map of table name to array of changed records
     */
    pull: (since: Record<string, Date>) => Promise<Record<string, any[]>>;

    /**
     * Initial data load for all tables (optional).
     * @param cursors Map of table name to pagination cursor
     * @returns Batch first load result with data, cursors, and hasMore flag
     */
    firstLoad?: (cursors: Record<string, any>) => Promise<BatchFirstLoadResult>;
}

export type MissingRemoteRecordStrategy = 'ignore' | 'delete-local-record' | 'insert-remote-record';
export type ConflictResolutionStrategy = 'local-wins' | 'remote-wins' | 'try-shallow-merge';

export type AfterRemoteAddCallback = (tableName: string, item: SyncedRecord) => void;
export type MissingRemoteRecordDuringUpdateCallback = (strategy: MissingRemoteRecordStrategy, item: SyncedRecord) => void;

export interface SyncOptions {
    syncInterval?: number;
    logger?: Logger;
    minLogLevel?: LogLevel;
    onAfterRemoteAdd?: AfterRemoteAddCallback;
    missingRemoteRecordDuringUpdateStrategy?: MissingRemoteRecordStrategy;
    onAfterMissingRemoteRecordDuringUpdate?: MissingRemoteRecordDuringUpdateCallback;
    conflictResolutionStrategy?: ConflictResolutionStrategy;
}

export interface DyncOptions<TStoreMap extends Record<string, any> = Record<string, any>> {
    databaseName: string;
    storageAdapter: StorageAdapter;
    sync: Partial<Record<keyof TStoreMap, ApiFunctions>> | BatchSync;
    options?: SyncOptions;
}

export interface FirstLoadProgress {
    table: string;
    inserted: number;
    updated: number;
    total: number;
}

export type FirstLoadProgressCallback = (progress: FirstLoadProgress) => void;

export type SyncApi = {
    enable: (enabled: boolean) => Promise<void>;
    startFirstLoad: (onProgress?: FirstLoadProgressCallback) => Promise<void>;
    // Current sync state - use useSyncState() hook for reactive updates in React
    readonly state: SyncState;
    resolveConflict: (localId: string, keepLocal: boolean) => Promise<void>;
    onStateChange: (fn: (state: SyncState) => void) => () => void;
    onMutation: (fn: (event: MutationEvent) => void) => () => void;
};

export interface MutationEvent {
    type: 'add' | 'update' | 'delete' | 'bulkAdd' | 'bulkPut' | 'bulkDelete' | 'clear' | 'put' | 'modify' | 'pull';
    tableName: string;
    keys?: unknown[];
}

export interface PersistedSyncState {
    firstLoadDone: boolean;
    pendingChanges: PendingChange[];
    lastPulled: Record<string, string>;
    conflicts?: Record<string, Conflict>;
}

export type SyncStatus = 'disabled' | 'disabling' | 'idle' | 'syncing' | 'error';

export interface SyncState extends PersistedSyncState {
    status: SyncStatus;
    hydrated: boolean;
    apiError?: ApiError;
}

export enum SyncAction {
    Create = 'create',
    Update = 'update',
    Remove = 'remove', // Remote removes are a noop if no record found
}

export interface PendingChange {
    action: SyncAction;
    tableName: string;
    localId: string;
    id?: any;
    version: number;
    changes?: any;
    before?: any;
    after?: any;
}

export interface Conflict {
    tableName: string;
    fields: FieldConflict[];
}

export interface FieldConflict {
    key: string;
    localValue: any;
    remoteValue: any;
}

export type TableMap<TStoreMap extends Record<string, any>> = {
    [K in keyof TStoreMap]: StorageTable<TStoreMap[K]>;
};

export type VisibilitySubscription = {
    remove: () => void;
};
