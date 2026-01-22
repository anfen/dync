/**
 * Mock Backend for Demo
 *
 * This simulates a REST API using an Axios adapter.
 * Replace this with your real API in production.
 */

import axios, { type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';

export type ServerTodo = {
    id?: number;
    updated_at?: string;
    title: string;
    completed: boolean;
    deleted?: boolean;
};

// =============================================================================
// In-Memory Store (replace with your database in production)
// =============================================================================

type TodoStore = {
    getAll: () => ServerTodo[];
    get: (id: number) => ServerTodo | undefined;
    set: (id: number, todo: ServerTodo) => void;
    getNextId: () => number;
};

function createTodoStore(): TodoStore {
    const store = new Map<number, ServerTodo>();
    let nextId = 1;

    return {
        getAll: () => Array.from(store.values()),
        get: (id) => store.get(id),
        set: (id, todo) => {
            store.set(id, todo);
            if (id >= nextId) nextId = id + 1;
        },
        getNextId: () => nextId++,
    };
}

// =============================================================================
// CRUD Handlers
// =============================================================================

type ListParams = { since?: string };

function handleList(store: TodoStore, params: ListParams): ServerTodo[] {
    const since = params.since ? new Date(params.since) : undefined;

    return store
        .getAll()
        .filter((todo) => {
            if (!since) return !todo.deleted;
            const updatedAt = todo.updated_at ? new Date(todo.updated_at).valueOf() : 0;
            return updatedAt > since.valueOf();
        })
        .sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
}

function handleCreate(store: TodoStore, body: Partial<ServerTodo>): ServerTodo {
    const todo: ServerTodo = {
        id: store.getNextId(),
        title: body.title ?? 'Untitled',
        completed: Boolean(body.completed),
        updated_at: new Date().toISOString(),
        deleted: false,
    };
    store.set(todo.id!, todo);
    return todo;
}

function handleUpdate(store: TodoStore, id: number, body: Partial<ServerTodo>): ServerTodo | null {
    const existing = store.get(id);
    if (!existing) return null;

    Object.assign(existing, body, { updated_at: new Date().toISOString() });
    store.set(id, existing);
    return existing;
}

function handleDelete(store: TodoStore, id: number): void {
    const existing = store.get(id);
    if (existing) {
        existing.deleted = true;
        existing.updated_at = new Date().toISOString();
        store.set(id, existing);
    }
}

// =============================================================================
// Batch Sync Handlers
// =============================================================================

type BatchChange = { table: string; action: string; localId: string; id?: number; data?: any };
type BatchResult = { localId: string; success: boolean; id?: number; updated_at?: string; error?: string };

function handleBatchPush(store: TodoStore, changes: BatchChange[]): BatchResult[] {
    return changes.map((change) => {
        switch (change.action) {
            case 'add': {
                const todo = handleCreate(store, change.data ?? {});
                return { localId: change.localId, success: true, id: todo.id, updated_at: todo.updated_at };
            }
            case 'update': {
                const updated = handleUpdate(store, change.id!, change.data ?? {});
                if (!updated) return { localId: change.localId, success: false, error: 'Not found' };
                return { localId: change.localId, success: true, updated_at: updated.updated_at };
            }
            case 'remove': {
                handleDelete(store, change.id!);
                return { localId: change.localId, success: true };
            }
            default:
                return { localId: change.localId, success: false, error: 'Unknown action' };
        }
    });
}

function handleBatchPull(store: TodoStore, sinceByTable: Record<string, string>): Record<string, ServerTodo[]> {
    const result: Record<string, ServerTodo[]> = {};

    if (sinceByTable.todos) {
        result.todos = handleList(store, { since: sinceByTable.todos });
    }

    return result;
}

type FirstLoadParams = { cursors?: Record<string, number> };
type FirstLoadResult = { data: Record<string, ServerTodo[]>; cursors: Record<string, number | undefined>; hasMore: boolean };

function handleFirstLoad(store: TodoStore, params: FirstLoadParams): FirstLoadResult {
    const BATCH_SIZE = 1000;
    const lastId = params.cursors?.todos ?? 0;

    const todos = store
        .getAll()
        .filter((todo) => !todo.deleted && (todo.id ?? 0) > lastId)
        .sort((a, b) => (a.id ?? 0) - (b.id ?? 0))
        .slice(0, BATCH_SIZE);

    const hasMore = todos.length === BATCH_SIZE;

    return {
        data: { todos },
        cursors: hasMore ? { todos: todos[todos.length - 1].id } : {},
        hasMore,
    };
}

// =============================================================================
// Mock Backend Factory
// =============================================================================

export function createMockBackend() {
    type Listener = (todos: ServerTodo[]) => void;
    const listeners = new Set<Listener>();
    const store = createTodoStore();

    const notify = () => {
        const snapshot = store.getAll().filter((todo) => !todo.deleted);
        listeners.forEach((listener) => listener(snapshot));
    };

    const respond = (config: any, data: unknown, status = 200): AxiosResponse => ({
        data,
        status,
        statusText: status >= 400 ? 'Error' : 'OK',
        headers: {},
        config,
    });

    const parseBody = (config: InternalAxiosRequestConfig) => {
        if (!config.data) return {};
        if (typeof config.data === 'string') {
            try {
                return JSON.parse(config.data);
            } catch {
                return {};
            }
        }
        return config.data;
    };

    const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
        const method = (config.method ?? 'get').toUpperCase();
        const url = config.url?.startsWith('/') ? config.url : `/${config.url ?? ''}`;

        await new Promise((resolve) => setTimeout(resolve, 150));

        // CRUD endpoints
        if (method === 'GET' && url === '/todos') {
            const params = (config.params ?? {}) as ListParams;
            return respond(config, handleList(store, params));
        }

        if (method === 'POST' && url === '/todos') {
            const todo = handleCreate(store, parseBody(config));
            notify();
            return respond(config, todo);
        }

        if (method === 'PUT' && url.startsWith('/todos/')) {
            const id = Number(url.replace('/todos/', ''));
            const updated = handleUpdate(store, id, parseBody(config));
            if (!updated) return respond(config, { message: 'Not found' }, 404);
            notify();
            return respond(config, updated);
        }

        if (method === 'PATCH' && url.startsWith('/todos/')) {
            const id = Number(url.replace('/todos/', ''));
            const updated = handleUpdate(store, id, parseBody(config));
            if (!updated) return respond(config, { message: 'Not found' }, 404);
            notify();
            return respond(config, null, 204);
        }

        if (method === 'DELETE' && url.startsWith('/todos/')) {
            const id = Number(url.replace('/todos/', ''));
            handleDelete(store, id);
            notify();
            return respond(config, { success: true });
        }

        // Batch sync endpoints
        if (method === 'POST' && url === '/sync/push') {
            const { changes = [] } = parseBody(config) as { changes: BatchChange[] };
            const results = handleBatchPush(store, changes);
            notify();
            return respond(config, results);
        }

        if (method === 'GET' && url === '/sync/pull') {
            const params = (config.params ?? {}) as Record<string, string>;
            return respond(config, handleBatchPull(store, params));
        }

        if (method === 'GET' && url === '/sync/first-load') {
            const params = (config.params ?? {}) as FirstLoadParams;
            return respond(config, handleFirstLoad(store, params));
        }

        return respond(config, { message: 'Unhandled route' }, 500);
    };

    const client = axios.create({ adapter });

    return {
        client,
        subscribe: (listener: Listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        snapshot: () =>
            store
                .getAll()
                .filter((todo) => !todo.deleted)
                .map((todo) => ({ ...todo })),

        seed: (todos: ServerTodo[]) => {
            for (const todo of todos) {
                if (todo.id != null) {
                    store.set(todo.id, todo);
                }
            }
            notify();
        },
    };
}
