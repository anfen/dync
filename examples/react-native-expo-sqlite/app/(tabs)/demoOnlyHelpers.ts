import type { Todo, ServerTodo } from '@examples/shared';

export async function wait(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}

export async function waitUntil(predicate: () => boolean, timeout = 800, step = 20) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        if (predicate()) return;

        await wait(step);
    }
}

export async function seedBackendMock(db: { todos: { toArray: () => Promise<Todo[]> } }, backend: { seed: (todos: ServerTodo[]) => void }) {
    const existingTodos = await db.todos.toArray();
    const syncedTodos = existingTodos.filter((t): t is Todo & { id: number } => t.id != null);
    backend.seed(syncedTodos);
}
