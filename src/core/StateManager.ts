import { deleteKeyIfEmptyObject, omitFields, parseApiError } from '../helpers';
import { LOCAL_PK, UPDATED_AT, SyncAction, ApiError, type PendingChange, type PersistedSyncState, type SyncState, type SyncStatus } from '../types';
import type { StorageAdapter } from '../storage/types';

const LOCAL_ONLY_SYNC_FIELDS = [LOCAL_PK, UPDATED_AT];

// Internal table name used for storing sync state
export const DYNC_STATE_TABLE = '_dync_state';
const SYNC_STATE_KEY = 'sync_state';

interface StateRow {
    [LOCAL_PK]: string;
    value: string;
}

const DEFAULT_STATE: PersistedSyncState = {
    firstLoadDone: false,
    pendingChanges: [],
    newestServerUpdatedAt: {},
};

interface StateContext {
    initialStatus?: SyncStatus;
    storageAdapter?: StorageAdapter;
}

export interface StateHelpers {
    hydrate(): Promise<void>;
    getState(): PersistedSyncState;
    setState(setterOrState: PersistedSyncState | ((state: PersistedSyncState) => Partial<PersistedSyncState>)): Promise<void>;
    setApiError(error: Error | undefined): void;
    addPendingChange(change: Omit<PendingChange, 'version'>): Promise<void>;
    samePendingVersion(tableName: string, localId: string, version: number): boolean;
    removePendingChange(localId: string, tableName: string): Promise<void>;
    updatePendingChange(tableName: string, localId: string, action: SyncAction, id?: any): Promise<void>;
    setPendingChangeBefore(tableName: string, localId: string, before: any): Promise<void>;
    hasConflicts(localId: string): boolean;
    getSyncStatus(): SyncStatus;
    setSyncStatus(status: SyncStatus): void;
    getSyncState(): SyncState;
    subscribe(listener: (state: SyncState) => void): () => void;
}

export class StateManager implements StateHelpers {
    private persistedState: PersistedSyncState;
    private syncStatus: SyncStatus;
    private apiError?: ApiError;
    private readonly listeners = new Set<(state: SyncState) => void>();
    private readonly storageAdapter?: StorageAdapter;
    private hydrated = false;

    constructor(ctx: StateContext) {
        this.storageAdapter = ctx.storageAdapter;
        // Start with default state, hydrate() will load from database
        this.persistedState = DEFAULT_STATE;
        this.syncStatus = ctx.initialStatus ?? 'disabled';
    }

    /**
     * Load state from the database. Called after stores() defines the schema.
     */
    async hydrate(): Promise<void> {
        if (this.hydrated) return;

        if (!this.storageAdapter) {
            throw new Error('Cannot hydrate state without a storage adapter');
        }

        const table = this.storageAdapter.table<StateRow>(DYNC_STATE_TABLE);
        const row = await table.get(SYNC_STATE_KEY);
        if (row?.value) {
            this.persistedState = parseStoredState(row.value);
        }

        this.hydrated = true;

        // Notify subscribers if state was loaded from database
        this.emit();
    }

    private emit(): void {
        this.listeners.forEach((fn) => fn(this.getSyncState()));
    }

    private async persist(): Promise<void> {
        // Only persist after hydration (i.e., after database is opened)
        if (!this.hydrated || !this.storageAdapter) return;

        this.emit();

        const table = this.storageAdapter.table<StateRow>(DYNC_STATE_TABLE);
        await table.put({ [LOCAL_PK]: SYNC_STATE_KEY, value: JSON.stringify(this.persistedState) } as StateRow);
    }

    getState(): PersistedSyncState {
        return clonePersistedState(this.persistedState);
    }

    setState(setterOrState: PersistedSyncState | ((state: PersistedSyncState) => Partial<PersistedSyncState>)): Promise<void> {
        this.persistedState = resolveNextState(this.persistedState, setterOrState);
        return this.persist();
    }

    setApiError(error: Error | undefined): void {
        this.apiError = error ? parseApiError(error) : undefined;
        this.emit();
    }

    addPendingChange(change: Omit<PendingChange, 'version'>): Promise<void> {
        const next = clonePersistedState(this.persistedState);
        const queueItem = next.pendingChanges.find((p) => p.localId === change.localId && p.tableName === change.tableName);

        const omittedChanges = omitFields(change.changes, LOCAL_ONLY_SYNC_FIELDS);
        const omittedBefore = omitFields(change.before, LOCAL_ONLY_SYNC_FIELDS);
        const omittedAfter = omitFields(change.after, LOCAL_ONLY_SYNC_FIELDS);
        const hasChanges = Object.keys(omittedChanges || {}).length > 0;
        const action = change.action;

        if (queueItem) {
            if (queueItem.action === SyncAction.Remove) {
                return Promise.resolve();
            }

            queueItem.version += 1;

            if (action === SyncAction.Remove) {
                queueItem.action = SyncAction.Remove;
            } else if (hasChanges) {
                queueItem.changes = { ...queueItem.changes, ...omittedChanges };
                queueItem.after = { ...queueItem.after, ...omittedAfter };
            }
        } else if (action === SyncAction.Remove || hasChanges) {
            next.pendingChanges = [...next.pendingChanges];
            next.pendingChanges.push({
                action,
                tableName: change.tableName,
                localId: change.localId,
                id: change.id,
                version: 1,
                changes: omittedChanges,
                before: omittedBefore,
                after: omittedAfter,
            });
        }

        this.persistedState = next;
        return this.persist();
    }

    samePendingVersion(tableName: string, localId: string, version: number): boolean {
        return this.persistedState.pendingChanges.find((p) => p.localId === localId && p.tableName === tableName)?.version === version;
    }

    removePendingChange(localId: string, tableName: string): Promise<void> {
        const next = clonePersistedState(this.persistedState);
        next.pendingChanges = next.pendingChanges.filter((p) => !(p.localId === localId && p.tableName === tableName));
        this.persistedState = next;
        return this.persist();
    }

    updatePendingChange(tableName: string, localId: string, action: SyncAction, id?: any): Promise<void> {
        const next = clonePersistedState(this.persistedState);
        const changeItem = next.pendingChanges.find((p) => p.tableName === tableName && p.localId === localId);
        if (changeItem) {
            changeItem.action = action;
            if (id) changeItem.id = id;
            this.persistedState = next;
            return this.persist();
        }
        return Promise.resolve();
    }

    setPendingChangeBefore(tableName: string, localId: string, before: any): Promise<void> {
        const next = clonePersistedState(this.persistedState);
        const changeItem = next.pendingChanges.find((p) => p.tableName === tableName && p.localId === localId);
        if (changeItem) {
            changeItem.before = { ...(changeItem.before ?? {}), ...before };
            this.persistedState = next;
            return this.persist();
        }
        return Promise.resolve();
    }

    hasConflicts(localId: string): boolean {
        return Boolean(this.persistedState.conflicts?.[localId]);
    }

    getSyncStatus(): SyncStatus {
        return this.syncStatus;
    }

    setSyncStatus(status: SyncStatus): void {
        if (this.syncStatus === status) return;
        this.syncStatus = status;
        this.emit();
    }

    getSyncState(): SyncState {
        return buildSyncState(this.persistedState, this.syncStatus, this.hydrated, this.apiError);
    }

    subscribe(listener: (state: SyncState) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
}

function parseStoredState(stored: string): PersistedSyncState {
    const parsed = JSON.parse(stored);
    if (parsed.pendingChanges) {
        parsed.pendingChanges = parsed.pendingChanges.map((change: any) => ({
            ...change,
            timestamp: change.timestamp ? new Date(change.timestamp) : change.timestamp,
        }));
    }
    return parsed;
}

function resolveNextState(
    current: PersistedSyncState,
    setterOrState: PersistedSyncState | ((state: PersistedSyncState) => Partial<PersistedSyncState>),
): PersistedSyncState {
    if (typeof setterOrState === 'function') {
        return { ...current, ...setterOrState(clonePersistedState(current)) };
    }
    return { ...current, ...setterOrState };
}

function buildSyncState(state: PersistedSyncState, status: SyncStatus, hydrated: boolean, apiError?: ApiError): SyncState {
    const persisted = clonePersistedState(state);
    const syncState: SyncState = {
        ...persisted,
        status,
        hydrated,
        apiError,
    };
    deleteKeyIfEmptyObject(syncState, 'conflicts');
    return syncState;
}

function clonePersistedState(state: PersistedSyncState): PersistedSyncState {
    return {
        ...state,
        pendingChanges: state.pendingChanges.map((change) => ({
            ...change,
            changes: cloneRecord(change.changes),
            before: cloneRecord(change.before),
            after: cloneRecord(change.after),
        })),
        newestServerUpdatedAt: { ...state.newestServerUpdatedAt },
        lastPulledAt: state.lastPulledAt ? { ...state.lastPulledAt } : undefined,
        conflicts: cloneConflicts(state.conflicts),
    };
}

function cloneConflicts(conflicts: SyncState['conflicts'] | undefined): SyncState['conflicts'] | undefined {
    if (!conflicts) return undefined;
    const next: NonNullable<SyncState['conflicts']> = {};
    for (const [key, value] of Object.entries(conflicts)) {
        next[key] = {
            tableName: value.tableName,
            fields: value.fields.map((field) => ({ ...field })),
        };
    }
    return next;
}

function cloneRecord<T extends Record<string, any> | null | undefined>(record: T): T {
    if (!record) return record;
    return { ...record } as T;
}
