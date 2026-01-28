import { useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, FlatList, StyleSheet, SafeAreaView, KeyboardAvoidingView, Platform, Switch, ScrollView } from 'react-native';
import { Dync, SQLiteAdapter, type MissingRemoteRecordStrategy, type SyncedRecord } from '@anfenn/dync';
import { ExpoSQLiteDriver } from '@anfenn/dync/expo-sqlite';
import { useSyncState, useLiveQuery } from '@anfenn/dync/react';
import { createMockBackend, createCRUDSyncApi, type Todo, ServerTodo } from '@examples/shared';
import { seedBackendMock, waitUntil } from './demoOnlyHelpers';

// =============================================================================
// DYNC SETUP - Usually in a separate file called store.ts
// =============================================================================

type Store = {
    todos: Todo;
};

const DATABASE_NAME = 'react-native-expo-sqlite-demo';

// IGNORE: Demo purposes only
const backend = createMockBackend();

// Initialize Dync
export const db = new Dync<Store>({
    databaseName: DATABASE_NAME,
    storageAdapter: new SQLiteAdapter(new ExpoSQLiteDriver(DATABASE_NAME)),
    sync: { todos: createCRUDSyncApi(backend.client) },
    // OR for batch sync:
    // sync: createBatchSyncApi(backend.client),
    options: {
        // Default: 2000 ms
        syncIntervalMs: 2000,

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
    },
});

// Define your schema - SQLite style (with column types)
db.version(1).stores({
    todos: {
        columns: {
            title: { type: 'TEXT', nullable: false },
            completed: { type: 'BOOLEAN', nullable: false, default: false },
        },
    },
});

// =============================================================================
// SCREEN COMPONENT
// =============================================================================

export default function TodoScreen() {
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
            // IGNORE: Demo purposes only - Seeds mock backend with existing local data
            await seedBackendMock(db, backend);

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

    // IGNORE: Demo purposes only - Reset everything
    const handleReset = async () => {
        setIsReady(false);
        await db.sync.enable(false);
        await waitUntil(() => db.syncStatus == 'disabled', 3000);
        await db.todos.clear();
        backend.seed([]);
        setBackendTodos([]);
        await db.sync.enable(true);
        setIsReady(true);
    };

    return (
        <SafeAreaView style={styles.container}>
            <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.keyboardAvoid}>
                <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
                    {/* Header */}
                    <View style={styles.header}>
                        <View>
                            <Text style={styles.title}>Expo + SQLite + Dync</Text>
                        </View>
                        <View style={styles.headerRight}>
                            <TouchableOpacity style={styles.ghostButton} onPress={handleReset} disabled={!isReady}>
                                <Text style={styles.ghostButtonText}>Reset</Text>
                            </TouchableOpacity>
                            <View style={styles.statusPill}>
                                <Text style={styles.statusLabel}>Sync</Text>
                                <View
                                    style={[
                                        styles.statusDot,
                                        syncState.status === 'idle' && styles.statusIdle,
                                        syncState.status === 'syncing' && styles.statusSyncing,
                                        syncState.status === 'error' && styles.statusError,
                                    ]}
                                />
                                <Text style={styles.statusValue}>{syncState.status}</Text>
                            </View>
                        </View>
                    </View>

                    {/* Composer */}
                    <View style={styles.composer}>
                        <TextInput
                            style={styles.input}
                            placeholder="Add a todo"
                            placeholderTextColor="#888"
                            value={newTitle}
                            onChangeText={setNewTitle}
                            editable={isReady}
                            returnKeyType="done"
                            onSubmitEditing={handleAdd}
                        />
                        <TouchableOpacity
                            style={[styles.button, (!newTitle.trim() || !isReady) && styles.buttonDisabled]}
                            onPress={handleAdd}
                            disabled={!newTitle.trim() || !isReady}
                        >
                            <Text style={styles.buttonText}>Add</Text>
                        </TouchableOpacity>
                    </View>

                    {/* Editor */}
                    {editingId && (
                        <View style={styles.editor}>
                            <TextInput
                                style={styles.input}
                                placeholder="Update title"
                                placeholderTextColor="#888"
                                value={editingTitle}
                                onChangeText={setEditingTitle}
                                autoFocus
                            />
                            <View style={styles.editorActions}>
                                <TouchableOpacity
                                    style={[styles.button, !editingTitle.trim() && styles.buttonDisabled]}
                                    onPress={handleUpdate}
                                    disabled={!editingTitle.trim()}
                                >
                                    <Text style={styles.buttonText}>Save</Text>
                                </TouchableOpacity>
                                <TouchableOpacity style={styles.ghostButton} onPress={() => setEditingId(null)}>
                                    <Text style={styles.ghostButtonText}>Cancel</Text>
                                </TouchableOpacity>
                            </View>
                        </View>
                    )}

                    {/* Panels */}
                    <View style={styles.panels}>
                        <TodoPanel
                            title="Local Store (Dync)"
                            caption="These rows come from Dync's offline table."
                            todos={todos}
                            readOnly={false}
                            onToggle={handleToggle}
                            onEdit={(todo) => {
                                setEditingId(todo._localId ?? null);
                                setEditingTitle(todo.title);
                            }}
                            onDelete={handleDelete}
                        />
                        <TodoPanel title="Mocked Backend" caption="Server state (via Axios mock)." todos={backendTodos} readOnly />
                    </View>
                </ScrollView>
            </KeyboardAvoidingView>
        </SafeAreaView>
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
    const renderItem = ({ item }: { item: DisplayTodo }) => (
        <View style={styles.todoItem}>
            <View style={styles.todoLeft}>
                <Switch
                    value={Boolean(item.completed)}
                    onValueChange={() => onToggle?.(item as Todo)}
                    disabled={readOnly}
                    trackColor={{ false: '#444', true: '#646cff' }}
                    thumbColor="#fff"
                />
                <Text style={[styles.todoTitle, item.completed && styles.todoTitleDone]} numberOfLines={1}>
                    {item.title}
                </Text>
            </View>
            {!readOnly && (
                <View style={styles.todoActions}>
                    <TouchableOpacity style={styles.smallButton} onPress={() => onEdit?.(item as Todo)}>
                        <Text style={styles.smallButtonText}>Edit</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.smallGhostButton} onPress={() => onDelete?.(item as Todo)}>
                        <Text style={styles.smallGhostButtonText}>Del</Text>
                    </TouchableOpacity>
                </View>
            )}
        </View>
    );

    return (
        <View style={styles.panel}>
            <View style={styles.panelHeader}>
                <Text style={styles.panelTitle}>{title}</Text>
                <Text style={styles.panelCaption}>{caption}</Text>
            </View>
            {todos.length === 0 ? (
                <Text style={styles.empty}>No todos yet.</Text>
            ) : (
                <FlatList data={todos} keyExtractor={(item) => item._localId ?? `server-${item.id}`} renderItem={renderItem} scrollEnabled={false} />
            )}
        </View>
    );
}

// =============================================================================
// STYLES
// =============================================================================

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#121212',
        paddingTop: 25,
    },
    keyboardAvoid: {
        flex: 1,
    },
    scrollContent: {
        padding: 16,
        flexGrow: 1,
    },
    header: {
        marginBottom: 24,
    },
    eyebrow: {
        fontSize: 11,
        textTransform: 'uppercase',
        letterSpacing: 1,
        color: '#888',
        marginBottom: 4,
    },
    title: {
        fontSize: 22,
        fontWeight: '700',
        color: '#fff',
        marginBottom: 4,
    },
    subtitle: {
        fontSize: 13,
        color: '#888',
        maxWidth: 300,
    },
    headerRight: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        marginTop: 12,
    },
    statusPill: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        backgroundColor: 'rgba(255,255,255,0.05)',
        paddingVertical: 4,
        paddingHorizontal: 10,
        borderRadius: 999,
    },
    statusLabel: {
        fontSize: 11,
        color: '#888',
    },
    statusDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: '#888',
    },
    statusIdle: {
        backgroundColor: '#10b981',
    },
    statusSyncing: {
        backgroundColor: '#f59e0b',
    },
    statusError: {
        backgroundColor: '#ef4444',
    },
    statusValue: {
        fontSize: 11,
        color: '#fff',
        fontWeight: '500',
        textTransform: 'capitalize',
    },
    composer: {
        flexDirection: 'row',
        gap: 8,
        marginBottom: 16,
    },
    input: {
        flex: 1,
        backgroundColor: '#1a1a1a',
        borderWidth: 1,
        borderColor: '#333',
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        fontSize: 15,
        color: '#fff',
    },
    button: {
        backgroundColor: '#646cff',
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderRadius: 8,
        justifyContent: 'center',
    },
    buttonDisabled: {
        opacity: 0.5,
    },
    buttonText: {
        color: '#fff',
        fontWeight: '600',
        fontSize: 14,
    },
    ghostButton: {
        borderWidth: 1,
        borderColor: '#444',
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 8,
    },
    ghostButtonText: {
        color: '#888',
        fontSize: 13,
    },
    editor: {
        backgroundColor: 'rgba(100,108,255,0.1)',
        borderWidth: 1,
        borderColor: '#646cff',
        borderRadius: 10,
        padding: 12,
        marginBottom: 16,
    },
    editorActions: {
        flexDirection: 'row',
        gap: 8,
        marginTop: 10,
    },
    panels: {
        flex: 1,
        gap: 16,
    },
    panel: {
        backgroundColor: '#1a1a1a',
        borderWidth: 1,
        borderColor: '#333',
        borderRadius: 12,
        padding: 14,
    },
    panelHeader: {
        marginBottom: 12,
    },
    panelTitle: {
        fontSize: 15,
        fontWeight: '600',
        color: '#fff',
    },
    panelCaption: {
        fontSize: 11,
        color: '#888',
        marginTop: 2,
    },
    empty: {
        color: '#666',
        fontStyle: 'italic',
        textAlign: 'center',
        paddingVertical: 20,
    },
    todoItem: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: '#333',
    },
    todoLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        flex: 1,
    },
    todoTitle: {
        fontSize: 14,
        color: '#fff',
        flex: 1,
    },
    todoTitleDone: {
        textDecorationLine: 'line-through',
        color: '#666',
    },
    todoActions: {
        flexDirection: 'row',
        gap: 6,
    },
    smallButton: {
        backgroundColor: '#646cff',
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 6,
    },
    smallButtonText: {
        color: '#fff',
        fontSize: 11,
        fontWeight: '500',
    },
    smallGhostButton: {
        borderWidth: 1,
        borderColor: '#444',
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 6,
    },
    smallGhostButtonText: {
        color: '#888',
        fontSize: 11,
    },
});
