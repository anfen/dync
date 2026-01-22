import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeDync } from '../../src/react';
import { MemoryAdapter } from '../../src/storage/memory';

const createSilentLogger = () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
});

describe('useDync React hook', () => {
    let useDync: ReturnType<typeof makeDync>['useDync'];
    let db: ReturnType<typeof makeDync>['db'];
    let consoleErrorSpy: ReturnType<typeof vi.spyOn> | undefined;

    beforeEach(() => {
        const logger = createSilentLogger();
        const dync = makeDync({
            databaseName: 'react-hook-db',
            syncApis: {},
            storageAdapter: new MemoryAdapter('react-hook-db'),
            options: { logger, minLogLevel: 'none' },
        });
        db = dync.db;
        useDync = dync.useDync;

        const originalError = console.error;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...optionalParams: unknown[]) => {
            if (typeof message === 'string' && message.includes('not wrapped in act')) {
                return;
            }
            originalError.call(console, message as any, ...optionalParams);
        });
    });

    afterEach(() => {
        db?.close();
        consoleErrorSpy?.mockRestore();
    });

    it('provides db instance and reflects syncState transitions', async () => {
        const { result } = renderHook(() => useDync());

        expect(result.current.db.name).toBe('react-hook-db');
        expect(result.current.syncState.status).toBe('disabled');

        await act(async () => {
            db.syncStatus = 'syncing';
        });

        await waitFor(() => {
            expect(result.current.syncState.status).toBe('syncing');
        });

        await act(async () => {
            db.syncStatus = 'idle';
        });

        await waitFor(() => {
            expect(result.current.syncState.status).toBe('idle');
        });
    });

    it('returns a stable db reference across renders', () => {
        const { result, rerender } = renderHook(() => useDync());

        const initialDb = result.current.db;
        rerender();

        expect(result.current.db).toBe(initialDb);
    });
});

describe('useLiveQuery React hook', () => {
    let useLiveQuery: ReturnType<typeof makeDync>['useLiveQuery'];
    let db: ReturnType<typeof makeDync>['db'];
    let consoleErrorSpy: ReturnType<typeof vi.spyOn> | undefined;

    beforeEach(async () => {
        const logger = createSilentLogger();

        const dync = makeDync({
            databaseName: 'live-query-db',
            syncApis: {
                items: {
                    add: vi.fn(async (item) => ({ id: Date.now(), ...item })),
                    update: vi.fn(async () => true),
                    remove: vi.fn(async () => {}),
                    list: vi.fn(async () => []),
                },
                categories: {
                    add: vi.fn(async (item) => ({ id: Date.now(), ...item })),
                    update: vi.fn(async () => true),
                    remove: vi.fn(async () => {}),
                    list: vi.fn(async () => []),
                },
            },
            storageAdapter: new MemoryAdapter('live-query-db'),
            options: {
                logger,
                minLogLevel: 'none',
            },
        });
        db = dync.db;
        useLiveQuery = dync.useLiveQuery;

        db.version(1).stores({
            items: 'name',
        });

        const originalError = console.error;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...optionalParams: unknown[]) => {
            if (typeof message === 'string' && message.includes('not wrapped in act')) {
                return;
            }
            originalError.call(console, message as any, ...optionalParams);
        });
    });

    afterEach(async () => {
        await db?.close();
        consoleErrorSpy?.mockRestore();
    });

    it('returns undefined initially and updates when data loads', async () => {
        const { result } = renderHook(() => useLiveQuery((db) => db.table('items').toArray()));

        // Should return undefined initially
        expect(result.current).toBeUndefined();

        await waitFor(() => {
            expect(Array.isArray(result.current)).toBe(true);
        });
    });

    it('re-runs query when data is added', async () => {
        const { result } = renderHook(() => useLiveQuery((db) => db.table('items').toArray()));

        await waitFor(() => {
            expect(result.current).toEqual([]);
        });

        await act(async () => {
            await db.table('items').add({ name: 'test-item' });
        });

        await waitFor(() => {
            expect(result.current).toHaveLength(1);
            expect(result.current?.[0].name).toBe('test-item');
        });
    });

    it('re-runs query when data is updated', async () => {
        let localId: string;

        await act(async () => {
            localId = (await db.table('items').add({ name: 'original' })) as string;
        });

        const { result } = renderHook(() => useLiveQuery((db) => db.table('items').toArray()));

        await waitFor(() => {
            expect(result.current).toHaveLength(1);
            expect(result.current?.[0].name).toBe('original');
        });

        await act(async () => {
            await db.table('items').update(localId!, { name: 'updated' });
        });

        await waitFor(() => {
            expect(result.current?.[0].name).toBe('updated');
        });
    });

    it('re-runs query when data is deleted', async () => {
        let localId: string;

        await act(async () => {
            localId = (await db.table('items').add({ name: 'to-delete' })) as string;
        });

        const { result } = renderHook(() => useLiveQuery((db) => db.table('items').count()));

        await waitFor(() => {
            expect(result.current).toBe(1);
        });

        await act(async () => {
            await db.table('items').delete(localId!);
        });

        await waitFor(() => {
            expect(result.current).toBe(0);
        });
    });

    it('updates when deps change', async () => {
        await act(async () => {
            await db.table('items').add({ name: 'alice' });
            await db.table('items').add({ name: 'bob' });
        });

        const { result, rerender } = renderHook(
            ({ filter }) =>
                useLiveQuery(
                    async (db) => {
                        return db
                            .table('items')
                            .jsFilter((i: any) => i.name.includes(filter))
                            .toArray();
                    },
                    [filter],
                ),
            {
                initialProps: { filter: 'alice' },
            },
        );

        await waitFor(() => {
            expect(result.current).toHaveLength(1);
            expect(result.current?.[0].name).toBe('alice');
        });

        rerender({ filter: 'bob' });

        await waitFor(() => {
            expect(result.current).toHaveLength(1);
            expect(result.current?.[0].name).toBe('bob');
        });
    });

    it('only re-runs when specified tables are mutated', async () => {
        let queryRunCount = 0;

        const { result } = renderHook(() =>
            useLiveQuery(
                (db) => {
                    queryRunCount++;
                    return db.table('items').toArray();
                },
                [],
                ['items'], // Only watch 'items' table
            ),
        );

        await waitFor(() => {
            expect(result.current).toEqual([]);
        });

        const initialRunCount = queryRunCount;

        // Mutate a different table ('categories') - should NOT trigger re-run
        await act(async () => {
            await db.table('categories').add({ name: 'electronics' });
        });

        // Give time for any potential re-run
        await new Promise((r) => setTimeout(r, 50));
        expect(queryRunCount).toBe(initialRunCount);

        // Mutate the watched table ('items') - SHOULD trigger re-run
        await act(async () => {
            await db.table('items').add({ name: 'test-item' });
        });

        await waitFor(() => {
            expect(result.current).toHaveLength(1);
        });

        expect(queryRunCount).toBeGreaterThan(initialRunCount);
    });

    it('re-runs on all mutations when no tables specified', async () => {
        let queryRunCount = 0;

        const { result } = renderHook(() =>
            useLiveQuery(
                (db) => {
                    queryRunCount++;
                    return db.table('items').toArray();
                },
                [],
                // No tables specified - watches all
            ),
        );

        await waitFor(() => {
            expect(result.current).toEqual([]);
        });

        const initialRunCount = queryRunCount;

        // Mutate a different table - SHOULD trigger re-run (no filter)
        await act(async () => {
            await db.table('categories').add({ name: 'electronics' });
        });

        await waitFor(() => {
            expect(queryRunCount).toBeGreaterThan(initialRunCount);
        });
    });
});

describe('useLiveQuery with non-synced tables', () => {
    let useLiveQuery: ReturnType<typeof makeDync>['useLiveQuery'];
    let db: ReturnType<typeof makeDync>['db'];
    let consoleErrorSpy: ReturnType<typeof vi.spyOn> | undefined;

    beforeEach(async () => {
        const logger = createSilentLogger();

        // Create a Dync instance with NO sync APIs - purely local storage
        const dync = makeDync({
            databaseName: 'non-synced-db',
            syncApis: {}, // No sync APIs
            storageAdapter: new MemoryAdapter('non-synced-db'),
            options: {
                logger,
                minLogLevel: 'none',
            },
        });
        db = dync.db;
        useLiveQuery = dync.useLiveQuery;

        // Define a non-synced table
        db.version(1).stores({
            localNotes: 'title', // Not a sync table
        });

        const originalError = console.error;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...optionalParams: unknown[]) => {
            if (typeof message === 'string' && message.includes('not wrapped in act')) {
                return;
            }
            originalError.call(console, message as any, ...optionalParams);
        });
    });

    afterEach(async () => {
        await db?.close();
        consoleErrorSpy?.mockRestore();
    });

    it('useLiveQuery works with non-synced tables', async () => {
        const { result } = renderHook(() => useLiveQuery((db) => db.table('localNotes').toArray()));

        await waitFor(() => {
            expect(result.current).toEqual([]);
        });

        // Add to non-synced table - should trigger useLiveQuery update
        await act(async () => {
            await db.table('localNotes').add({ title: 'My Note', content: 'Hello world' });
        });

        await waitFor(() => {
            expect(result.current).toHaveLength(1);
            expect(result.current?.[0].title).toBe('My Note');
        });
    });

    it('non-synced table mutations emit events for all CRUD operations', async () => {
        const { result } = renderHook(() => useLiveQuery((db) => db.table('localNotes').count()));

        await waitFor(() => {
            expect(result.current).toBe(0);
        });

        // Add
        let key: unknown;
        await act(async () => {
            key = await db.table('localNotes').add({ title: 'Note 1' });
        });
        await waitFor(() => expect(result.current).toBe(1));

        // Update
        await act(async () => {
            await db.table('localNotes').update(key!, { title: 'Updated Note' });
        });
        // Count stays same but hook re-ran (we can verify via get)
        const { result: getResult } = renderHook(() => useLiveQuery((db) => db.table('localNotes').get(key!)));
        await waitFor(() => {
            expect(getResult.current?.title).toBe('Updated Note');
        });

        // Delete
        await act(async () => {
            await db.table('localNotes').delete(key!);
        });
        await waitFor(() => expect(result.current).toBe(0));
    });

    it('non-synced table bulk operations emit mutations', async () => {
        const { result } = renderHook(() => useLiveQuery((db) => db.table('localNotes').count()));

        await waitFor(() => {
            expect(result.current).toBe(0);
        });

        // bulkAdd
        await act(async () => {
            await db.table('localNotes').bulkAdd([{ title: 'Note 1' }, { title: 'Note 2' }, { title: 'Note 3' }]);
        });
        await waitFor(() => expect(result.current).toBe(3));

        // clear
        await act(async () => {
            await db.table('localNotes').clear();
        });
        await waitFor(() => expect(result.current).toBe(0));
    });
});
