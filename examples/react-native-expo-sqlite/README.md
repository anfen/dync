# React Native + Expo SQLite + Dync

A minimal example demonstrating **Dync** with Expo SQLite.

## Quick Start

```bash
pnpm install
pnpm start
```

Then press:

- `i` for iOS simulator
- `a` for Android emulator
- `w` for web browser (uses OPFS via wa-sqlite)

## What's Inside

The entire example is in a single file: **[app/(tabs)/index.tsx](<app/(tabs)/index.tsx>)**.

This includes:

- Type definitions for your data model
- Mock backend with Axios adapter (replace with your real API)
- Dync setup with SQLiteAdapter + ExpoSQLiteDriver
- React Native screen with CRUD operations
- Sync status indicator

## Key Dync Integration Points

```tsx
import { Dync, SQLiteAdapter } from '@anfenn/dync';
import { ExpoSQLiteDriver } from '@anfenn/dync/expo-sqlite';
import { useSyncState, useLiveQuery } from '@anfenn/dync/react';

// 1. Create Dync instance with SQLite adapter
export const db = new Dync<Store>(
    'my-app',
    { todos: createSyncApi(api) },
    new SQLiteAdapter(new ExpoSQLiteDriver('my-app')),
);

// 2. Define your schema - SQLite style with column types
db.version(1).stores({
    todos: {
        columns: {
            title: { type: 'TEXT', nullable: false },
            completed: { type: 'BOOLEAN', nullable: false, default: false },
        },
    },
});

// 3. Use in components
const syncState = useSyncState(db);
useLiveQuery(db, async () => { ... });
```

## Why Expo SQLite?

Expo SQLite uses **JSI** (JavaScript Interface) for synchronous native bridge calls, making it significantly faster than traditional bridge-based solutions.

## Learn More

- [Dync Documentation](../../README.md)
- [Expo SQLite Documentation](https://docs.expo.dev/versions/latest/sdk/sqlite/)
