import type { SQLiteDatabaseDriver, SQLiteQueryResult, SQLiteRunResult } from '../types';

/**
 * Virtual File System (VFS) options for wa-sqlite.
 * Each VFS has different trade-offs for performance, durability, and compatibility.
 *
 * @see https://github.com/rhashimoto/wa-sqlite/tree/master/src/examples#vfs-comparison
 */
export type WaSQLiteVfsType =
    /**
     * IDBBatchAtomicVFS - IndexedDB-backed storage
     * - Works on ALL contexts (Window, Worker, SharedWorker, service worker)
     * - Supports multiple connections
     * - Full durability with batch atomic writes
     * - Good general-purpose choice for maximum compatibility
     * @recommended For apps that need to work in main thread and don't need OPFS
     */
    | 'IDBBatchAtomicVFS'
    /**
     * IDBMirrorVFS - IndexedDB with in-memory mirror
     * - Works on ALL contexts
     * - Supports multiple connections
     * - Much faster than IDBBatchAtomicVFS
     * - Database must fit in available memory
     * @recommended For small databases where performance is critical
     */
    | 'IDBMirrorVFS'
    /**
     * OPFSCoopSyncVFS - OPFS with cooperative synchronous access
     * - Requires Worker context
     * - Supports multiple connections
     * - Filesystem transparent (can import/export files)
     * - Good balance of performance and compatibility
     * @recommended For apps needing OPFS with multi-connection support
     */
    | 'OPFSCoopSyncVFS'
    /**
     * AccessHandlePoolVFS - OPFS-backed storage (fastest single connection)
     * - Requires Worker context
     * - Single connection only (no multi-tab support)
     * - Best performance, supports WAL mode
     * - NOT filesystem transparent
     * @recommended For single-tab apps where performance is critical
     */
    | 'AccessHandlePoolVFS';

/**
 * Options for configuring the WaSQLiteDriver.
 */
export interface WaSQLiteDriverOptions {
    /**
     * Virtual File System to use for storage.
     * @default 'IDBBatchAtomicVFS'
     */
    vfs?: WaSQLiteVfsType;

    /**
     * Directory path for the database in OPFS VFS modes.
     * Only used with OPFS-based VFS types.
     * @default '/'
     */
    directory?: string;

    /**
     * SQLite page size in bytes.
     * Larger pages can improve read performance for large BLOBs.
     * Cannot be changed after database creation for IDBBatchAtomicVFS/IDBMirrorVFS.
     * @default 4096
     */
    pageSize?: number;

    /**
     * SQLite cache size in pages (negative = KB, positive = pages).
     * Larger cache improves performance but uses more memory.
     * For IDBBatchAtomicVFS, must be large enough to hold journal for batch atomic mode.
     * @default -2000 (2MB)
     */
    cacheSize?: number;

    /**
     * Enable WAL (Write-Ahead Logging) mode.
     * Only supported with AccessHandlePoolVFS (with locking_mode=exclusive).
     * For other VFS types, this is ignored.
     * @default false
     */
    wal?: boolean;

    /**
     * Set synchronous pragma for durability vs performance trade-off.
     * - 'full': Maximum durability (default)
     * - 'normal': Relaxed durability, better performance (supported by IDBBatchAtomicVFS, IDBMirrorVFS, OPFSPermutedVFS)
     * - 'off': No sync, fastest but risks data loss on crash
     * @default 'full'
     */
    synchronous?: 'full' | 'normal' | 'off';
}

// Internal VFS interface for lifecycle management
interface WaSQLiteVFS {
    close(): Promise<void>;
    name: string;
}

// VFS class type with static create method
interface VFSClass {
    create(name: string, module: any, options?: any): Promise<WaSQLiteVFS>;
}

// Cached module factory and instance
let cachedModuleFactory: (() => Promise<any>) | null = null;
let cachedModule: any = null;
let cachedSQLite3: any = null;
// Track VFS instances by name to avoid re-registering
const registeredVFS = new Map<string, WaSQLiteVFS>();

/**
 * SQLite driver for web browsers using wa-sqlite with IndexedDB or OPFS persistence.
 * Provides robust, persistent SQLite storage in the browser that prevents data loss.
 *
 * ## Data Safety Features
 *
 * - **IDBBatchAtomicVFS** (default): Uses IndexedDB batch atomic writes to ensure transactions
 *   are either fully committed or not at all. Multi-tab safe.
 * - **IDBMirrorVFS**: IndexedDB with in-memory mirror. Much faster, database must fit in RAM.
 * - **OPFSCoopSyncVFS**: OPFS with cooperative sync. Multi-connection, filesystem transparent.
 * - **AccessHandlePoolVFS**: Uses OPFS Access Handles for high performance. Single-tab only.
 * - Full durability by default (`PRAGMA synchronous=full`)
 * - Automatic journal mode configuration for each VFS type
 *
 * ## VFS Selection Guide
 *
 * | VFS | Best For | Multi-Tab | Speed |
 * |-----|----------|-----------|-------|
 * | IDBBatchAtomicVFS | General use, main thread | ✅ | Good |
 * | IDBMirrorVFS | Small DBs, main thread | ✅ | Fast |
 * | OPFSCoopSyncVFS | Web Workers, file export | ✅ | Good |
 * | AccessHandlePoolVFS | Single-tab performance | ❌ | Fastest |
 *
 * @example
 * ```ts
 * import { WaSQLiteDriver } from '@anfenn/dync/wa-sqlite';
 * import { SQLiteAdapter } from '@anfenn/dync';
 *
 * // Default: IDBBatchAtomicVFS (works in main thread, multi-tab safe)
 * const driver = new WaSQLiteDriver('myapp.db');
 *
 * // For OPFS (faster, requires Worker, filesystem transparent)
 * const opfsDriver = new WaSQLiteDriver('myapp.db', { vfs: 'OPFSCoopSyncVFS' });
 *
 * const adapter = new SQLiteAdapter('myapp', driver);
 * ```
 */
export class WaSQLiteDriver implements SQLiteDatabaseDriver {
    readonly type = 'WaSQLiteDriver';
    private db: number | null = null;
    private sqlite3: any = null;
    private readonly options: Required<WaSQLiteDriverOptions>;
    private opened = false;
    private openPromise: Promise<void> | null = null;
    // Mutex to prevent concurrent database operations (critical for wa-sqlite)
    private executionLock: Promise<void> = Promise.resolve();
    readonly name: string;

    constructor(databaseName: string, options: WaSQLiteDriverOptions = {}) {
        this.name = databaseName;
        this.options = {
            vfs: 'IDBBatchAtomicVFS',
            directory: '/',
            pageSize: 4096,
            cacheSize: -2000,
            wal: false,
            synchronous: 'full',
            ...options,
        };
    }

    /**
     * Execute a callback with exclusive database access.
     * This prevents concurrent operations which can corrupt the database.
     */
    private async withLock<T>(fn: () => Promise<T>): Promise<T> {
        // Chain onto the existing lock
        const previousLock = this.executionLock;
        let releaseLock: () => void;
        this.executionLock = new Promise<void>((resolve) => {
            releaseLock = resolve;
        });

        try {
            // Wait for previous operation to complete
            await previousLock;
            // Execute our operation
            return await fn();
        } finally {
            // Release the lock
            releaseLock!();
        }
    }

    async open(): Promise<void> {
        if (this.opened) return;
        if (this.openPromise) return this.openPromise;

        this.openPromise = this._open();

        try {
            await this.openPromise;
        } finally {
            this.openPromise = null;
        }
    }

    private async _open(): Promise<void> {
        // Load wa-sqlite module (asyncify build for async VFS support)
        const module = await this.loadWasmModule();

        // Create SQLite API from module (cached - must only create once per module)
        if (!cachedSQLite3) {
            const { Factory } = await import('@journeyapps/wa-sqlite');
            cachedSQLite3 = Factory(module);
        }
        this.sqlite3 = cachedSQLite3;

        // For IDB-based VFS, the VFS name is also used as the IndexedDB database name
        // Use a unique name based on database name to avoid conflicts
        const vfsName = `dync_${this.options.vfs}_${this.name}`.replace(/[^a-zA-Z0-9_-]/g, '_');

        // Reuse existing VFS instance or create and register a new one
        let existingVfs = registeredVFS.get(vfsName);
        if (!existingVfs) {
            existingVfs = await this.createVFS(module, vfsName);
            // Register VFS with SQLite as default (like PowerSync does)
            this.sqlite3.vfs_register(existingVfs, true);
            registeredVFS.set(vfsName, existingVfs);
        }

        // Build database path - for IDB VFS, this is the "file" path within the VFS
        const dbPath = this.buildDatabasePath();

        // Open database (VFS is registered as default)
        this.db = await this.sqlite3.open_v2(dbPath);

        // Configure database pragmas for performance and durability
        await this.configurePragmas();

        this.opened = true;
    }

    private async loadWasmModule(): Promise<any> {
        if (!cachedModule) {
            if (!cachedModuleFactory) {
                // Dynamically import the asyncify build for async VFS support
                const wasmModule = await import('@journeyapps/wa-sqlite/dist/wa-sqlite-async.mjs');
                cachedModuleFactory = wasmModule.default;
            }
            // Cache the module instance - all VFS and sqlite3 APIs must share the same module
            cachedModule = await cachedModuleFactory();
        }
        return cachedModule;
    }

    private async createVFS(module: any, vfsName: string): Promise<WaSQLiteVFS> {
        const vfsType = this.options.vfs;
        let VFSClass: VFSClass;
        let vfsOptions: any = undefined;

        // Dynamically import VFS implementation
        // Note: We cast to unknown first because the package types don't include the static create method
        switch (vfsType) {
            case 'IDBBatchAtomicVFS': {
                const mod = await import('@journeyapps/wa-sqlite/src/examples/IDBBatchAtomicVFS.js');
                VFSClass = mod.IDBBatchAtomicVFS as unknown as VFSClass;
                // Use exclusive lock policy like PowerSync does
                vfsOptions = { lockPolicy: 'exclusive' };
                break;
            }
            case 'IDBMirrorVFS': {
                const mod = await import('@journeyapps/wa-sqlite/src/examples/IDBMirrorVFS.js');
                VFSClass = mod.IDBMirrorVFS as unknown as VFSClass;
                break;
            }
            case 'OPFSCoopSyncVFS': {
                const mod = await import('@journeyapps/wa-sqlite/src/examples/OPFSCoopSyncVFS.js');
                VFSClass = mod.OPFSCoopSyncVFS as unknown as VFSClass;
                break;
            }
            case 'AccessHandlePoolVFS': {
                const mod = await import('@journeyapps/wa-sqlite/src/examples/AccessHandlePoolVFS.js');
                VFSClass = mod.AccessHandlePoolVFS as unknown as VFSClass;
                break;
            }
            default:
                throw new Error(`Unsupported VFS type: ${vfsType}`);
        }

        return VFSClass.create(vfsName, module, vfsOptions);
    }

    private buildDatabasePath(): string {
        const vfsType = this.options.vfs;

        // For IDB-based VFS, use database name directly
        if (vfsType === 'IDBBatchAtomicVFS' || vfsType === 'IDBMirrorVFS') {
            return this.name;
        }

        // For OPFS-based VFS, build full path
        const directory = this.options.directory.replace(/\/$/, '');
        return `${directory}/${this.name}`;
    }

    private async configurePragmas(): Promise<void> {
        if (!this.db || !this.sqlite3) return;

        // Page size can only be set on new/empty databases
        // For IDBBatchAtomicVFS, it cannot be changed after creation
        // Try to set it, but ignore errors if the database already exists
        try {
            await this.sqlite3.exec(this.db, `PRAGMA page_size = ${this.options.pageSize}`);
        } catch {
            // Page size already set, ignore
        }

        // Cache size for performance
        await this.sqlite3.exec(this.db, `PRAGMA cache_size = ${this.options.cacheSize}`);

        // WAL mode only for AccessHandlePoolVFS with exclusive locking
        if (this.options.wal && this.options.vfs === 'AccessHandlePoolVFS') {
            await this.sqlite3.exec(this.db, 'PRAGMA locking_mode = exclusive');
            await this.sqlite3.exec(this.db, 'PRAGMA journal_mode = WAL');
        }
        // Note: For IDB-based VFS, we don't set journal_mode - let the VFS handle it
    }

    async close(): Promise<void> {
        if (!this.opened || !this.db || !this.sqlite3) return;

        // Wait for any pending operations to complete by acquiring the lock
        await this.withLock(async () => {
            // Ensure all data is flushed before closing
            // This is critical for IDB-based VFS which batch writes
            try {
                await this.sqlite3!.exec(this.db!, 'PRAGMA wal_checkpoint(TRUNCATE)');
            } catch {
                // Ignore if WAL mode not enabled
            }

            await this.sqlite3!.close(this.db!);

            // Don't close the shared VFS - it may be used by other connections
            // The VFS will be cleaned up when all references are gone
            this.db = null;
            this.opened = false;
        });
    }

    async execute(statement: string): Promise<void> {
        await this.open();

        if (!this.db || !this.sqlite3) {
            throw new Error('Database not initialized');
        }

        await this.withLock(async () => {
            await this.sqlite3.exec(this.db, statement);
        });
    }

    async run(statement: string, values: unknown[] = []): Promise<SQLiteRunResult> {
        await this.open();

        if (!this.db || !this.sqlite3) {
            throw new Error('Database not initialized');
        }

        return this.withLock(async () => {
            // Convert values for SQLite (booleans -> integers)
            const convertedValues = this.convertValues(values);

            // Use statements() generator with proper binding
            for await (const stmt of this.sqlite3.statements(this.db, statement)) {
                if (stmt === null) {
                    break;
                }

                // Reset statement before binding (critical for wa-sqlite)
                this.sqlite3.reset(stmt);

                // Bind parameters if any
                if (convertedValues.length > 0) {
                    this.sqlite3.bind_collection(stmt, convertedValues);
                }

                // Execute the statement
                await this.sqlite3.step(stmt);
            }

            return {
                changes: this.sqlite3.changes(this.db),
                lastId: Number(this.sqlite3.last_insert_id(this.db)),
            };
        });
    }

    /**
     * Convert values for SQLite compatibility.
     * - Booleans must be converted to integers (SQLite has no boolean type)
     */
    private convertValues(values: unknown[]): unknown[] {
        return values.map((value) => {
            if (typeof value === 'boolean') {
                return value ? 1 : 0;
            }
            return value;
        });
    }

    async query(statement: string, values: unknown[] = []): Promise<SQLiteQueryResult> {
        await this.open();

        if (!this.db || !this.sqlite3) {
            throw new Error('Database not initialized');
        }

        return this.withLock(async () => {
            const { SQLITE_ROW } = await import('@journeyapps/wa-sqlite');
            const allRows: unknown[][] = [];
            let columns: string[] = [];

            // Convert values for SQLite (booleans -> integers)
            const convertedValues = this.convertValues(values);

            // Use statements() generator with proper binding
            for await (const stmt of this.sqlite3.statements(this.db, statement)) {
                if (stmt === null) {
                    break;
                }

                // Reset statement before binding (critical for wa-sqlite)
                this.sqlite3.reset(stmt);

                // Bind parameters if any
                if (convertedValues.length > 0) {
                    this.sqlite3.bind_collection(stmt, convertedValues);
                }

                // Get column names
                if (columns.length === 0) {
                    columns = this.sqlite3.column_names(stmt);
                }

                // Fetch all rows
                while ((await this.sqlite3.step(stmt)) === SQLITE_ROW) {
                    const row = this.sqlite3.row(stmt);
                    allRows.push(row);
                }
            }

            return { columns, values: allRows };
        });
    }

    /**
     * Check if the database is currently open.
     */
    isOpen(): boolean {
        return this.opened;
    }

    /**
     * Get the VFS type being used by this driver.
     */
    getVfsType(): WaSQLiteVfsType {
        return this.options.vfs;
    }

    /**
     * Delete the database.
     * This will close the database if open and remove all persisted data.
     * For IndexedDB-based VFS, this deletes the IndexedDB database.
     * For OPFS-based VFS, this removes the files from OPFS.
     */
    async delete(): Promise<void> {
        // Close if open
        if (this.opened) {
            await this.close();
        }

        const vfsType = this.options.vfs;

        if (vfsType === 'IDBBatchAtomicVFS' || vfsType === 'IDBMirrorVFS') {
            // Delete IndexedDB database
            await new Promise<void>((resolve, reject) => {
                const request = indexedDB.deleteDatabase(this.name);
                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error);
                request.onblocked = () => {
                    console.warn(`Database deletion blocked for ${this.name}. Close all connections and try again.`);
                };
            });
        } else {
            // For OPFS-based VFS, remove the directory
            const dbPath = this.buildDatabasePath();
            const root = await navigator.storage.getDirectory();

            try {
                // Try to remove the file/directory
                const pathParts = dbPath.split('/').filter(Boolean);
                let current = root;

                // Navigate to parent directory
                for (let i = 0; i < pathParts.length - 1; i++) {
                    current = await current.getDirectoryHandle(pathParts[i]!);
                }

                // Remove the database file
                const filename = pathParts[pathParts.length - 1]!;
                await current.removeEntry(filename, { recursive: true });

                // Also try to remove associated journal/wal files
                const associatedFiles = [`${filename}-journal`, `${filename}-wal`, `${filename}-shm`];
                for (const file of associatedFiles) {
                    try {
                        await current.removeEntry(file, { recursive: false });
                    } catch {
                        // Ignore if file doesn't exist
                    }
                }
            } catch (error) {
                // Ignore if directory doesn't exist
                if ((error as Error).name !== 'NotFoundError') {
                    throw error;
                }
            }
        }
    }
}
