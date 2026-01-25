import { describe, expect, it } from 'vitest';
import { createTestDync } from '../helpers/dyncHarness';
import { storageAdapterScenarios } from '../helpers/storageAdapters';
import type { SyncedRecord } from '../../src/types';
import { createLocalId } from '../../src/createLocalId';

// ============================================================================
// Test Schema
// ============================================================================

interface Todo extends SyncedRecord {
    title: string;
    completed: boolean;
    priority: number;
    category: string;
    dueDate: string | null;
    tags: string;
    assignedTo: string | null; // Foreign key to User._localId
}

interface User extends SyncedRecord {
    name: string;
    email: string;
    age: number;
    role: string;
    active: boolean;
}

interface TestSchema {
    todos: Todo;
    users: User;
}

const structuredSchema = {
    todos: {
        columns: {
            title: { type: 'TEXT' as const },
            completed: { type: 'BOOLEAN' as const },
            priority: { type: 'INTEGER' as const },
            category: { type: 'TEXT' as const },
            dueDate: { type: 'TEXT' as const },
            tags: { type: 'TEXT' as const },
            assignedTo: { type: 'TEXT' as const },
        },
    },
    users: {
        columns: {
            name: { type: 'TEXT' as const },
            email: { type: 'TEXT' as const },
            age: { type: 'INTEGER' as const },
            role: { type: 'TEXT' as const },
            active: { type: 'BOOLEAN' as const },
        },
    },
};

const dexieSchema = {
    todos: 'title, completed, priority, category, dueDate, assignedTo',
    users: 'name, email, age, role, active',
};

// Stub APIs - we're not testing sync, just queries
const apis = {
    todos: {
        add: async () => ({ id: 1, updated_at: new Date().toISOString() }),
        update: async () => true,
        remove: async () => {},
        list: async () => [],
        firstLoad: async () => [],
    },
    users: {
        add: async () => ({ id: 1, updated_at: new Date().toISOString() }),
        update: async () => true,
        remove: async () => {},
        list: async () => [],
        firstLoad: async () => [],
    },
};

// ============================================================================
// Test Data Factories
// ============================================================================

const createTodo = (overrides: Partial<Omit<Todo, '_localId'>> = {}): Todo => ({
    _localId: createLocalId(),
    updated_at: new Date().toISOString(),
    title: 'Test Todo',
    completed: false,
    priority: 1,
    category: 'work',
    dueDate: null,
    tags: '',
    assignedTo: null,
    ...overrides,
});

const createUser = (overrides: Partial<Omit<User, '_localId'>> = {}): User => ({
    _localId: createLocalId(),
    updated_at: new Date().toISOString(),
    name: 'Test User',
    email: 'test@example.com',
    age: 30,
    role: 'user',
    active: true,
    ...overrides,
});

// ============================================================================
// Test Suite
// ============================================================================

describe('Dync Query API', () => {
    // Run tests for each adapter
    for (const scenario of storageAdapterScenarios) {
        describe(`${scenario.label}`, () => {
            const createDb = async () => {
                const dbName = `query-${scenario.key}-${Math.random().toString(36).slice(2)}`;
                const schema = scenario.key === 'sqlite' ? structuredSchema : dexieSchema;

                return createTestDync<TestSchema>(apis, schema, {
                    storageAdapterFactory: scenario.createAdapter,
                    dbName,
                });
            };

            // ================================================================
            // Basic CRUD Operations
            // ================================================================

            describe('Basic CRUD', () => {
                it('adds and retrieves a single record', async () => {
                    const db = await createDb();
                    const table = db.table('todos');

                    await table.add(createTodo({ title: 'Buy groceries' }));

                    const all = await table.toArray();
                    expect(all).toHaveLength(1);
                    expect(all[0]!.title).toBe('Buy groceries');

                    await db.close();
                });

                it('gets a record by primary key', async () => {
                    const db = await createDb();
                    const table = db.table('todos');

                    const todo = createTodo({ title: 'Read book' });
                    await table.add(todo);

                    const all = await table.toArray();
                    const key = all[0]!._localId;

                    const retrieved = await table.get(key);
                    expect(retrieved?.title).toBe('Read book');

                    await db.close();
                });

                it('updates a record with partial changes', async () => {
                    const db = await createDb();
                    const table = db.table('todos');

                    await table.add(createTodo({ title: 'Original', priority: 1 }));
                    const all = await table.toArray();
                    const key = all[0]!._localId;

                    await table.update(key, { priority: 5 });

                    const updated = await table.get(key);
                    expect(updated?.title).toBe('Original');
                    expect(updated?.priority).toBe(5);

                    await db.close();
                });

                it('deletes a record by primary key', async () => {
                    const db = await createDb();
                    const table = db.table('todos');

                    await table.add(createTodo({ title: 'To delete' }));
                    const all = await table.toArray();
                    const key = all[0]!._localId;

                    await table.delete(key);

                    expect(await table.count()).toBe(0);
                    expect(await table.get(key)).toBeUndefined();

                    await db.close();
                });

                it('puts (upserts) a record', async () => {
                    const db = await createDb();
                    const table = db.table('todos');

                    // First put creates
                    const fixedId = 'fixed-id-123';
                    const todo = { ...createTodo({ title: 'Upsert me' }), _localId: fixedId };
                    await table.put(todo);

                    expect(await table.count()).toBe(1);

                    // Second put updates
                    todo.title = 'Updated title';
                    await table.put(todo);

                    expect(await table.count()).toBe(1);
                    const retrieved = await table.get(fixedId);
                    expect(retrieved?.title).toBe('Updated title');

                    await db.close();
                });

                it('clears all records from a table', async () => {
                    const db = await createDb();
                    const table = db.table('todos');

                    await table.bulkAdd([createTodo({ title: 'One' }), createTodo({ title: 'Two' }), createTodo({ title: 'Three' })]);

                    expect(await table.count()).toBe(3);

                    await table.clear();

                    expect(await table.count()).toBe(0);

                    await db.close();
                });
            });

            // ================================================================
            // Bulk Operations
            // ================================================================

            describe('Bulk Operations', () => {
                it('bulk adds multiple records', async () => {
                    const db = await createDb();
                    const table = db.table('todos');

                    await table.bulkAdd([
                        createTodo({ title: 'Task 1', priority: 1 }),
                        createTodo({ title: 'Task 2', priority: 2 }),
                        createTodo({ title: 'Task 3', priority: 3 }),
                    ]);

                    expect(await table.count()).toBe(3);

                    await db.close();
                });

                it('bulk gets multiple records by keys', async () => {
                    const db = await createDb();
                    const table = db.table('todos');

                    await table.bulkAdd([createTodo({ title: 'Task A' }), createTodo({ title: 'Task B' }), createTodo({ title: 'Task C' })]);

                    const all = await table.toArray();
                    // Sort to get predictable order
                    all.sort((a, b) => a.title.localeCompare(b.title));
                    const keyA = all.find((t) => t.title === 'Task A')!._localId;
                    const keyC = all.find((t) => t.title === 'Task C')!._localId;

                    const results = await table.bulkGet([keyA, keyC]);
                    expect(results).toHaveLength(2);
                    // bulkGet returns results in the same order as requested keys
                    expect(results.map((r) => r?.title).sort()).toEqual(['Task A', 'Task C']);

                    await db.close();
                });

                it('bulk deletes multiple records', async () => {
                    const db = await createDb();
                    const table = db.table('todos');

                    await table.bulkAdd([createTodo({ title: 'Keep' }), createTodo({ title: 'Delete 1' }), createTodo({ title: 'Delete 2' })]);

                    const keysToDelete = await table
                        .jsFilter((t) => t.title.startsWith('Delete'))
                        .toArray()
                        .then((todos) => todos.map((t) => t._localId));

                    await table.bulkDelete(keysToDelete);

                    const remaining = await table.toArray();
                    expect(remaining).toHaveLength(1);
                    expect(remaining[0]!.title).toBe('Keep');

                    await db.close();
                });

                it('bulk puts (upserts) multiple records', async () => {
                    const db = await createDb();
                    const table = db.table('todos');

                    const todos: Todo[] = [
                        { ...createTodo({ title: 'Bulk 1' }), _localId: 'bulk-1' },
                        { ...createTodo({ title: 'Bulk 2' }), _localId: 'bulk-2' },
                    ];

                    await table.bulkPut(todos);
                    expect(await table.count()).toBe(2);

                    // Update via bulkPut
                    todos[0]!.title = 'Bulk 1 Updated';
                    todos[1]!.title = 'Bulk 2 Updated';
                    await table.bulkPut(todos);

                    expect(await table.count()).toBe(2);
                    const results = await table.toArray();
                    expect(results.map((t) => t.title).sort()).toEqual(['Bulk 1 Updated', 'Bulk 2 Updated']);

                    await db.close();
                });

                it('bulk updates multiple records with different changes', async () => {
                    const db = await createDb();
                    const table = db.table('todos');

                    const todo1 = { ...createTodo({ title: 'Task 1', priority: 1 }), _localId: 'update-1' };
                    const todo2 = { ...createTodo({ title: 'Task 2', priority: 2 }), _localId: 'update-2' };
                    const todo3 = { ...createTodo({ title: 'Task 3', priority: 3 }), _localId: 'update-3' };

                    await table.bulkAdd([todo1, todo2, todo3]);

                    const updatedCount = await table.bulkUpdate([
                        { key: 'update-1', changes: { title: 'Task 1 Updated', priority: 10 } },
                        { key: 'update-3', changes: { title: 'Task 3 Updated', completed: true } },
                    ]);

                    expect(updatedCount).toBe(2);

                    const results = await table.toArray();
                    const byKey = Object.fromEntries(results.map((t) => [t._localId, t]));

                    expect(byKey['update-1']!.title).toBe('Task 1 Updated');
                    expect(byKey['update-1']!.priority).toBe(10);
                    expect(byKey['update-2']!.title).toBe('Task 2'); // unchanged
                    expect(byKey['update-3']!.title).toBe('Task 3 Updated');
                    expect(byKey['update-3']!.completed).toBe(true);

                    await db.close();
                });
            });

            // ================================================================
            // BOOLEAN Type Abstraction
            // ================================================================
            // These tests prove that boolean fields work correctly across all
            // storage adapters, including SQLite which stores booleans as 0/1.
            // The BOOLEAN pseudo-type ensures:
            // 1. Booleans are stored as integers in SQLite (true→1, false→0)
            // 2. When hydrated, integers are converted back to booleans (1→true, 0→false)
            // 3. Strict equality (=== true, === false) works uniformly across adapters

            describe('BOOLEAN Type Abstraction', () => {
                it('stores and retrieves boolean true correctly', async () => {
                    const db = await createDb();
                    const table = db.table('todos');

                    await table.add(createTodo({ title: 'Completed task', completed: true }));

                    const [todo] = await table.toArray();
                    expect(todo?.completed).toBe(true);
                    expect(typeof todo?.completed).toBe('boolean');
                    // Strict equality must work - not just truthy
                    expect(todo?.completed === true).toBe(true);
                    expect(todo?.completed === false).toBe(false);

                    await db.close();
                });

                it('stores and retrieves boolean false correctly', async () => {
                    const db = await createDb();
                    const table = db.table('todos');

                    await table.add(createTodo({ title: 'Pending task', completed: false }));

                    const [todo] = await table.toArray();
                    expect(todo?.completed).toBe(false);
                    expect(typeof todo?.completed).toBe('boolean');
                    // Strict equality must work - not just falsy
                    expect(todo?.completed === false).toBe(true);
                    expect(todo?.completed === true).toBe(false);

                    await db.close();
                });

                it('filters by boolean true with strict equality', async () => {
                    const db = await createDb();
                    const table = db.table('todos');

                    await table.bulkAdd([
                        createTodo({ title: 'Done 1', completed: true }),
                        createTodo({ title: 'Done 2', completed: true }),
                        createTodo({ title: 'Pending 1', completed: false }),
                        createTodo({ title: 'Pending 2', completed: false }),
                        createTodo({ title: 'Pending 3', completed: false }),
                    ]);

                    // Filter using strict equality - this would fail without BOOLEAN type
                    // conversion since SQLite stores 1/0, not true/false
                    const completed = await table.jsFilter((t) => t.completed === true).toArray();
                    expect(completed).toHaveLength(2);
                    expect(completed.every((t) => t.completed === true)).toBe(true);

                    await db.close();
                });

                it('filters by boolean false with strict equality', async () => {
                    const db = await createDb();
                    const table = db.table('todos');

                    await table.bulkAdd([
                        createTodo({ title: 'Done 1', completed: true }),
                        createTodo({ title: 'Done 2', completed: true }),
                        createTodo({ title: 'Pending 1', completed: false }),
                        createTodo({ title: 'Pending 2', completed: false }),
                    ]);

                    const pending = await table.jsFilter((t) => t.completed === false).toArray();
                    expect(pending).toHaveLength(2);
                    expect(pending.every((t) => t.completed === false)).toBe(true);

                    await db.close();
                });

                it('updates boolean field from false to true', async () => {
                    const db = await createDb();
                    const table = db.table('todos');

                    const todo = createTodo({ title: 'Toggle me', completed: false });
                    await table.add(todo);

                    // Verify initial state
                    let [retrieved] = await table.toArray();
                    expect(retrieved?.completed).toBe(false);

                    // Update to true
                    await table.update(retrieved!._localId, { completed: true });

                    [retrieved] = await table.toArray();
                    expect(retrieved?.completed).toBe(true);
                    expect(typeof retrieved?.completed).toBe('boolean');

                    await db.close();
                });

                it('updates boolean field from true to false', async () => {
                    const db = await createDb();
                    const table = db.table('todos');

                    const todo = createTodo({ title: 'Toggle me', completed: true });
                    await table.add(todo);

                    // Update to false
                    const all = await table.toArray();
                    await table.update(all[0]!._localId, { completed: false });

                    const [retrieved] = await table.toArray();
                    expect(retrieved?.completed).toBe(false);
                    expect(typeof retrieved?.completed).toBe('boolean');

                    await db.close();
                });

                it('works with multiple boolean columns', async () => {
                    const db = await createDb();
                    const userTable = db.table('users');

                    // Users have an 'active' boolean column
                    await userTable.bulkAdd([
                        createUser({ name: 'Active User 1', active: true }),
                        createUser({ name: 'Active User 2', active: true }),
                        createUser({ name: 'Inactive User', active: false }),
                    ]);

                    const activeUsers = await userTable.jsFilter((u) => u.active === true).toArray();
                    expect(activeUsers).toHaveLength(2);
                    expect(activeUsers.every((u) => typeof u.active === 'boolean')).toBe(true);

                    const inactiveUsers = await userTable.jsFilter((u) => u.active === false).toArray();
                    expect(inactiveUsers).toHaveLength(1);
                    expect(inactiveUsers[0]?.name).toBe('Inactive User');

                    await db.close();
                });

                it('handles boolean in complex filter expressions', async () => {
                    const db = await createDb();
                    const table = db.table('todos');

                    await table.bulkAdd([
                        createTodo({ title: 'High priority done', completed: true, priority: 5 }),
                        createTodo({ title: 'High priority pending', completed: false, priority: 5 }),
                        createTodo({ title: 'Low priority done', completed: true, priority: 1 }),
                        createTodo({ title: 'Low priority pending', completed: false, priority: 1 }),
                    ]);

                    // Complex filter: high priority AND not completed
                    const highPriorityPending = await table.jsFilter((t) => t.priority >= 5 && t.completed === false).toArray();
                    expect(highPriorityPending).toHaveLength(1);
                    expect(highPriorityPending[0]?.title).toBe('High priority pending');

                    // Complex filter: completed OR low priority
                    const completedOrLow = await table.jsFilter((t) => t.completed === true || t.priority < 3).toArray();
                    expect(completedOrLow).toHaveLength(3);

                    await db.close();
                });

                it('preserves boolean type through put (upsert)', async () => {
                    const db = await createDb();
                    const table = db.table('todos');

                    const todo = { ...createTodo({ title: 'Upsert test', completed: false }), _localId: 'upsert-bool-test' };
                    await table.put(todo);

                    let retrieved = await table.get('upsert-bool-test');
                    expect(retrieved?.completed).toBe(false);
                    expect(typeof retrieved?.completed).toBe('boolean');

                    // Upsert with changed boolean
                    todo.completed = true;
                    await table.put(todo);

                    retrieved = await table.get('upsert-bool-test');
                    expect(retrieved?.completed).toBe(true);
                    expect(typeof retrieved?.completed).toBe('boolean');

                    await db.close();
                });
            });

            // ================================================================
            // Where Clause - Equality
            // ================================================================

            describe('Where Clause - Equality', () => {
                it('finds records with equals()', async () => {
                    const db = await createDb();
                    const table = db.table('todos');

                    await table.bulkAdd([
                        createTodo({ title: 'Work task', category: 'work' }),
                        createTodo({ title: 'Home task', category: 'home' }),
                        createTodo({ title: 'Another work', category: 'work' }),
                    ]);

                    const workTodos = await table.where('category').equals('work').toArray();
                    expect(workTodos).toHaveLength(2);
                    expect(workTodos.every((t) => t.category === 'work')).toBe(true);

                    await db.close();
                });

                it('finds records with equalsIgnoreCase()', async () => {
                    const db = await createDb();
                    const table = db.table('users');

                    await table.bulkAdd([
                        createUser({ name: 'Alice', role: 'ADMIN' }),
                        createUser({ name: 'Bob', role: 'admin' }),
                        createUser({ name: 'Charlie', role: 'user' }),
                    ]);

                    const admins = await table.where('role').equalsIgnoreCase('admin').toArray();
                    expect(admins).toHaveLength(2);

                    await db.close();
                });

                it('finds records with notEqual()', async () => {
                    const db = await createDb();
                    const table = db.table('todos');

                    await table.bulkAdd([
                        createTodo({ title: 'Low', priority: 1 }),
                        createTodo({ title: 'Medium', priority: 2 }),
                        createTodo({ title: 'High', priority: 3 }),
                    ]);

                    const notLow = await table.where('priority').notEqual(1).toArray();
                    expect(notLow).toHaveLength(2);
                    expect(notLow.every((t) => t.priority !== 1)).toBe(true);

                    await db.close();
                });
            });

            // ================================================================
            // Where Clause - Comparisons
            // ================================================================

            describe('Where Clause - Comparisons', () => {
                it('finds records with above()', async () => {
                    const db = await createDb();
                    const table = db.table('users');

                    await table.bulkAdd([
                        createUser({ name: 'Young', age: 20 }),
                        createUser({ name: 'Middle', age: 35 }),
                        createUser({ name: 'Senior', age: 55 }),
                    ]);

                    const over30 = await table.where('age').above(30).toArray();
                    expect(over30).toHaveLength(2);
                    expect(over30.every((u) => u.age > 30)).toBe(true);

                    await db.close();
                });

                it('finds records with aboveOrEqual()', async () => {
                    const db = await createDb();
                    const table = db.table('todos');

                    await table.bulkAdd([
                        createTodo({ title: 'P1', priority: 1 }),
                        createTodo({ title: 'P2', priority: 2 }),
                        createTodo({ title: 'P3', priority: 3 }),
                    ]);

                    const priority2Plus = await table.where('priority').aboveOrEqual(2).toArray();
                    expect(priority2Plus).toHaveLength(2);

                    await db.close();
                });

                it('finds records with below()', async () => {
                    const db = await createDb();
                    const table = db.table('users');

                    await table.bulkAdd([
                        createUser({ name: 'Teen', age: 18 }),
                        createUser({ name: 'Adult', age: 25 }),
                        createUser({ name: 'Older', age: 40 }),
                    ]);

                    const under25 = await table.where('age').below(25).toArray();
                    expect(under25).toHaveLength(1);
                    expect(under25[0]!.name).toBe('Teen');

                    await db.close();
                });

                it('finds records with belowOrEqual()', async () => {
                    const db = await createDb();
                    const table = db.table('todos');

                    await table.bulkAdd([
                        createTodo({ title: 'P1', priority: 1 }),
                        createTodo({ title: 'P2', priority: 2 }),
                        createTodo({ title: 'P3', priority: 3 }),
                    ]);

                    const lowPriority = await table.where('priority').belowOrEqual(2).toArray();
                    expect(lowPriority).toHaveLength(2);

                    await db.close();
                });

                it('finds records with between()', async () => {
                    const db = await createDb();
                    const table = db.table('users');

                    await table.bulkAdd([
                        createUser({ name: 'A', age: 15 }),
                        createUser({ name: 'B', age: 25 }),
                        createUser({ name: 'C', age: 35 }),
                        createUser({ name: 'D', age: 45 }),
                    ]);

                    // Default: includeLower=true, includeUpper=false
                    const range = await table.where('age').between(25, 45).toArray();
                    expect(range).toHaveLength(2);
                    expect(range.map((u) => u.name).sort()).toEqual(['B', 'C']);

                    // Include both bounds
                    const inclusive = await table.where('age').between(25, 45, true, true).toArray();
                    expect(inclusive).toHaveLength(3);

                    await db.close();
                });
            });

            // ================================================================
            // Where Clause - String Matching
            // ================================================================

            describe('Where Clause - String Matching', () => {
                it('finds records with startsWith()', async () => {
                    const db = await createDb();
                    const table = db.table('todos');

                    await table.bulkAdd([createTodo({ title: 'Buy milk' }), createTodo({ title: 'Buy bread' }), createTodo({ title: 'Call mom' })]);

                    const buyTasks = await table.where('title').startsWith('Buy').toArray();
                    expect(buyTasks).toHaveLength(2);

                    await db.close();
                });

                it('finds records with startsWithIgnoreCase()', async () => {
                    const db = await createDb();
                    const table = db.table('todos');

                    await table.bulkAdd([createTodo({ title: 'BUY MILK' }), createTodo({ title: 'buy bread' }), createTodo({ title: 'Call mom' })]);

                    const buyTasks = await table.where('title').startsWithIgnoreCase('buy').toArray();
                    expect(buyTasks).toHaveLength(2);

                    await db.close();
                });

                it('finds records with startsWithAnyOf()', async () => {
                    const db = await createDb();
                    const table = db.table('todos');

                    await table.bulkAdd([
                        createTodo({ title: 'Buy groceries' }),
                        createTodo({ title: 'Call friend' }),
                        createTodo({ title: 'Send email' }),
                        createTodo({ title: 'Walk dog' }),
                    ]);

                    const tasks = await table.where('title').startsWithAnyOf(['Buy', 'Call', 'Send']).toArray();
                    expect(tasks).toHaveLength(3);

                    await db.close();
                });
            });

            // ================================================================
            // Where Clause - Set Operations
            // ================================================================

            describe('Where Clause - Set Operations', () => {
                it('finds records with anyOf()', async () => {
                    const db = await createDb();
                    const table = db.table('todos');

                    await table.bulkAdd([
                        createTodo({ title: 'Work', category: 'work' }),
                        createTodo({ title: 'Home', category: 'home' }),
                        createTodo({ title: 'Health', category: 'health' }),
                        createTodo({ title: 'Fun', category: 'leisure' }),
                    ]);

                    const selected = await table.where('category').anyOf(['work', 'home']).toArray();
                    expect(selected).toHaveLength(2);

                    await db.close();
                });

                it('finds records with anyOfIgnoreCase()', async () => {
                    const db = await createDb();
                    const table = db.table('users');

                    await table.bulkAdd([
                        createUser({ name: 'Alice', role: 'ADMIN' }),
                        createUser({ name: 'Bob', role: 'User' }),
                        createUser({ name: 'Charlie', role: 'guest' }),
                    ]);

                    const selected = await table.where('role').anyOfIgnoreCase(['admin', 'user']).toArray();
                    expect(selected).toHaveLength(2);

                    await db.close();
                });

                it('finds records with noneOf()', async () => {
                    const db = await createDb();
                    const table = db.table('todos');

                    await table.bulkAdd([
                        createTodo({ title: 'P1', priority: 1 }),
                        createTodo({ title: 'P2', priority: 2 }),
                        createTodo({ title: 'P3', priority: 3 }),
                        createTodo({ title: 'P4', priority: 4 }),
                    ]);

                    const excluded = await table.where('priority').noneOf([1, 4]).toArray();
                    expect(excluded).toHaveLength(2);
                    expect(excluded.every((t) => t.priority !== 1 && t.priority !== 4)).toBe(true);

                    await db.close();
                });
            });

            // ================================================================
            // Collection Operations
            // ================================================================

            describe('Collection Operations', () => {
                it('gets first() and last() records', async () => {
                    const db = await createDb();
                    const table = db.table('todos');

                    await table.bulkAdd([
                        createTodo({ title: 'First', priority: 1 }),
                        createTodo({ title: 'Second', priority: 2 }),
                        createTodo({ title: 'Third', priority: 3 }),
                    ]);

                    const first = await table.orderBy('priority').first();
                    expect(first?.title).toBe('First');

                    const last = await table.orderBy('priority').last();
                    expect(last?.title).toBe('Third');

                    await db.close();
                });

                it('counts records with count()', async () => {
                    const db = await createDb();
                    const table = db.table('todos');

                    await table.bulkAdd([createTodo({ completed: true }), createTodo({ completed: true }), createTodo({ completed: false })]);

                    const total = await table.count();
                    expect(total).toBe(3);

                    // BOOLEAN type columns are hydrated as true/false, so strict equality works
                    const completedCount = await table.jsFilter((t) => t.completed === true).count();
                    expect(completedCount).toBe(2);

                    await db.close();
                });

                it('iterates with each()', async () => {
                    const db = await createDb();
                    const table = db.table('todos');

                    await table.bulkAdd([createTodo({ title: 'One' }), createTodo({ title: 'Two' }), createTodo({ title: 'Three' })]);

                    const titles: string[] = [];
                    await table.each((todo) => {
                        titles.push(todo.title);
                    });

                    expect(titles).toHaveLength(3);

                    await db.close();
                });

                it('gets keys with keys() and primaryKeys()', async () => {
                    const db = await createDb();
                    const table = db.table('todos');

                    await table.bulkAdd([createTodo({ title: 'A' }), createTodo({ title: 'B' })]);

                    const keys = await table.where('title').equals('A').keys();
                    expect(keys).toHaveLength(1);

                    const primaryKeys = await table.where('title').equals('B').primaryKeys();
                    expect(primaryKeys).toHaveLength(1);

                    await db.close();
                });
            });

            // ================================================================
            // Ordering and Pagination
            // ================================================================

            describe('Ordering and Pagination', () => {
                it('orders by a field with orderBy()', async () => {
                    const db = await createDb();
                    const table = db.table('todos');

                    await table.bulkAdd([
                        createTodo({ title: 'C Task', priority: 3 }),
                        createTodo({ title: 'A Task', priority: 1 }),
                        createTodo({ title: 'B Task', priority: 2 }),
                    ]);

                    const ordered = await table.orderBy('priority').toArray();
                    expect(ordered.map((t) => t.priority)).toEqual([1, 2, 3]);

                    await db.close();
                });

                it('reverses order with reverse()', async () => {
                    const db = await createDb();
                    const table = db.table('todos');

                    await table.bulkAdd([
                        createTodo({ title: 'A', priority: 1 }),
                        createTodo({ title: 'B', priority: 2 }),
                        createTodo({ title: 'C', priority: 3 }),
                    ]);

                    const reversed = await table.orderBy('priority').reverse().toArray();
                    expect(reversed.map((t) => t.priority)).toEqual([3, 2, 1]);

                    await db.close();
                });

                it('paginates with offset() and limit()', async () => {
                    const db = await createDb();
                    const table = db.table('todos');

                    await table.bulkAdd([
                        createTodo({ title: 'Item 1', priority: 1 }),
                        createTodo({ title: 'Item 2', priority: 2 }),
                        createTodo({ title: 'Item 3', priority: 3 }),
                        createTodo({ title: 'Item 4', priority: 4 }),
                        createTodo({ title: 'Item 5', priority: 5 }),
                    ]);

                    // Page 1: items 1-2
                    const page1 = await table.orderBy('priority').limit(2).toArray();
                    expect(page1.map((t) => t.priority)).toEqual([1, 2]);

                    // Page 2: items 3-4
                    const page2 = await table.orderBy('priority').offset(2).limit(2).toArray();
                    expect(page2.map((t) => t.priority)).toEqual([3, 4]);

                    // Page 3: item 5
                    const page3 = await table.orderBy('priority').offset(4).limit(2).toArray();
                    expect(page3.map((t) => t.priority)).toEqual([5]);

                    await db.close();
                });

                it('sorts results with sortBy()', async () => {
                    const db = await createDb();
                    const table = db.table('todos');

                    await table.bulkAdd([createTodo({ title: 'Zebra' }), createTodo({ title: 'Apple' }), createTodo({ title: 'Mango' })]);

                    // Use orderBy for native sorting, or toArray() then sort in JS
                    const sorted = await table.orderBy('title').toArray();
                    expect(sorted.map((t) => t.title)).toEqual(['Apple', 'Mango', 'Zebra']);

                    await db.close();
                });
            });

            // ================================================================
            // Filtering
            // ================================================================

            describe('Filtering', () => {
                it('filters with a predicate function on collection', async () => {
                    const db = await createDb();
                    const table = db.table('todos');

                    await table.bulkAdd([
                        createTodo({ title: 'Short' }),
                        createTodo({ title: 'A much longer title here' }),
                        createTodo({ title: 'Medium length' }),
                    ]);

                    // Use table.jsFilter() for predicate-based filtering
                    const longTitles = await table.jsFilter((todo) => todo.title.length > 10).toArray();
                    expect(longTitles).toHaveLength(2);

                    await db.close();
                });

                it('chains filter with where clause using jsFilter()', async () => {
                    const db = await createDb();
                    const table = db.table('todos');

                    await table.bulkAdd([
                        createTodo({ title: 'Buy milk', category: 'shopping', priority: 1 }),
                        createTodo({ title: 'Buy car', category: 'shopping', priority: 3 }),
                        createTodo({ title: 'Call mom', category: 'personal', priority: 1 }),
                    ]);

                    const filtered = await table
                        .where('category')
                        .equals('shopping')
                        .jsFilter((todo) => todo.priority > 1)
                        .toArray();

                    expect(filtered).toHaveLength(1);
                    expect(filtered[0]!.title).toBe('Buy car');

                    await db.close();
                });

                it('gets distinct records', async () => {
                    const db = await createDb();
                    const table = db.table('todos');

                    // Add duplicates (same data, different _localId)
                    await table.bulkAdd([
                        createTodo({ title: 'Duplicate', category: 'work' }),
                        createTodo({ title: 'Duplicate', category: 'work' }),
                        createTodo({ title: 'Unique', category: 'home' }),
                    ]);

                    // Note: distinct() works on the full record, so same title+category still unique due to _localId
                    const all = await table.where('category').equals('work').toArray();
                    expect(all).toHaveLength(2);

                    await db.close();
                });
            });

            // ================================================================
            // Modify and Delete via Collection
            // ================================================================

            describe('Collection Modifications', () => {
                it('modifies matching records with modify()', async () => {
                    const db = await createDb();
                    const table = db.table('todos');

                    await table.bulkAdd([
                        createTodo({ title: 'Task 1', priority: 1 }),
                        createTodo({ title: 'Task 2', priority: 2 }),
                        createTodo({ title: 'Task 3', priority: 3 }),
                    ]);

                    // Modify tasks with priority <= 2
                    const count = await table.where('priority').belowOrEqual(2).modify({ category: 'modified' });
                    expect(count).toBe(2);

                    const modifiedTasks = await table.where('category').equals('modified').toArray();
                    expect(modifiedTasks).toHaveLength(2);

                    await db.close();
                });

                it('modifies records with a function', async () => {
                    const db = await createDb();
                    const table = db.table('todos');

                    await table.bulkAdd([createTodo({ title: 'low', priority: 1 }), createTodo({ title: 'high', priority: 5 })]);

                    await table
                        .where('priority')
                        .above(3)
                        .modify((todo) => {
                            todo.title = todo.title.toUpperCase();
                        });

                    const high = await table.where('priority').equals(5).first();
                    expect(high?.title).toBe('HIGH');

                    const low = await table.where('priority').equals(1).first();
                    expect(low?.title).toBe('low');

                    await db.close();
                });

                it('deletes matching records with delete()', async () => {
                    const db = await createDb();
                    const table = db.table('todos');

                    await table.bulkAdd([
                        createTodo({ title: 'Keep', priority: 1 }),
                        createTodo({ title: 'Delete 1', priority: 5 }),
                        createTodo({ title: 'Delete 2', priority: 5 }),
                    ]);

                    // Delete high priority tasks (priority == 5)
                    const deleted = await table.where('priority').equals(5).delete();
                    expect(deleted).toBe(2);

                    const remaining = await table.toArray();
                    expect(remaining).toHaveLength(1);
                    expect(remaining[0]!.title).toBe('Keep');

                    await db.close();
                });
            });

            // ================================================================
            // Real-World Scenarios
            // ================================================================

            describe('Real-World Scenarios', () => {
                it('implements a todo list with filtering and sorting', async () => {
                    const db = await createDb();
                    const table = db.table('todos');

                    // Seed data - ensure different priorities for predictable sorting
                    await table.bulkAdd([
                        createTodo({ title: 'Buy groceries', category: 'shopping', priority: 3, completed: false }),
                        createTodo({ title: 'Finish report', category: 'work', priority: 1, completed: false }),
                        createTodo({ title: 'Call dentist', category: 'health', priority: 4, completed: true }),
                        createTodo({ title: 'Review PR', category: 'work', priority: 2, completed: false }),
                        createTodo({ title: 'Exercise', category: 'health', priority: 5, completed: false }),
                    ]);

                    // Get incomplete work tasks, ordered by priority
                    const workTasks = await table
                        .where('category')
                        .equals('work')
                        .jsFilter((t) => !t.completed)
                        .sortBy('priority');

                    expect(workTasks).toHaveLength(2);
                    // Priority 1 should come first
                    expect(workTasks[0]!.title).toBe('Finish report');
                    expect(workTasks[1]!.title).toBe('Review PR');

                    // Count incomplete tasks using jsFilter
                    const incompleteCount = await table.jsFilter((t) => !t.completed).count();
                    expect(incompleteCount).toBe(4);

                    // Get priority <= 3 incomplete tasks
                    const urgent = await table
                        .where('priority')
                        .belowOrEqual(3)
                        .jsFilter((t) => !t.completed)
                        .toArray();
                    expect(urgent).toHaveLength(3); // Finish report (1), Review PR (2), Buy groceries (3)

                    await db.close();
                });

                it('implements user search with pagination', async () => {
                    const db = await createDb();
                    const table = db.table('users');

                    // Seed 20 users
                    const users = Array.from({ length: 20 }, (_, i) =>
                        createUser({
                            name: `User ${String(i + 1).padStart(2, '0')}`,
                            email: `user${i + 1}@example.com`,
                            age: 20 + i,
                            role: i % 3 === 0 ? 'admin' : 'user',
                            active: i % 4 !== 0,
                        }),
                    );
                    await table.bulkAdd(users);

                    // For boolean filtering, use jsFilter and get all results
                    const activeUsers = await table.jsFilter((u) => u.active).toArray();

                    // Paginate the filtered results in JS
                    const pageSize = 5;
                    const page1 = activeUsers.slice(0, pageSize);
                    expect(page1).toHaveLength(5);

                    const page2 = activeUsers.slice(pageSize, pageSize * 2);
                    expect(page2).toHaveLength(5);

                    // Get total count for pagination UI
                    const totalActive = await table.jsFilter((u) => u.active).count();
                    expect(totalActive).toBe(15); // 20 - 5 inactive (every 4th)

                    // Filter admins - string fields work with where
                    const admins = await table.where('role').equals('admin').toArray();
                    expect(admins).toHaveLength(7); // 0, 3, 6, 9, 12, 15, 18

                    await db.close();
                });

                it('implements a tag-based search', async () => {
                    const db = await createDb();
                    const table = db.table('todos');

                    await table.bulkAdd([
                        createTodo({ title: 'Deploy app', tags: 'work,urgent,dev' }),
                        createTodo({ title: 'Fix bug', tags: 'work,dev' }),
                        createTodo({ title: 'Write docs', tags: 'work' }),
                        createTodo({ title: 'Buy food', tags: 'personal,shopping' }),
                    ]);

                    // Find all dev-related tasks (tags contain 'dev') using jsFilter
                    const devTasks = await table.jsFilter((todo) => todo.tags.includes('dev')).toArray();
                    expect(devTasks).toHaveLength(2);

                    // Find urgent tasks
                    const urgentTasks = await table.jsFilter((todo) => todo.tags.includes('urgent')).toArray();
                    expect(urgentTasks).toHaveLength(1);
                    expect(urgentTasks[0]!.title).toBe('Deploy app');

                    await db.close();
                });

                it('implements date-based queries', async () => {
                    const db = await createDb();
                    const table = db.table('todos');

                    const today = '2026-01-11';
                    const tomorrow = '2026-01-12';
                    const nextWeek = '2026-01-18';

                    await table.bulkAdd([
                        createTodo({ title: 'Due today', dueDate: today }),
                        createTodo({ title: 'Due tomorrow', dueDate: tomorrow }),
                        createTodo({ title: 'Due next week', dueDate: nextWeek }),
                        createTodo({ title: 'No due date', dueDate: null }),
                    ]);

                    // Use jsFilter for complex date logic
                    // Tasks due today or earlier
                    const overdue = await table.jsFilter((todo) => todo.dueDate !== null && todo.dueDate <= today).toArray();
                    expect(overdue).toHaveLength(1);

                    // Tasks due this week
                    const thisWeek = await table.jsFilter((todo) => todo.dueDate !== null && todo.dueDate >= today && todo.dueDate < nextWeek).toArray();
                    expect(thisWeek).toHaveLength(2);

                    // Tasks without due date
                    const noDueDate = await table.jsFilter((todo) => todo.dueDate === null).toArray();
                    expect(noDueDate).toHaveLength(1);

                    await db.close();
                });

                it('combines multiple where conditions for complex queries', async () => {
                    const db = await createDb();
                    const table = db.table('users');

                    await table.bulkAdd([
                        createUser({ name: 'Alice', age: 25, role: 'admin', active: true }),
                        createUser({ name: 'Bob', age: 30, role: 'user', active: true }),
                        createUser({ name: 'Charlie', age: 35, role: 'admin', active: false }),
                        createUser({ name: 'Diana', age: 28, role: 'user', active: true }),
                        createUser({ name: 'Eve', age: 45, role: 'admin', active: true }),
                    ]);

                    // Active admins over 30
                    const seniorActiveAdmins = await table
                        .where('role')
                        .equals('admin')
                        .jsFilter((u) => u.active && u.age > 30)
                        .toArray();

                    expect(seniorActiveAdmins).toHaveLength(1);
                    expect(seniorActiveAdmins[0]!.name).toBe('Eve');

                    // Young active users (under 30)
                    const youngActiveUsers = await table
                        .where('age')
                        .below(30)
                        .jsFilter((u) => u.active)
                        .toArray();

                    expect(youngActiveUsers).toHaveLength(2);
                    expect(youngActiveUsers.map((u) => u.name).sort()).toEqual(['Alice', 'Diana']);

                    await db.close();
                });
            });

            // ================================================================
            // Cross-Table Queries (Manual Joins)
            // ================================================================

            describe('Cross-Table Queries (Manual Joins)', () => {
                it('fetches related records using foreign keys', async () => {
                    const db = await createDb();
                    const todosTable = db.table('todos');
                    const usersTable = db.table('users');

                    // Create users first
                    const alice = createUser({ name: 'Alice', email: 'alice@example.com' });
                    const bob = createUser({ name: 'Bob', email: 'bob@example.com' });
                    await usersTable.bulkAdd([alice, bob]);

                    // Create todos assigned to users
                    await todosTable.bulkAdd([
                        createTodo({ title: 'Alice Task 1', assignedTo: alice._localId }),
                        createTodo({ title: 'Alice Task 2', assignedTo: alice._localId }),
                        createTodo({ title: 'Bob Task', assignedTo: bob._localId }),
                    ]);

                    // Get all todos for Alice
                    const aliceTodos = await todosTable.where('assignedTo').equals(alice._localId).toArray();
                    expect(aliceTodos).toHaveLength(2);
                    expect(aliceTodos.every((t) => t.assignedTo === alice._localId)).toBe(true);

                    // Get the user for a specific todo
                    const bobTask = await todosTable.where('title').equals('Bob Task').first();
                    const bobUser = await usersTable.get(bobTask!.assignedTo!);
                    expect(bobUser?.name).toBe('Bob');

                    await db.close();
                });

                it('builds joined results with Promise.all', async () => {
                    const db = await createDb();
                    const todosTable = db.table('todos');
                    const usersTable = db.table('users');

                    // Create users
                    const users = [createUser({ name: 'Alice', role: 'admin' }), createUser({ name: 'Bob', role: 'user' })];
                    await usersTable.bulkAdd(users);

                    // Create todos assigned to users
                    await todosTable.bulkAdd([
                        createTodo({ title: 'Task 1', priority: 1, assignedTo: users[0]!._localId }),
                        createTodo({ title: 'Task 2', priority: 2, assignedTo: users[1]!._localId }),
                        createTodo({ title: 'Task 3', priority: 3, assignedTo: users[0]!._localId }),
                    ]);

                    // Get all todos with their assigned user (manual join)
                    const todos = await todosTable.toArray();
                    const todosWithUsers = await Promise.all(
                        todos.map(async (todo) => ({
                            ...todo,
                            assignee: todo.assignedTo ? await usersTable.get(todo.assignedTo) : null,
                        })),
                    );

                    expect(todosWithUsers).toHaveLength(3);
                    expect(todosWithUsers.find((t) => t.title === 'Task 1')?.assignee?.name).toBe('Alice');
                    expect(todosWithUsers.find((t) => t.title === 'Task 2')?.assignee?.name).toBe('Bob');

                    await db.close();
                });

                it('efficiently fetches related records with bulkGet', async () => {
                    const db = await createDb();
                    const todosTable = db.table('todos');
                    const usersTable = db.table('users');

                    // Create users
                    const users = [createUser({ name: 'Alice' }), createUser({ name: 'Bob' }), createUser({ name: 'Charlie' })];
                    await usersTable.bulkAdd(users);

                    // Create many todos
                    const todos = [
                        createTodo({ title: 'T1', assignedTo: users[0]!._localId }),
                        createTodo({ title: 'T2', assignedTo: users[1]!._localId }),
                        createTodo({ title: 'T3', assignedTo: users[0]!._localId }),
                        createTodo({ title: 'T4', assignedTo: users[2]!._localId }),
                        createTodo({ title: 'T5', assignedTo: users[1]!._localId }),
                    ];
                    await todosTable.bulkAdd(todos);

                    // Fetch todos
                    const allTodos = await todosTable.toArray();

                    // Get unique user IDs and bulk fetch users (more efficient than individual gets)
                    const userIds = [...new Set(allTodos.map((t) => t.assignedTo).filter(Boolean))] as string[];
                    const relatedUsers = await usersTable.bulkGet(userIds);

                    // Create a map for O(1) lookup
                    const userMap = new Map(relatedUsers.filter(Boolean).map((u) => [u!._localId, u]));

                    // Join the data
                    const joined = allTodos.map((todo) => ({
                        ...todo,
                        assignee: todo.assignedTo ? userMap.get(todo.assignedTo) : null,
                    }));

                    expect(joined).toHaveLength(5);
                    expect(joined.filter((t) => t.assignee?.name === 'Alice')).toHaveLength(2);
                    expect(joined.filter((t) => t.assignee?.name === 'Bob')).toHaveLength(2);
                    expect(joined.filter((t) => t.assignee?.name === 'Charlie')).toHaveLength(1);

                    await db.close();
                });

                it('finds all users with their todo counts', async () => {
                    const db = await createDb();
                    const todosTable = db.table('todos');
                    const usersTable = db.table('users');

                    // Create users
                    const users = [createUser({ name: 'Alice' }), createUser({ name: 'Bob' }), createUser({ name: 'Charlie' })];
                    await usersTable.bulkAdd(users);

                    // Create todos with varying assignments
                    await todosTable.bulkAdd([
                        createTodo({ title: 'T1', assignedTo: users[0]!._localId }),
                        createTodo({ title: 'T2', assignedTo: users[0]!._localId }),
                        createTodo({ title: 'T3', assignedTo: users[0]!._localId }),
                        createTodo({ title: 'T4', assignedTo: users[1]!._localId }),
                    ]);

                    // Get all users with their todo counts
                    const allUsers = await usersTable.toArray();
                    const usersWithCounts = await Promise.all(
                        allUsers.map(async (user) => ({
                            ...user,
                            todoCount: await todosTable.where('assignedTo').equals(user._localId).count(),
                        })),
                    );

                    expect(usersWithCounts.find((u) => u.name === 'Alice')?.todoCount).toBe(3);
                    expect(usersWithCounts.find((u) => u.name === 'Bob')?.todoCount).toBe(1);
                    expect(usersWithCounts.find((u) => u.name === 'Charlie')?.todoCount).toBe(0);

                    await db.close();
                });

                it('filters parent records based on child conditions', async () => {
                    const db = await createDb();
                    const todosTable = db.table('todos');
                    const usersTable = db.table('users');

                    // Create users
                    const users = [
                        createUser({ name: 'Alice', role: 'admin' }),
                        createUser({ name: 'Bob', role: 'user' }),
                        createUser({ name: 'Charlie', role: 'user' }),
                    ];
                    await usersTable.bulkAdd(users);

                    // Create todos - Alice has high priority, Bob has low, Charlie has none
                    await todosTable.bulkAdd([
                        createTodo({ title: 'Urgent', priority: 5, assignedTo: users[0]!._localId }),
                        createTodo({ title: 'Normal', priority: 2, assignedTo: users[1]!._localId }),
                    ]);

                    // Find users who have at least one high-priority (>= 4) todo
                    const highPriorityTodos = await todosTable.where('priority').aboveOrEqual(4).toArray();
                    const usersWithHighPriority = [...new Set(highPriorityTodos.map((t) => t.assignedTo).filter(Boolean))];
                    const busyUsers = await usersTable.bulkGet(usersWithHighPriority as string[]);

                    expect(busyUsers).toHaveLength(1);
                    expect(busyUsers[0]?.name).toBe('Alice');

                    await db.close();
                });

                it('implements a one-to-many relationship query', async () => {
                    const db = await createDb();
                    const todosTable = db.table('todos');
                    const usersTable = db.table('users');

                    // Create a user with multiple todos
                    const alice = createUser({ name: 'Alice', email: 'alice@example.com' });
                    await usersTable.add(alice);

                    await todosTable.bulkAdd([
                        createTodo({ title: 'Morning standup', category: 'work', assignedTo: alice._localId }),
                        createTodo({ title: 'Code review', category: 'work', assignedTo: alice._localId }),
                        createTodo({ title: 'Lunch break', category: 'personal', assignedTo: alice._localId }),
                    ]);

                    // Get user with all their todos grouped by category
                    const user = await usersTable.where('name').equals('Alice').first();
                    const userTodos = await todosTable.where('assignedTo').equals(user!._localId).toArray();

                    const todosByCategory = userTodos.reduce(
                        (acc, todo) => {
                            if (!acc[todo.category]) acc[todo.category] = [];
                            acc[todo.category]!.push(todo);
                            return acc;
                        },
                        {} as Record<string, Todo[]>,
                    );

                    expect(todosByCategory['work']).toHaveLength(2);
                    expect(todosByCategory['personal']).toHaveLength(1);

                    await db.close();
                });

                it('finds orphaned records (todos without valid user)', async () => {
                    const db = await createDb();
                    const todosTable = db.table('todos');
                    const usersTable = db.table('users');

                    // Create a user
                    const alice = createUser({ name: 'Alice' });
                    await usersTable.add(alice);

                    // Create todos - some assigned, some with invalid/deleted user reference
                    await todosTable.bulkAdd([
                        createTodo({ title: 'Valid', assignedTo: alice._localId }),
                        createTodo({ title: 'Orphaned 1', assignedTo: 'deleted-user-id' }),
                        createTodo({ title: 'Orphaned 2', assignedTo: 'another-deleted-id' }),
                        createTodo({ title: 'Unassigned', assignedTo: null }),
                    ]);

                    // Find orphaned todos (assigned to non-existent users)
                    const assignedTodos = await todosTable.jsFilter((t) => t.assignedTo !== null).toArray();
                    const userIds = [...new Set(assignedTodos.map((t) => t.assignedTo))] as string[];
                    const existingUsers = await usersTable.bulkGet(userIds);

                    const validUserIds = new Set(existingUsers.filter(Boolean).map((u) => u!._localId));
                    const orphanedTodos = assignedTodos.filter((t) => !validUserIds.has(t.assignedTo!));

                    expect(orphanedTodos).toHaveLength(2);
                    expect(orphanedTodos.map((t) => t.title).sort()).toEqual(['Orphaned 1', 'Orphaned 2']);

                    await db.close();
                });
            });

            // ================================================================
            // Native SQL Features
            // ================================================================

            describe('Native SQL Features', () => {
                it('uses native SQL DISTINCT', async () => {
                    const db = await createDb();
                    const table = db.table('todos');

                    // Add some duplicate categories
                    await table.bulkAdd([
                        createTodo({ title: 'Task 1', category: 'work', priority: 1 }),
                        createTodo({ title: 'Task 2', category: 'work', priority: 2 }),
                        createTodo({ title: 'Task 3', category: 'personal', priority: 1 }),
                    ]);

                    // Distinct should work with count
                    const allCount = await table.count();
                    expect(allCount).toBe(3);

                    // distinct() followed by other operations
                    const workTasks = await table.where('category').equals('work').distinct().toArray();
                    expect(workTasks).toHaveLength(2);

                    await db.close();
                });

                it('uses native SQL ORDER BY in sortBy()', async () => {
                    const db = await createDb();
                    const table = db.table('todos');

                    await table.bulkAdd([
                        createTodo({ title: 'Zebra', priority: 3 }),
                        createTodo({ title: 'Apple', priority: 1 }),
                        createTodo({ title: 'Mango', priority: 2 }),
                    ]);

                    // sortBy on a where clause result
                    const allTodos = await table.where('priority').above(0).sortBy('title');
                    expect(allTodos.map((t) => t.title)).toEqual(['Apple', 'Mango', 'Zebra']);

                    const byPriority = await table.where('priority').above(0).sortBy('priority');
                    expect(byPriority.map((t) => t.priority)).toEqual([1, 2, 3]);

                    await db.close();
                });
            });
        });
    }
});
