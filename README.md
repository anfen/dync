## Dync

[![npm version](https://img.shields.io/npm/v/@anfenn/dync.svg)](https://www.npmjs.com/package/@anfenn/dync)

A complete React offline-first data layer with sync engine for any local storage (IndexedDB, Sqlite, etc.), and any backend (Restful, GraphQL, Supabase, etc.) in a Website, PWA, CapacitorJs, React Native, or Electron app.

Start with a Website or PWA using IndexedDB, sync with your existing REST API, and later ship native apps with encrypted SQLite - without changing a line of code.

## Why Dync?

1. Target IndexedDB as a PWA, and SQLite in the AppStores, with no code changes and native storage performance
2. Frictionless upgrade path from an offline-first PWA targeting IndexedDB, to when:

    **A) Substring search is required on many records** (IndexedDB doesn't support this so will do a full table scan in the JS VM, which is both slow and will spike memory)

    **_and/or_**

    **B) Encryption is required** (Browsers can't store the encryption key securely)

    ... you can simply add CapacitorJs or move to React Native which have sqlite & secure enclave storage, and only change the adapter Dync uses

3. Completely free and open source

<br>See first-hand in this fully working example: [examples/react-capacitor](examples/react-capacitor)

And see how Dync compares to the alternatives [below](#hasnt-this-already-been-done).

## Goals

- Persist SQL or NoSQL data locally and sync some or all tables to a backend
- Storage agnostic. Comes with `Memory`, `IndexedDB` and `Sqlite` adapters (for CapacitorJs & React Native), and extendable with your own custom adapters
- Lazy loaded data keeps it in native storage, allowing low memory and fast app response, even with >100K records
- Fast React Native Sqlite access via JSI
- Single collection based api for both SQLite & IndexedDB, plus query() escape hatch for native storage api e.g.:
    - `db.myTable.add()` | `.update()` | `.where('myField').equals(42).first()`
    - `db.query()` is only intended to retrieve records, any mutations will be ignored by the sync engine:
        ```js
        db.query(async (ctx) => {
            if (ctx instanceof DexieQueryContext) {
                return await ctx.table('items').where('value').startsWithIgnoreCase('dexie').toArray();
            } else if (ctx instanceof SqliteQueryContext) {
                return await ctx.queryRows('SELECT * FROM items WHERE value LIKE ? COLLATE NOCASE', ['sqlite%']);
            }
        });
        ```

- Sync some or all tables with any backend in 2 ways:
    - Option 1: Map remote api CRUD urls to a local collection:

        ```ts
        const db = makeDync(
            ...,
            {
                // Only add an entry here for tables that should be synced
                // Pseudocode here, see examples for working code
                items: {
                    add: (item) => fetch('/api/items'),
                    update: (id, changes) => fetch(`/api/items/${id}`),
                    remove: (id) => fetch(`/api/items/${id}`),
                    list: (since) => fetch(`/api/items?since=${since}`),
                },
            },
        );
        ```

    - Option 2: Batch sync to remote /push & /pull endpoints:

        ```ts
        const db = makeDync(
            ...,
            {
                syncTables: ['items'], // Only add tables to this array that should be synced
                push: async (changes) => {
                    const res = await fetch('/api/sync/push', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(changes),
                    });
                    return res.json();
                },
                pull: async (since) => {
                    const params = new URLSearchParams(
                        Object.entries(since).map(([table, date]) => [table, date.toISOString()])
                    );
                    const res = await fetch(`/api/sync/pull?${params}`);
                    return res.json();
                },
            },
        );
        ```

        See [examples/shared/api.ts](examples/shared/api.ts) for a fully documented example of these two options.

- Full conflict resolution: `local-wins`, `remote-wins` or with `try-shallow-merge` the user can resolve with:

    ```ts
    const { syncState, db } = useDync();
    syncState.conflicts; // Record<localId, Conflict>
    db.sync.resolveConflict(localId, true);
    ```

- Optimistic UI updates
- Offline detection: `syncState.apiError.isNetworkError`
- Optional first load data download before periodic sync is enabled
- Missing remote record on update strategy: `ignore` | `delete-local-record` | `insert-remote-record`
- Reactive updates when data changes via `useLiveQuery()` React hook:

    ```ts
    useLiveQuery(
        async (db) => {
            const items = await db.items.toArray(); // toArray() executes the query
            setTodos(items);
        },
        [], // Re-run when variables change
        ['items'], // Re-run when tables change
    );
    ```

- Sqlite schema migration
- "It just works" philosophy
- Modern and always free (MIT)

## Non-Goals

- Full IndexedDB & SQL unified query language:
    - Using IndexedDB functions or raw SQL will always be more expressive independently
    - No need to learn another api when you might only need one storage type
    - Would greatly increase complexity of this library

## Hasn't this already been done?

Many times, with varying degrees of functionality, compatibility, and cost.

Dync aims to be a performant, multi-platform, modern and always free alternative.

This is how Dync compares to other multi-platform sync engines:

**_Legend:_**

- _**SQLite:** Used natively by an installed Capacitor, React Native, Electron or Node app_
- _**WA-SQLite:** Official SQLite compiled to WebAssembly that runs in the browser. Persists to IndexedDB or OPFS depending on VFS configuration (see [SQLite vs WA-SQLite](#sqlite-vs-wa-sqlite))_

| Library                                                               | Installed Components | IndexedDB | SQLite     | WA-SQLite  | Any Backend              | CRUD Sync | Batch Sync | Conflict Resolution | Platforms                            | Notes                                                                                                                                  |
| --------------------------------------------------------------------- | -------------------- | --------- | ---------- | ---------- | ------------------------ | --------- | ---------- | ------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| [**Dync**](https://github.com/anfen/dync)                             | Client               | ✅        | ✅ Free    | ✅ Free    | ✅                       | ✅        | ✅         | ✅                  | Web, Capacitor, RN, Electron, Node   |                                                                                                                                        |
| [**RxDB**](https://github.com/pubkey/rxdb)                            | Client               | ✅        | 💰 Premium | 💰 Premium | ✅                       | ❌        | ✅         | ✅                  | Web, Capacitor, RN, Electron, Node   |                                                                                                                                        |
| [**WatermelonDB**](https://github.com/Nozbe/WatermelonDB)             | Client               | ✅        | ✅ Free    | ❌         | ✅                       | ❌        | ✅         | ❌                  | Web, RN, Node                        | ⚠️ Not Vite compatible<br>⚠️ Uses legacy JS proposals                                                                                  |
| [**Legend State**](https://github.com/LegendApp/legend-state)         | Client               | ✅        | ✅ Free    | ❌         | ✅                       | ✅        | ❌         | ❌                  | Web, RN                              | ⚠️ [Data loss bugs as of 01/01/2026](https://github.com/LegendApp/legend-state/issues/547)<br>⚠️ Confusing observables based React api |
| [**SignalDB**](https://github.com/maxnowack/signaldb)                 | Client               | ✅        | ❌         | ❌         | ✅                       | ❌        | ✅         | ❌                  | Web                                  |                                                                                                                                        |
| [**TanStack DB**](https://github.com/TanStack/db)                     | Client               | ❌        | ❌         | ❌         | ✅                       | ✅        | ❌         | ❌                  | Web, RN                              | In-memory only<br>Integrates with RxDB/PowerSync/Electric for persistence                                                              |
| [**Dexie.js**](https://github.com/dexie/Dexie.js)                     | Client               | ✅        | ❌         | ❌         | ❌ Dexie cloud only      | ❌        | ✅         | ❌                  | Web, Capacitor, RN, Electron         |                                                                                                                                        |
| [**PouchDB**](https://github.com/pouchdb/pouchdb)                     | Client               | ✅        | ❌         | ❌         | ❌ CouchDB only          | ❌        | ✅         | ✅                  | Web, Electron, Node                  |                                                                                                                                        |
| [**TinyBase**](https://github.com/tinyplex/tinybase)                  | Client               | ✅        | ✅ Free    | ✅ Free    | ❌ Client-to-client only | ❌        | ✅         | ✅                  | Web, RN, Electron, Node              |                                                                                                                                        |
| [**ElectricSQL**](https://github.com/electric-sql/electric)           | Client & Server      | ❌        | ✅ Free    | ✅ Free    | ❌ Postgres only         | ❌        | ✅         | ✅                  | Web, RN, Electron, Node              |                                                                                                                                        |
| [**PowerSync**](https://github.com/powersync-ja/powersync-js)         | Client & Server      | ❌        | ✅ Free    | ✅ Free    | ❌ PowerSync server only | ❌        | ✅         | ✅                  | Web, Capacitor, RN, Electron, Node   |                                                                                                                                        |
| [**InstantDB**](https://github.com/instantdb/instant)                 | Client               | ✅        | ❌         | ❌         | ❌ InstantDB cloud only  | ❌        | ✅         | ✅                  | Web, RN                              |                                                                                                                                        |
| [**Firebase/Firestore**](https://github.com/firebase/firebase-js-sdk) | Client               | ✅        | ❌         | ❌         | ❌ Firebase cloud only   | ❌        | ✅         | ✅                  | Web, iOS, Android, RN, Flutter, Node |                                                                                                                                        |

## Examples

Both are fully commented and can be run in the browser and natively on iOS/Android without code change:

1. **React + Capacitor**: [examples/react-capacitor](examples/react-capacitor) - IndexedDB in the browser, SQLite natively
2. **React Native + Expo SQLite**: [examples/react-native-expo-sqlite](examples/react-native-expo-sqlite) - WA-SQLite in the browser, SQLite natively

## Design

### Server Requirements

Your server records **must** have these fields. If it does but they're named differently, rename them in your client's [api.ts](examples/shared/api.ts) using the included `changeKeysFrom()` & `changeKeysTo()` helpers:

| Field        | Description                                                                                                                                                                                                                                                            |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`         | Unique identifier (any datatype). Can be assigned by client or server.                                                                                                                                                                                                 |
| `updated_at` | Server-assigned **millisecond** timestamp (e.g. via db trigger or API layer). The client never sends this as client clocks are unreliable. Ensure precision doesn't exceed milliseconds (like PostgreSQL's microsecond timestamptz), otherwise updates may be ignored. |
| `deleted`    | Boolean for soft deletes. Allows other clients to sync deletions to their local store.                                                                                                                                                                                 |

### Client Records

Dync auto-injects these fields into your local table schema:

| Field        | Description                                                                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `_localId`   | Stable local identifier, never sent to the server. Ideal for React keys. Auto-generated UUID, but can be set manually with any unique value. |
| `id`         | Unique identifier (any datatype). Can be assigned by client or server.                                                                       |
| `updated_at` | Assigned from the server's `updated_at` after sync. You may set it optimistically, but it's always overwritten on sync.                      |

Note: `deleted` doesn't exist on the client, as it's removed during sync.

## SQLite vs WA-SQLite

**SQLite** runs natively in Capacitor, React Native, Electron, and Node apps via platform-specific drivers.

**WA-SQLite** is SQLite compiled to WebAssembly, enabling SQL in the browser. It persists data to IndexedDB or OPFS depending on the Virtual File System (VFS) you choose.

### When to use WA-SQLite

- You need SQL queries in a web app (full-text search, complex joins, etc.)
- Your dataset is too large for efficient IndexedDB queries
- You want the same SQLite schema across web and native apps
- You don't need encryption, as browsers can't securely store the encryption key
- You're happy for a larger runtime memory footprint

### WA-SQLite VFS Options

Choose a VFS based on your app's requirements. See [`WaSqliteDriverOptions`](src/storage/sqlite/drivers/WaSqliteDriver.ts) for configuration.

| VFS                     | Context | Multi-Tab | Durability | Performance | Best For                              |
| ----------------------- | ------- | --------- | ---------- | ----------- | ------------------------------------- |
| **IDBBatchAtomicVFS**   | Any     | ✅        | ✅ Full    | Good        | General use, maximum compatibility    |
| **IDBMirrorVFS**        | Any     | ✅        | ⚠️ Async   | Fast        | Small databases, performance critical |
| **OPFSCoopSyncVFS**     | Worker  | ✅        | ✅ Full    | Good        | Multi-tab apps needing OPFS           |
| **AccessHandlePoolVFS** | Worker  | ❌        | ✅ Full    | Best        | Single-tab apps, maximum performance  |

**Notes:**

- **IDBBatchAtomicVFS** (default) is recommended for most apps - works in main thread and has full durability
- **IDBMirrorVFS** keeps data in memory and mirrors to IndexedDB asynchronously - fast but may lose recent writes on crash
- **OPFS VFS types** require a Web Worker context and are not supported on Safari/iOS

```ts
import { WaSqliteDriver, SQLiteAdapter } from '@anfenn/dync/wa-sqlite';

const driver = new WaSqliteDriver('mydb', {
    vfs: 'IDBBatchAtomicVFS', // or 'IDBMirrorVFS', 'OPFSCoopSyncVFS', 'AccessHandlePoolVFS'
});
const adapter = new SQLiteAdapter(driver);
```

## Community

PRs are welcome! [pnpm](https://pnpm.io) is used as a package manager. Run `pnpm install` to install local dependencies. Thank you for contributing!
