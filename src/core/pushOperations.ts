import { createLocalId, orderFor } from '../helpers';
import type { Logger } from '../logger';
import type { ApiFunctions, BatchPushPayload, BatchPushResult, BatchSync, PendingChange, SyncOptions } from '../types';
import { SyncAction } from '../types';
import type { StorageTable } from '../storage/types';
import { DYNC_STATE_TABLE, type StateHelpers } from './StateManager';
import type { WithTransaction } from './types';

export interface PushContext {
    logger: Logger;
    state: StateHelpers;
    table: <T>(name: string) => StorageTable<T>;
    withTransaction: WithTransaction;
    syncOptions: SyncOptions;
}

export interface PushAllContext extends PushContext {
    syncApis: Record<string, ApiFunctions>;
}

export interface PushAllBatchContext extends PushContext {
    batchSync: BatchSync;
}

async function handleRemoveSuccess(change: PendingChange, ctx: PushContext): Promise<void> {
    const { stateKey, localId, id } = change;
    ctx.logger.debug(`[dync] push:remove:success stateKey=${stateKey} localId=${localId} id=${id}`);
    await ctx.state.removePendingChange(localId, stateKey);
}

async function handleUpdateSuccess(change: PendingChange, ctx: PushContext): Promise<void> {
    const { stateKey, localId, version, changes } = change;
    ctx.logger.debug(`[dync] push:update:success stateKey=${stateKey} localId=${localId} id=${change.id}`);
    if (ctx.state.samePendingVersion(stateKey, localId, version)) {
        await ctx.state.removePendingChange(localId, stateKey);
    } else {
        await ctx.state.setPendingChangeBefore(stateKey, localId, changes);
    }
}

async function handleCreateSuccess(change: PendingChange, serverResult: { id: unknown; updated_at?: string }, ctx: PushContext): Promise<void> {
    const { stateKey, localId, version, changes, id } = change;
    ctx.logger.debug(`[dync] push:create:success stateKey=${stateKey} localId=${localId} id=${id ?? serverResult.id}`);

    await ctx.withTransaction('rw', [stateKey, DYNC_STATE_TABLE], async (tables) => {
        const txTable = tables[stateKey]!;
        const wasChanged = (await txTable.raw.update(localId, serverResult)) ?? 0;

        if (wasChanged && ctx.state.samePendingVersion(stateKey, localId, version)) {
            await ctx.state.removePendingChange(localId, stateKey);
        } else {
            const nextAction = wasChanged ? SyncAction.Update : SyncAction.Remove;
            await ctx.state.updatePendingChange(stateKey, localId, nextAction, serverResult.id);
            if (nextAction === SyncAction.Remove) return;
        }
    });

    const finalItem = { ...changes, ...serverResult, _localId: localId };
    ctx.syncOptions.onAfterRemoteAdd?.(stateKey, finalItem);
}

export async function pushAll(ctx: PushAllContext): Promise<Error | undefined> {
    let firstSyncError: Error | undefined;
    const changesSnapshot = [...ctx.state.getState().pendingChanges].sort((a, b) => orderFor(a.action) - orderFor(b.action));

    for (const change of changesSnapshot) {
        try {
            await pushOne(change, ctx);
        } catch (err) {
            firstSyncError = firstSyncError ?? (err as Error);
            ctx.logger.error(`[dync] push:error change=${JSON.stringify(change)}`, err);
        }
    }
    return firstSyncError;
}

async function pushOne(change: PendingChange, ctx: PushAllContext): Promise<void> {
    const api = ctx.syncApis[change.stateKey];
    if (!api) return;

    ctx.logger.debug(`[dync] push:attempt action=${change.action} stateKey=${change.stateKey} localId=${change.localId}`);

    const { action, stateKey, localId, id, changes, after } = change;

    switch (action) {
        case SyncAction.Remove:
            if (!id) {
                ctx.logger.warn(`[dync] push:remove:no-id stateKey=${stateKey} localId=${localId}`);
                await ctx.state.removePendingChange(localId, stateKey);
                return;
            }
            await api.remove(id);
            await handleRemoveSuccess(change, ctx);
            break;

        case SyncAction.Update: {
            if (ctx.state.hasConflicts(localId)) {
                ctx.logger.warn(`[dync] push:update:skipping-with-conflicts stateKey=${stateKey} localId=${localId} id=${id}`);
                return;
            }

            const exists = await api.update(id, changes, after);
            if (exists) {
                await handleUpdateSuccess(change, ctx);
            } else {
                await handleMissingRemoteRecord(change, ctx);
            }
            break;
        }

        case SyncAction.Create: {
            const result = await api.add(changes);
            if (result) {
                await handleCreateSuccess(change, result, ctx);
            } else {
                ctx.logger.warn(`[dync] push:create:no-result stateKey=${stateKey} localId=${localId} id=${id}`);
                if (ctx.state.samePendingVersion(stateKey, localId, change.version)) {
                    await ctx.state.removePendingChange(localId, stateKey);
                }
            }
            break;
        }
    }
}

async function handleMissingRemoteRecord(change: PendingChange, ctx: PushContext): Promise<void> {
    const { stateKey, localId } = change;
    const strategy = ctx.syncOptions.missingRemoteRecordDuringUpdateStrategy!;

    let localItem: any;

    await ctx.withTransaction('rw', [stateKey, DYNC_STATE_TABLE], async (tables) => {
        const txTable = tables[stateKey]!;
        localItem = await txTable.get(localId);

        if (!localItem) {
            ctx.logger.warn(`[dync] push:missing-remote:no-local-item stateKey=${stateKey} localId=${localId}`);
            await ctx.state.removePendingChange(localId, stateKey);
            return;
        }

        switch (strategy) {
            case 'delete-local-record':
                await txTable.raw.delete(localId);
                ctx.logger.debug(`[dync] push:missing-remote:${strategy} stateKey=${stateKey} id=${localItem.id}`);
                break;

            case 'insert-remote-record': {
                const newItem = {
                    ...localItem,
                    _localId: createLocalId(),
                    updated_at: new Date().toISOString(),
                };

                await txTable.raw.add(newItem);
                await txTable.raw.delete(localId);

                await ctx.state.addPendingChange({
                    action: SyncAction.Create,
                    stateKey,
                    localId: newItem._localId,
                    changes: newItem,
                    before: null,
                });

                ctx.logger.debug(`[dync] push:missing-remote:${strategy} stateKey=${stateKey} id=${newItem.id}`);
                break;
            }

            case 'ignore':
                ctx.logger.debug(`[dync] push:missing-remote:${strategy} stateKey=${stateKey} id=${localItem.id}`);
                break;

            default:
                ctx.logger.error(`[dync] push:missing-remote:unknown-strategy stateKey=${stateKey} id=${localItem.id} strategy=${strategy}`);
                break;
        }

        await ctx.state.removePendingChange(localId, stateKey);
    });

    ctx.syncOptions.onAfterMissingRemoteRecordDuringUpdate?.(strategy, localItem);
}

// ============================================================================
// Batch Mode Push Operations
// ============================================================================

export async function pushAllBatch(ctx: PushAllBatchContext): Promise<Error | undefined> {
    let firstSyncError: Error | undefined;

    try {
        const changesSnapshot = [...ctx.state.getState().pendingChanges]
            .filter((change) => ctx.batchSync.syncTables.includes(change.stateKey))
            .sort((a, b) => orderFor(a.action) - orderFor(b.action));

        if (changesSnapshot.length === 0) {
            ctx.logger.debug('[dync] push:batch:no-changes');
            return undefined;
        }

        // Filter out changes with conflicts
        const changesToPush = changesSnapshot.filter((change) => {
            if (change.action === SyncAction.Update && ctx.state.hasConflicts(change.localId)) {
                ctx.logger.warn(`[dync] push:batch:skipping-with-conflicts stateKey=${change.stateKey} localId=${change.localId}`);
                return false;
            }
            return true;
        });

        if (changesToPush.length === 0) {
            ctx.logger.debug('[dync] push:batch:all-skipped');
            return undefined;
        }

        // Build batch payload
        const payloads: BatchPushPayload[] = changesToPush.map((change) => ({
            table: change.stateKey,
            action: change.action === SyncAction.Create ? 'add' : change.action === SyncAction.Update ? 'update' : 'remove',
            localId: change.localId,
            id: change.id,
            data: change.action === SyncAction.Remove ? undefined : change.changes,
        }));

        ctx.logger.debug(`[dync] push:batch:start count=${payloads.length}`);

        // Single batch push request
        const results = await ctx.batchSync.push(payloads);

        // Create a map of results by localId for easy lookup
        const resultMap = new Map<string, BatchPushResult>();
        for (const result of results) {
            resultMap.set(result.localId, result);
        }

        // Process each result
        for (const change of changesToPush) {
            const result = resultMap.get(change.localId);
            if (!result) {
                ctx.logger.warn(`[dync] push:batch:missing-result localId=${change.localId}`);
                continue;
            }

            try {
                await processBatchPushResult(change, result, ctx);
            } catch (err) {
                firstSyncError = firstSyncError ?? (err as Error);
                ctx.logger.error(`[dync] push:batch:error localId=${change.localId}`, err);
            }
        }
    } catch (err) {
        firstSyncError = err as Error;
        ctx.logger.error('[dync] push:batch:error', err);
    }

    return firstSyncError;
}

async function processBatchPushResult(change: PendingChange, result: BatchPushResult, ctx: PushAllBatchContext): Promise<void> {
    const { action, stateKey, localId } = change;

    if (!result.success) {
        if (action === SyncAction.Update) {
            // Update failed - might be missing remote record
            await handleMissingRemoteRecord(change, ctx);
        } else {
            ctx.logger.warn(`[dync] push:batch:failed stateKey=${stateKey} localId=${localId} error=${result.error}`);
        }
        return;
    }

    switch (action) {
        case SyncAction.Remove:
            handleRemoveSuccess(change, ctx);
            break;

        case SyncAction.Update:
            handleUpdateSuccess(change, ctx);
            break;

        case SyncAction.Create: {
            const serverResult: { id: unknown; updated_at?: string } = { id: result.id };
            if (result.updated_at) {
                serverResult.updated_at = result.updated_at;
            }
            await handleCreateSuccess(change, serverResult, ctx);
            break;
        }
    }
}
