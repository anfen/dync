# React + Capacitor + Dync

A complete example demonstrating **Dync** with platform-adaptive storage:

- **Browser**: IndexedDB via DexieAdapter
- **Native iOS/Android**: SQLite via CapacitorSQLiteDriver (with optional encryption)

## Quick Start (Browser)

```bash
pnpm install
pnpm dev
```

Open [http://localhost:5173](http://localhost:5173) to run in the browser with IndexedDB.

## Running on Device/Simulator

```bash
pnpm install
pnpm cap:sync
pnpm exec cap run ios  # or: cap run android

# or for web:
pnpm dev
```

## What's Inside

The entire example is in a single file: **[src/App.tsx](src/App.tsx)**.

This includes:

- Type definitions for your data model
- Mock backend with Axios adapter (replace with your real API)
- Platform-adaptive storage (DexieAdapter for browser, SQLiteAdapter for native)
- React component with CRUD operations
- Sync status indicator

## Key Dync Integration Points

```tsx
import { Capacitor } from '@capacitor/core';

// 1. Create storage adapter based on platform
const storageAdapter = Capacitor.isNativePlatform()
    ? new SQLiteAdapter(
          new CapacitorSQLiteDriver(DATABASE_NAME, {
              encrypted: true,
              mode: 'secret',
              getEncryptionKey: () => 'your-encryption-key',
          }),
      )
    : new DexieAdapter(DATABASE_NAME);

// 2. Define schema based on adapter type
const schema = Capacitor.isNativePlatform() ? { todos: { columns: { title: { type: 'TEXT' }, completed: { type: 'BOOLEAN' } } } } : { todos: 'title' }; // This Dexie schema (NoSQL) justs lists indexes

const { db, useDync } = makeDync<Store>({
    databaseName: DATABASE_NAME,
    storageAdapter,
    syncApis: { todos: createSyncApi(api) },
});

db.version(1).stores(schema);

// 3. Use in components (same API everywhere!)
const { db, syncState } = useDync();
```

## Learn More

- [Dync Documentation](../../README.md)
