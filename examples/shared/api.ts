import type { AxiosInstance } from 'axios';
import type { CrudSyncApi, BatchSync, BatchPushPayload, BatchPushResult, BatchFirstLoadResult } from '@anfenn/dync';

export type Todo = {
    _localId: string;
    id?: number;
    updated_at?: string;
    title: string;
    completed: boolean;
};

export type ServerTodo = Omit<Todo, '_localId'>;

export function createCRUDSyncApi(api: AxiosInstance): CrudSyncApi {
    return {
        add: async (todo: Todo) => {
            const { data } = await api.post('/todos', todo);
            // Must return server assigned `updated_at`, and `id` (if not client assigned)
            return data as Todo;
        },
        update: async (id: number, changes: Partial<Todo>, _item: Todo) => {
            // `changes` for PATCH, `item` for PUT
            const { status, statusText } = await api.put<Todo>(`/todos/${id}`, changes, { validateStatus: () => true });
            // Return false if not found, Dync will then use the missing remote record strategy of `ignore`, `delete-local-record` or `insert-remote-record`
            if (status === 404) return false;
            // All api errors are visible in syncState.apiError
            if (status >= 400) throw new Error(`Failed to update: ${statusText}`);

            return true;
        },
        remove: async (id: number) => {
            // Soft delete i.e. leave the record on the server but mark it as deleted, allowing other clients to know to delete locally
            const payload = {
                deleted: true,
            };

            const { status, statusText } = await api.patch<Todo>(`/todos/${id}`, payload, { validateStatus: () => true });

            if (status !== 204 && status !== 404) {
                // 204 No Content is expected, 404 Not Found can be safely ignored
                throw new Error(statusText);
            }
        },
        // Optional: Delay calling this endpoint during a pull for e.g. 1 week, if slow changing data, to reduce server load
        listExtraIntervalMs: 0, // e.g. 7 * 24 * 60 * 60 * 1000 for 1 week
        list: async (lastUpdatedAt: Date) => {
            // Called during sync pull
            // Include soft-deleted records (`deleted: true`) in the response
            // lastUpdatedAt is the most recent server `updated_at` timestamp, never the clients
            // The timestamp comparison should be `>` not `>=`
            const { data } = await api.get('/todos', { params: { since: lastUpdatedAt.toISOString() } });
            return data as Todo[];
        },
        firstLoad: async (lastId: unknown): Promise<Todo[]> => {
            // First called by `db.sync.startFirstLoad()`, typically on first app launch.
            // Repeats until it returns an empty array.

            if (!lastId) lastId = 0; // Cursor for pagination. `undefined` on first call to allow define datatype (number, string, etc.)

            const { data } = await api.get('/todos', {
                params: {
                    limit: 1000,
                    order_by: 'id',
                    order_direction: 'asc',
                    id_gt: lastId, // "id greater than" - your API may use different param names
                },
            });

            return data as Todo[];
        },
    };
}

export function createBatchSyncApi(api: AxiosInstance): BatchSync {
    return {
        syncTables: ['todos'],
        push: async (changes: BatchPushPayload[]): Promise<BatchPushResult[]> => {
            const { data } = await api.post('/sync/push', { changes });
            return data as BatchPushResult[];
        },
        pull: async (since: Record<string, Date>): Promise<Record<string, any[]>> => {
            const params = Object.fromEntries(Object.entries(since).map(([table, date]) => [table, date.toISOString()]));
            const { data } = await api.get('/sync/pull', { params });
            return data as Record<string, any[]>;
        },
        firstLoad: async (cursors: Record<string, any>): Promise<BatchFirstLoadResult> => {
            const { data } = await api.get('/sync/first-load', { params: { cursors } });
            return data as BatchFirstLoadResult;
        },
    };
}
