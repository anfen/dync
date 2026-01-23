import { createLocalId, sleep } from '../helpers';
import type { Logger } from '../logger';
import type { ApiFunctions, BatchFirstLoadResult, BatchSync, FirstLoadProgressCallback } from '../types';
import type { StorageTable } from '../storage/types';
import { DYNC_STATE_TABLE, type StateHelpers } from './StateManager';
import type { WithTransaction } from './types';

export interface FirstLoadBaseContext {
    logger: Logger;
    state: StateHelpers;
    table: <T>(name: string) => StorageTable<T>;
    withTransaction: WithTransaction;
    onProgress?: FirstLoadProgressCallback;
}

export interface FirstLoadContext extends FirstLoadBaseContext {
    syncApis: Record<string, ApiFunctions>;
}

export interface FirstLoadBatchContext extends FirstLoadBaseContext {
    batchSync: BatchSync;
}

interface RemoteRecord {
    id?: unknown;
    updated_at?: string;
    deleted?: boolean;
    _localId?: string;
    [key: string]: unknown;
}

// Yield to event loop to prevent UI freezing on constrained devices
const yieldToEventLoop = (): Promise<void> => sleep(0);

const WRITE_BATCH_SIZE = 200;

export async function startFirstLoad(ctx: FirstLoadContext): Promise<void> {
    ctx.logger.debug('[dync] Starting first load...');

    if (ctx.state.getState().firstLoadDone) {
        ctx.logger.debug('[dync] First load already completed');
        return;
    }

    let error: Error | undefined;

    for (const [tableName, api] of Object.entries(ctx.syncApis)) {
        if (!api.firstLoad) {
            ctx.logger.error(`[dync] firstLoad:no-api-function tableName=${tableName}`);
            continue;
        }

        try {
            ctx.logger.info(`[dync] firstLoad:start tableName=${tableName}`);

            let lastId: unknown;
            let isEmptyTable = true;
            let batchCount = 0;
            let totalInserted = 0;
            let totalUpdated = 0;

            while (true) {
                const batch = await api.firstLoad(lastId);
                if (!batch?.length) break;

                batchCount++;

                // Process batch in smaller chunks to manage memory and allow UI updates
                const { inserted, updated } = await processBatchInChunks(ctx, tableName, batch, isEmptyTable, lastId === undefined);
                totalInserted += inserted;
                totalUpdated += updated;

                // Report progress if callback provided
                if (ctx.onProgress) {
                    ctx.onProgress({
                        table: tableName,
                        inserted: totalInserted,
                        updated: totalUpdated,
                        total: totalInserted + totalUpdated,
                    });
                }

                // After first batch, we know if table was empty
                if (lastId === undefined) {
                    isEmptyTable = (await ctx.table(tableName).count()) === batch.length;
                }

                if (lastId !== undefined && lastId === batch[batch.length - 1].id) {
                    throw new Error(`Duplicate records downloaded, stopping to prevent infinite loop`);
                }

                lastId = batch[batch.length - 1].id;

                // Yield between API batches to allow UI updates
                if (batchCount % 5 === 0) {
                    await yieldToEventLoop();
                }
            }

            ctx.logger.info(`[dync] firstLoad:done tableName=${tableName} inserted=${totalInserted} updated=${totalUpdated}`);
        } catch (err) {
            error = error ?? (err as Error);
            ctx.logger.error(`[dync] firstLoad:error tableName=${tableName}`, err);
        }
    }

    await ctx.state.setState((syncState) => ({
        ...syncState,
        firstLoadDone: true,
        error,
    }));

    ctx.logger.debug('[dync] First load completed');
}

interface BatchResult {
    inserted: number;
    updated: number;
}

async function processBatchInChunks(
    ctx: FirstLoadBaseContext,
    tableName: string,
    batch: RemoteRecord[],
    isEmptyTable: boolean,
    isFirstBatch: boolean,
): Promise<BatchResult> {
    let newest = new Date(ctx.state.getState().lastPulled[tableName] || 0);

    return ctx.withTransaction('rw', [tableName, DYNC_STATE_TABLE], async (tables) => {
        const txTable = tables[tableName]!;

        // Check if table is empty on first batch
        let tableIsEmpty = isEmptyTable;
        if (isFirstBatch) {
            const count = await txTable.count();
            tableIsEmpty = count === 0;
        }

        // Pre-filter and prepare records, mutating in place to reduce allocations
        const activeRecords: RemoteRecord[] = [];
        for (const remote of batch) {
            const remoteUpdated = new Date(remote.updated_at || 0);
            if (remoteUpdated > newest) newest = remoteUpdated;

            if (remote.deleted) continue;

            // Mutate in place instead of spreading
            delete remote.deleted;
            remote._localId = createLocalId();
            activeRecords.push(remote);
        }

        let inserted = 0;
        let updated = 0;

        if (tableIsEmpty) {
            // Fast path: no existing records, bulk add in chunks
            for (let i = 0; i < activeRecords.length; i += WRITE_BATCH_SIZE) {
                const chunk = activeRecords.slice(i, i + WRITE_BATCH_SIZE);
                await txTable.raw.bulkAdd(chunk as any);
                inserted += chunk.length;
            }
        } else {
            // Slower path: need to check for existing records
            // Process in chunks to limit memory usage of lookup map
            for (let i = 0; i < activeRecords.length; i += WRITE_BATCH_SIZE) {
                const chunk = activeRecords.slice(i, i + WRITE_BATCH_SIZE);
                const chunkResult = await processChunkWithLookup(txTable, chunk);
                inserted += chunkResult.inserted;
                updated += chunkResult.updated;
            }
        }

        await ctx.state.setState((syncState) => ({
            ...syncState,
            lastPulled: {
                ...syncState.lastPulled,
                [tableName]: newest.toISOString(),
            },
        }));

        return { inserted, updated };
    });
}

async function processChunkWithLookup(txTable: StorageTable<any>, chunk: RemoteRecord[]): Promise<BatchResult> {
    // Collect server IDs for this chunk
    const serverIds = chunk.filter((r) => r.id != null).map((r) => r.id);

    // Bulk lookup existing records
    const existingByServerId = new Map<unknown, { _localId: string }>();
    if (serverIds.length > 0) {
        const existingRecords = await txTable.where('id').anyOf(serverIds).toArray();
        for (const existing of existingRecords) {
            existingByServerId.set((existing as any).id, existing as { _localId: string });
        }
    }

    // Separate into adds and updates
    const toAdd: RemoteRecord[] = [];
    let updated = 0;

    for (const remote of chunk) {
        const existing = remote.id != null ? existingByServerId.get(remote.id) : undefined;
        if (existing) {
            // Update: merge and update in place
            const merged = Object.assign({}, existing, remote, { _localId: existing._localId });
            await txTable.raw.update(existing._localId, merged as any);
            updated++;
        } else {
            toAdd.push(remote);
        }
    }

    // Bulk add new records
    if (toAdd.length > 0) {
        await txTable.raw.bulkAdd(toAdd as any);
    }

    // Clear the map to help GC
    existingByServerId.clear();

    return { inserted: toAdd.length, updated };
}

// ============================================================================
// Batch Mode First Load Operations
// ============================================================================

export async function startFirstLoadBatch(ctx: FirstLoadBatchContext): Promise<void> {
    ctx.logger.debug('[dync] Starting batch first load...');

    if (ctx.state.getState().firstLoadDone) {
        ctx.logger.debug('[dync] First load already completed');
        return;
    }

    if (!ctx.batchSync.firstLoad) {
        ctx.logger.warn('[dync] firstLoad:batch:no-firstLoad-function');
        await ctx.state.setState((syncState) => ({
            ...syncState,
            firstLoadDone: true,
        }));
        return;
    }

    let error: Error | undefined;

    try {
        ctx.logger.info(`[dync] firstLoad:batch:start tables=${[...ctx.batchSync.syncTables].join(',')}`);

        // Track progress per table
        const progress: Record<string, { inserted: number; updated: number }> = {};
        for (const tableName of ctx.batchSync.syncTables) {
            progress[tableName] = { inserted: 0, updated: 0 };
        }

        // Initialize cursors for all tables
        let cursors: Record<string, any> = {};
        for (const tableName of ctx.batchSync.syncTables) {
            cursors[tableName] = undefined;
        }

        let batchCount = 0;

        while (true) {
            const result: BatchFirstLoadResult = await ctx.batchSync.firstLoad(cursors);

            if (!result.hasMore && Object.values(result.data).every((d) => !d?.length)) {
                break;
            }

            batchCount++;

            // Process each table's data
            for (const [tableName, batch] of Object.entries(result.data)) {
                if (!ctx.batchSync.syncTables.includes(tableName)) {
                    ctx.logger.warn(`[dync] firstLoad:batch:unknown-table tableName=${tableName}`);
                    continue;
                }

                if (!batch?.length) continue;

                const isFirstBatch = progress[tableName]!.inserted === 0 && progress[tableName]!.updated === 0;
                const isEmptyTable = isFirstBatch && (await ctx.table(tableName).count()) === 0;

                const { inserted, updated } = await processBatchInChunks(ctx, tableName, batch, isEmptyTable, isFirstBatch);
                progress[tableName]!.inserted += inserted;
                progress[tableName]!.updated += updated;

                // Report progress if callback provided
                if (ctx.onProgress) {
                    ctx.onProgress({
                        table: tableName,
                        inserted: progress[tableName]!.inserted,
                        updated: progress[tableName]!.updated,
                        total: progress[tableName]!.inserted + progress[tableName]!.updated,
                    });
                }
            }

            // Update cursors for next batch
            cursors = result.cursors;

            // Yield between API batches to allow UI updates
            if (batchCount % 5 === 0) {
                await yieldToEventLoop();
            }

            if (!result.hasMore) {
                break;
            }
        }

        // Log completion for each table
        for (const [tableName, p] of Object.entries(progress)) {
            ctx.logger.info(`[dync] firstLoad:batch:done tableName=${tableName} inserted=${p.inserted} updated=${p.updated}`);
        }
    } catch (err) {
        error = err as Error;
        ctx.logger.error('[dync] firstLoad:batch:error', err);
    }

    await ctx.state.setState((syncState) => ({
        ...syncState,
        firstLoadDone: true,
        error,
    }));

    ctx.logger.debug('[dync] Batch first load completed');
}
