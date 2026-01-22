import 'fake-indexeddb/auto';
import { afterEach } from 'vitest';

afterEach(async () => {
    try {
        const names = (await indexedDB.databases()).map((d) => d.name).filter(Boolean) as string[];
        for (const name of names) {
            console.log(`Deleting test IndexedDB database: ${name}`);
            // deleteDatabase returns an IDBOpenDBRequest in some polyfills — wrap in a Promise
            await new Promise<void>((res, rej) => {
                try {
                    const req = indexedDB.deleteDatabase(name);
                    req.onsuccess = () => res();
                    req.onblocked = () => res();
                    req.onerror = () => res();
                } catch (_e) {
                    // ignore and continue
                    rej();
                }
            });
        }
    } catch (e) {
        console.error('Failed to delete test IndexedDB database', e);
        if (typeof process?.exit === 'function') {
            process.exit(1);
        } else {
            // Fallback: rethrow to fail the current test
            throw e;
        }
    }
});
