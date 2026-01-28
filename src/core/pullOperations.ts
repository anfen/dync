import { createLocalId } from '../helpers';
import type { Logger } from '../logger';
import type { CrudSyncApi, BatchSync, ConflictResolutionStrategy, FieldConflict, SyncedRecord } from '../types';
import { SyncAction } from '../types';
import type { StorageTable } from '../storage/types';
import { DYNC_STATE_TABLE, type StateHelpers } from './StateManager';
import type { WithTransaction } from './types';

export interface PullContext {
    logger: Logger;
    state: StateHelpers;
    table: <T>(name: string) => StorageTable<T>;
    withTransaction: WithTransaction;
    conflictResolutionStrategy: ConflictResolutionStrategy;
}

export interface PullAllContext extends PullContext {
    syncApis: Record<string, CrudSyncApi>;
    syncInterval: number;
}

export interface PullAllBatchContext extends PullContext {
    batchSync: BatchSync;
}

export async function pullAll(ctx: PullAllContext): Promise<{ error?: Error; changedTables: string[] }> {
    let firstSyncError: Error | undefined;
    const changedTables: string[] = [];
    for (const [tableName, api] of Object.entries(ctx.syncApis)) {
        try {
            const lastPulled = ctx.state.getState().lastPulled[tableName];
            const since = lastPulled ? new Date(lastPulled) : new Date(0);

            ctx.logger.debug(`[dync] pull:start tableName=${tableName} since=${since.toISOString()}`);

            const serverData = (await api.list(since)) as SyncedRecord[];
            const changed = await processPullData(tableName, serverData, since, ctx);
            if (changed) changedTables.push(tableName);
        } catch (err) {
            firstSyncError = firstSyncError ?? (err as Error);
            ctx.logger.error(`[dync] pull:error tableName=${tableName}`, err);
        }
    }
    return { error: firstSyncError, changedTables };
}

async function handleRemoteItemUpdate(table: StorageTable<any>, tableName: string, localItem: any, remote: any, ctx: PullContext): Promise<void> {
    const pendingChange = ctx.state.getState().pendingChanges.find((p) => p.tableName === tableName && p.localId === localItem._localId);
    const conflictStrategy = ctx.conflictResolutionStrategy;

    if (pendingChange) {
        ctx.logger.debug(`[dync] pull:conflict-strategy:${conflictStrategy} tableName=${tableName} id=${remote.id}`);

        switch (conflictStrategy) {
            case 'local-wins':
                break;

            case 'remote-wins': {
                const merged = { ...remote, _localId: localItem._localId };
                await table.raw.update(localItem._localId, merged);
                await ctx.state.removePendingChange(localItem._localId, tableName);
                break;
            }

            case 'try-shallow-merge': {
                const changes = pendingChange.changes || {};
                const before = pendingChange.before || {};
                const fields: FieldConflict[] = Object.entries(changes)
                    .filter(([k, localValue]) => k in before && k in remote && before[k] !== remote[k] && localValue !== remote[k])
                    .map(([key, localValue]) => ({ key, localValue, remoteValue: remote[key] }));

                if (fields.length > 0) {
                    ctx.logger.warn(`[dync] pull:${conflictStrategy}:conflicts-found`, JSON.stringify(fields, null, 4));
                    // Store or update conflict with CURRENT field values (prevents stale conflicts)
                    await ctx.state.setState((syncState) => ({
                        ...syncState,
                        conflicts: {
                            ...(syncState.conflicts || {}),
                            [localItem._localId]: { tableName, fields },
                        },
                    }));
                } else {
                    const localChangedKeys = Object.keys(changes);
                    const preservedLocal: any = { _localId: localItem._localId };
                    for (const k of localChangedKeys) {
                        if (k in localItem) preservedLocal[k] = localItem[k];
                    }

                    const merged = { ...remote, ...preservedLocal };
                    await table.raw.update(localItem._localId, merged);

                    // Clear conflict for the current pending change - it no longer conflicts
                    await ctx.state.setState((syncState) => {
                        const ss = { ...syncState };
                        delete ss.conflicts?.[localItem._localId];
                        return ss;
                    });
                }
                break;
            }
        }
    } else {
        const merged = { ...localItem, ...remote };
        await table.raw.update(localItem._localId, merged);
        ctx.logger.debug(`[dync] pull:merge-remote tableName=${tableName} id=${remote.id}`);
    }
}

// ============================================================================
// Batch Mode Pull Operations
// ============================================================================

export async function pullAllBatch(ctx: PullAllBatchContext): Promise<{ error?: Error; changedTables: string[] }> {
    let firstSyncError: Error | undefined;
    const changedTables: string[] = [];

    try {
        // Build since map for all synced tables
        const sinceMap: Record<string, Date> = {};
        for (const tableName of ctx.batchSync.syncTables) {
            const lastPulled = ctx.state.getState().lastPulled[tableName];
            sinceMap[tableName] = lastPulled ? new Date(lastPulled) : new Date(0);
        }

        ctx.logger.debug(`[dync] pull:batch:start tables=${[...ctx.batchSync.syncTables].join(',')}`, sinceMap);

        // Single batch pull request
        const serverDataByTable = await ctx.batchSync.pull(sinceMap);

        // Process each table's data
        for (const [tableName, serverData] of Object.entries(serverDataByTable)) {
            if (!ctx.batchSync.syncTables.includes(tableName)) {
                ctx.logger.warn(`[dync] pull:batch:unknown-table tableName=${tableName}`);
                continue;
            }

            try {
                const changed = await processPullData(tableName, serverData as SyncedRecord[], sinceMap[tableName]!, ctx);
                if (changed) changedTables.push(tableName);
            } catch (err) {
                firstSyncError = firstSyncError ?? (err as Error);
                ctx.logger.error(`[dync] pull:batch:error tableName=${tableName}`, err);
            }
        }
    } catch (err) {
        firstSyncError = err as Error;
        ctx.logger.error(`[dync] pull:batch:error`, err);
    }

    return { error: firstSyncError, changedTables };
}

async function processPullData(tableName: string, serverData: SyncedRecord[], since: Date, ctx: PullContext): Promise<boolean> {
    if (!serverData?.length) return false;

    ctx.logger.debug(`[dync] pull:process tableName=${tableName} count=${serverData.length}`);

    let newest = since;
    let hasChanges = false;

    await ctx.withTransaction('rw', [tableName, DYNC_STATE_TABLE], async (tables) => {
        const txTable = tables[tableName]!;
        const pendingRemovalById = new Set(
            ctx.state
                .getState()
                .pendingChanges.filter((p) => p.tableName === tableName && p.action === SyncAction.Remove)
                .map((p) => p.id),
        );

        for (const remote of serverData) {
            const remoteUpdated = new Date(remote.updated_at);
            if (remoteUpdated > newest) newest = remoteUpdated;

            if (pendingRemovalById.has(remote.id)) {
                ctx.logger.debug(`[dync] pull:skip-pending-remove tableName=${tableName} id=${remote.id}`);
                continue;
            }

            const localItem = await txTable.where('id').equals(remote.id).first();

            if (remote.deleted) {
                if (localItem) {
                    await txTable.raw.delete(localItem._localId);
                    ctx.logger.debug(`[dync] pull:remove tableName=${tableName} id=${remote.id}`);
                    hasChanges = true;
                }
                continue;
            }

            delete remote.deleted;

            if (localItem) {
                await handleRemoteItemUpdate(txTable, tableName, localItem, remote, ctx);
                hasChanges = true;
            } else {
                const newLocalItem = { ...remote, _localId: createLocalId() };
                await txTable.raw.add(newLocalItem);
                ctx.logger.debug(`[dync] pull:add tableName=${tableName} id=${remote.id}`);
                hasChanges = true;
            }
        }

        await ctx.state.setState((syncState) => ({
            ...syncState,
            lastPulled: {
                ...syncState.lastPulled,
                [tableName]: newest.toISOString(),
            },
        }));
    });

    return hasChanges;
}
