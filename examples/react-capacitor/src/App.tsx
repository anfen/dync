import './index.css';
import { useEffect, useState } from 'react';
import { Dync, SQLiteAdapter, type MissingRemoteRecordStrategy, type SyncedRecord } from '@anfenn/dync';
import { useSyncState, useLiveQuery } from '@anfenn/dync/react';
import { DexieAdapter } from '@anfenn/dync/dexie';
import { CapacitorSQLiteDriver } from '@anfenn/dync/capacitor';
import { Capacitor } from '@capacitor/core';
import { createMockBackend, createCRUDSyncApi, type Todo, type ServerTodo } from '@examples/shared';

// =============================================================================
// DYNC SETUP - Usually in a separate file called store.ts
// =============================================================================

type Store = {
    todos: Todo;
};

const DATABASE_NAME = 'react-capacitor-demo';
const USE_ENCRYPTION = true;

// IGNORE: Demo purposes only
const backend = createMockBackend();

// Create storage adapter based on platform
const storageAdapter = Capacitor.isNativePlatform()
    ? new SQLiteAdapter(
          new CapacitorSQLiteDriver(DATABASE_NAME, {
              encrypted: USE_ENCRYPTION,
              mode: USE_ENCRYPTION ? 'secret' : 'no-encryption',
              getEncryptionKey: () => 'my-encryption-key-from-secure-storage',
          }),
      )
    : new DexieAdapter(DATABASE_NAME);

// Define your schema - SQLite schema for native, Dexie schema for web
const schema = Capacitor.isNativePlatform()
    ? {
          todos: {
              columns: {
                  title: { type: 'TEXT', nullable: false },
                  completed: { type: 'BOOLEAN', nullable: false, default: false },
              },
          },
      }
    : {
          todos: 'title, completed',
      };

// Initialize Dync
export const db = new Dync<Store>(DATABASE_NAME, { todos: createCRUDSyncApi(backend.client) }, storageAdapter, {
    // Default: 2000 ms
    syncInterval: 2000,

    // Default: console
    logger: console,

    // Options: 'debug' | 'info' | 'warn' | 'error' | 'none'
    // Default: 'debug'
    minLogLevel: 'debug',

    // Allows e.g. updating child records with this server assigned id
    onAfterRemoteAdd: (_tableName: string, _item: SyncedRecord) => {},

    // Allows e.g. notifying the user about missing remote record
    onAfterMissingRemoteRecordDuringUpdate: (_strategy: MissingRemoteRecordStrategy, _item: SyncedRecord) => {},

    // Options: 'ignore' | 'delete-local-record' | 'insert-remote-record'
    // Default: 'insert-remote-record'
    // Triggered by api.update() returning false confirming the absence of the remote record
    missingRemoteRecordDuringUpdateStrategy: 'ignore',

    // Options: 'local-wins' | 'remote-wins' | 'try-shallow-merge'
    // Default: 'try-shallow-merge' (Conflicts are listed in syncState.conflicts)
    conflictResolutionStrategy: 'try-shallow-merge',
});

db.version(1).stores(schema);

// =============================================================================
// APP COMPONENT
// =============================================================================

export default function App() {
    const syncState = useSyncState(db);
    const [isReady, setIsReady] = useState(false);
    const [todos, setTodos] = useState<Todo[]>([]);
    const [backendTodos, setBackendTodos] = useState<ServerTodo[]>([]);
    const [newTitle, setNewTitle] = useState('');
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editingTitle, setEditingTitle] = useState('');

    // Initialize Dync
    useEffect(() => {
        (async () => {
            // IGNORE: Demo purposes only - Seed mock backend with existing synced data
            await seedBackendMock();

            if (!db.sync.state.firstLoadDone) {
                await db.sync.startFirstLoad(); // Pass in progress callback if needed
            }
            await db.sync.enable(true);
            setIsReady(true);
        })();

        return () => {
            setIsReady(false);
            void db.sync.enable(false);
        };
    }, []);

    // Reactive updates from Dync
    useLiveQuery(
        db,
        async () => {
            const items = await db.todos.toArray(); // toArray() executes the query
            setTodos(items);
        },
        [], // Re-run when variables change (None specified)
        ['todos'], // Re-run when todos table changes
    );

    // Use Dync to perform CRUD operations
    const handleAdd = async () => {
        const _localId = await db.todos.add({
            title: newTitle.trim(),
            completed: false,
        });

        console.log('Added new todo with _localId:', _localId);
        setNewTitle('');
    };

    const handleUpdate = async () => {
        if (!editingId) return;
        await db.todos.update(editingId, {
            title: editingTitle.trim(),
        });
        setEditingId(null);
        setEditingTitle('');
    };

    const handleToggle = async (todo: Todo) => {
        await db.todos.update(todo._localId, {
            completed: !todo.completed,
        });
    };

    const handleDelete = async (todo: Todo) => {
        await db.todos.delete(todo._localId);
    };

    // IGNORE: Demo purposes only - Subscribe to backend changes
    useEffect(() => {
        setBackendTodos(backend.snapshot());
        return backend.subscribe(setBackendTodos);
    }, []);

    // IGNORE: Demo purposes only - Seed backend with existing synced data
    const seedBackendMock = async () => {
        await db.open();
        const existingTodos = await db.todos.toArray();
        const syncedTodos = existingTodos.filter((t) => t.id != null);
        backend.seed(syncedTodos);
    };

    // IGNORE: Demo purposes only - Reset app
    const handleReset = async () => {
        setIsReady(false);
        await db.sync.enable(false);
        await db.close();
        await db.delete();
        window.location.reload();
    };

    const storageType = Capacitor.isNativePlatform() ? 'SQLite' : 'IndexedDB';

    return (
        <main className="app-shell">
            <header className="app-header">
                <div>
                    <h1>React + {storageType} + Dync</h1>
                    {USE_ENCRYPTION && Capacitor.isNativePlatform() && <span className="eyebrow">🔒 SQLite encryption enabled</span>}
                </div>
                <button type="button" className="ghost" onClick={handleReset} disabled={!isReady}>
                    Reset
                </button>
                <div className={`status-pill status-${syncState.status}`}>
                    <span className="status-label">Sync status</span>
                    <span className="status-dot" />
                    <span className="status-value">{syncState.status}</span>
                </div>
            </header>

            <section className="composer">
                <input type="text" placeholder="Add a todo" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} disabled={!isReady} />
                <button type="button" onClick={handleAdd} disabled={!newTitle.trim() || !isReady}>
                    Add todo
                </button>
            </section>

            {editingId && (
                <section className="editor">
                    <input value={editingTitle} onChange={(e) => setEditingTitle(e.target.value)} placeholder="Update title" />
                    <div className="editor-actions">
                        <button type="button" onClick={handleUpdate} disabled={!editingTitle.trim()}>
                            Save
                        </button>
                        <button type="button" className="ghost" onClick={() => setEditingId(null)}>
                            Cancel
                        </button>
                    </div>
                </section>
            )}

            <div className="panels">
                <TodoPanel
                    title="Local Store (Dync)"
                    caption="These rows come directly from Dync's offline table."
                    todos={todos}
                    readOnly={false}
                    onToggle={handleToggle}
                    onEdit={(todo) => {
                        setEditingId(todo._localId ?? null);
                        setEditingTitle(todo.title);
                    }}
                    onDelete={handleDelete}
                />
                <TodoPanel title="Mocked Backend" caption="Server state (via Axios mock adapter)." todos={backendTodos} readOnly />
            </div>
        </main>
    );
}

// =============================================================================
// UI COMPONENTS
// =============================================================================

type DisplayTodo = {
    _localId?: string;
    id?: string | number;
    title: string;
    completed: boolean;
};

interface TodoPanelProps {
    title: string;
    caption: string;
    todos: DisplayTodo[];
    readOnly: boolean;
    onToggle?: (todo: Todo) => void;
    onEdit?: (todo: Todo) => void;
    onDelete?: (todo: Todo) => void;
}

function TodoPanel({ title, caption, todos, readOnly, onToggle, onEdit, onDelete }: TodoPanelProps) {
    return (
        <section className="panel">
            <header>
                <h2>{title}</h2>
                <p>{caption}</p>
            </header>
            {todos.length === 0 ? (
                <p className="empty">No todos yet.</p>
            ) : (
                <ul className="todo-list">
                    {todos.map((todo) => (
                        <li key={todo._localId ?? `server-${todo.id}`} className="todo-item">
                            <label>
                                <input type="checkbox" checked={Boolean(todo.completed)} disabled={readOnly} onChange={() => onToggle?.(todo as Todo)} />
                                <span className={todo.completed ? 'todo-title done' : 'todo-title'}>{todo.title}</span>
                            </label>
                            {!readOnly && (
                                <div className="todo-actions">
                                    <button type="button" onClick={() => onEdit?.(todo as Todo)}>
                                        Edit
                                    </button>
                                    <button type="button" className="ghost" onClick={() => onDelete?.(todo as Todo)}>
                                        Delete
                                    </button>
                                </div>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}
