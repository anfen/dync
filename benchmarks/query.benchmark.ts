/**
 * Dync Query Performance Benchmark
 *
 * Measures the performance of complex chained where() queries across all storage adapters.
 * Uses tinybench (modern, stable successor to benchmark.js) for accurate measurements.
 *
 * Run with: pnpm benchmark
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Bench } from 'tinybench';

// Polyfill IndexedDB for Node.js (required for Dexie)
import 'fake-indexeddb/auto';

import { Dync, type ApiFunctions } from '../src/index';
import { DexieAdapter } from '../src/storage/dexie';
import { MemoryAdapter } from '../src/storage/memory';
import { SQLiteAdapter } from '../src/storage/sqlite';
import type { StorageAdapter } from '../src/storage/types';
import type { SQLiteDatabaseDriver, SQLiteRunResult, SQLiteQueryResult } from '../src/storage/sqlite/types';
import type { SyncedRecord } from '../src/types';

// ============================================================================
// sql.js Driver (same as test helper)
// ============================================================================

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - sql.js doesn't have proper types
import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';

interface SqlJsDriverOptions {
    locateFile?: (file: string) => string;
}

class SqlJsDriver implements SQLiteDatabaseDriver {
    readonly type = 'SqlJsDriver';
    private db?: SqlJsDatabase;
    private initializing?: Promise<void>;
    private readonly options: SqlJsDriverOptions;
    readonly name: string;

    constructor(name: string, options: SqlJsDriverOptions = {}) {
        this.name = name;
        this.options = options;
    }

    async open(): Promise<void> {
        if (this.db) return;
        if (!this.initializing) {
            this.initializing = (async () => {
                const sql = await initSqlJs({
                    locateFile: this.options.locateFile,
                });
                this.db = new sql.Database();
            })();
        }
        await this.initializing;
        this.initializing = undefined;
    }

    async close(): Promise<void> {
        if (this.db) {
            this.db.close();
            this.db = undefined;
        }
    }

    async run(sql: string, params?: unknown[]): Promise<SQLiteRunResult> {
        if (!this.db) throw new Error('Database not open');
        this.db.run(sql, params as (string | number | Uint8Array | null | undefined)[]);
        return { changes: this.db.getRowsModified() };
    }

    async query(sql: string, params?: unknown[]): Promise<SQLiteQueryResult> {
        if (!this.db) throw new Error('Database not open');
        const stmt = this.db.prepare(sql);
        stmt.bind(params as (string | number | Uint8Array | null | undefined)[]);
        const columns = stmt.getColumnNames();
        const values: unknown[][] = [];
        while (stmt.step()) {
            values.push(stmt.get());
        }
        stmt.free();
        return { columns, values };
    }

    async execute(sql: string): Promise<void> {
        if (!this.db) throw new Error('Database not open');
        this.db.exec(sql);
    }
}

const locateSqlJsFile = (() => {
    try {
        const require = createRequire(import.meta.url);
        const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
        const dir = path.dirname(wasmPath);
        return (file: string) => path.join(dir, file);
    } catch {
        return (file: string) => file;
    }
})();

const createSqlJsDriver = (name: string): SQLiteDatabaseDriver => {
    return new SqlJsDriver(name, { locateFile: locateSqlJsFile });
};

// ============================================================================
// Test Schema & Data
// ============================================================================

interface Contact extends SyncedRecord {
    name: string;
    email: string;
    company: string;
    department: string;
    role: string;
    age: number;
    active: boolean;
    country: string;
}

type BenchmarkSchema = Record<string, Contact> & {
    contacts: Contact;
};

// SQLite structured schema
const structuredSchema = {
    contacts: {
        columns: {
            name: { type: 'TEXT' as const },
            email: { type: 'TEXT' as const },
            company: { type: 'TEXT' as const },
            department: { type: 'TEXT' as const },
            role: { type: 'TEXT' as const },
            age: { type: 'INTEGER' as const },
            active: { type: 'BOOLEAN' as const },
            country: { type: 'TEXT' as const },
        },
    },
};

// Dexie string schema
const dexieSchema = {
    contacts: 'name, email, company, department, role, age, active, country',
};

// Dummy APIs - we're not testing sync, just queries
const dummyApis: Record<string, ApiFunctions> = {
    contacts: {
        add: async () => ({ id: 1, updated_at: new Date().toISOString() }),
        update: async () => true,
        remove: async () => {},
        list: async () => [],
    },
};

const companies = ['Acme Corp', 'TechStart', 'GlobalInc', 'DataFlow', 'CloudNine', 'ByteWorks', 'NetSphere', 'CodeCraft'];
const departments = ['Engineering', 'Sales', 'Marketing', 'Support', 'HR', 'Finance', 'Legal', 'Operations'];
const roles = ['Engineer', 'Manager', 'Director', 'VP', 'Analyst', 'Specialist', 'Coordinator', 'Lead'];
const countries = ['USA', 'UK', 'Germany', 'France', 'Japan', 'Australia', 'Canada', 'Brazil'];

const generateContacts = (count: number): Omit<Contact, '_localId' | 'updated_at'>[] => {
    const contacts: Omit<Contact, '_localId' | 'updated_at'>[] = [];
    for (let i = 0; i < count; i++) {
        contacts.push({
            name: `Contact ${i}`,
            email: `contact${i}@${companies[i % companies.length]!.toLowerCase().replace(' ', '')}.com`,
            company: companies[i % companies.length]!,
            department: departments[i % departments.length]!,
            role: roles[i % roles.length]!,
            age: 22 + (i % 45),
            active: i % 3 !== 0,
            country: countries[i % countries.length]!,
        });
    }
    return contacts;
};

// ============================================================================
// Adapter Scenarios
// ============================================================================

interface AdapterScenario {
    name: string;
    createAdapter: (dbName: string) => StorageAdapter;
    schema: unknown;
}

const adapterScenarios: AdapterScenario[] = [
    {
        name: 'MemoryAdapter',
        createAdapter: (dbName) => new MemoryAdapter(dbName),
        schema: structuredSchema,
    },
    {
        name: 'SQLiteAdapter (sql.js)',
        createAdapter: (dbName) => new SQLiteAdapter(createSqlJsDriver(dbName)),
        schema: structuredSchema,
    },
    {
        name: 'DexieAdapter (IndexedDB)',
        createAdapter: (dbName) => new DexieAdapter(dbName),
        schema: dexieSchema,
    },
];

// ============================================================================
// Helper: Create Dync instance
// ============================================================================

async function createBenchmarkDync(scenario: AdapterScenario) {
    const dbName = `benchmark-${scenario.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${Date.now()}`;
    const adapter = scenario.createAdapter(dbName);

    const db = new Dync<BenchmarkSchema>(dbName, dummyApis, adapter, {
        syncInterval: 0, // Disable sync
        minLogLevel: 'none',
    });

    db.version(1).stores(scenario.schema as any);

    return db;
}

// ============================================================================
// Benchmark Runner
// ============================================================================

const RECORD_COUNT = 1_000; // Reduced from 10,000 to prevent OOM
const WARMUP_ITERATIONS = 3;
const BENCHMARK_ITERATIONS = 50; // Reduced iterations
const RESULTS_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), 'results');

// Output collection for file writing
const output: string[] = [];
function log(message: string) {
    console.log(message);
    output.push(message);
}

// Helper to hint GC (if available)
function tryGC() {
    if (typeof global !== 'undefined' && typeof (global as any).gc === 'function') {
        (global as any).gc();
    }
}

async function runBenchmarks() {
    const startTime = new Date();
    const timestamp = startTime.toISOString().replace(/[:.]/g, '-');

    log('╔════════════════════════════════════════════════════════════════════╗');
    log('║           Dync Query Performance Benchmark                         ║');
    log('╠════════════════════════════════════════════════════════════════════╣');
    log(`║  Records: ${RECORD_COUNT.toLocaleString().padEnd(10)} Warmup iterations: ${WARMUP_ITERATIONS.toString().padEnd(18)}║`);
    log(`║  Started: ${startTime.toISOString().padEnd(55)}║`);
    log('╚════════════════════════════════════════════════════════════════════╝\n');

    const contactData = generateContacts(RECORD_COUNT);

    // Setup all Dync instances and populate with data
    const setupInstances: Array<{ scenario: AdapterScenario; db: Awaited<ReturnType<typeof createBenchmarkDync>> }> = [];

    for (const scenario of adapterScenarios) {
        const db = await createBenchmarkDync(scenario);
        const table = db.table('contacts');

        // Bulk insert in batches to reduce memory pressure
        const BATCH_SIZE = 100;
        for (let i = 0; i < contactData.length; i += BATCH_SIZE) {
            const batch = contactData.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map((contact) => table.add(contact as Contact)));
        }

        setupInstances.push({ scenario, db });
        log(`✓ ${scenario.name} initialized with ${RECORD_COUNT.toLocaleString()} records`);
    }

    // Clear contactData reference after setup
    contactData.length = 0;
    tryGC();

    log('\n');

    // ========================================================================
    // Benchmark 1: Complex chained OR query (the query discussed)
    // ========================================================================
    log('┌────────────────────────────────────────────────────────────────────┐');
    log('│  #1 Benchmark: Complex chained .or() query                         │');
    log('│  Query: where("name").startsWith("Contact 1")                      │');
    log('│         .or("name").startsWith("Contact 2")                        │');
    log('│         .or("name").startsWith("Contact 3")                        │');
    log('│         .toArray()                                                 │');
    log('└────────────────────────────────────────────────────────────────────┘\n');

    const bench1 = new Bench({ warmupIterations: WARMUP_ITERATIONS, iterations: BENCHMARK_ITERATIONS });

    for (const { scenario, db } of setupInstances) {
        const table = db.table('contacts');

        bench1.add(scenario.name, async () => {
            const results = await table.where('name').startsWith('Contact 1').or('name').startsWith('Contact 2').or('name').startsWith('Contact 3').toArray();
            if (results.length === 0) throw new Error('Unexpected empty results');
        });
    }

    await bench1.run();
    printResults(bench1);
    tryGC();

    // ========================================================================
    // Benchmark 2: Case-insensitive search with OR
    // ========================================================================
    log('\n┌────────────────────────────────────────────────────────────────────┐');
    log('│  #2 Benchmark: Case-insensitive chained .or() query                │');
    log('│  Query: where("company").startsWithIgnoreCase("acme")              │');
    log('│         .or("company").startsWithIgnoreCase("tech")                │');
    log('│         .or("company").startsWithIgnoreCase("data")                │');
    log('│         .toArray()                                                 │');
    log('└────────────────────────────────────────────────────────────────────┘\n');

    const bench2 = new Bench({ warmupIterations: WARMUP_ITERATIONS, iterations: BENCHMARK_ITERATIONS });

    for (const { scenario, db } of setupInstances) {
        const table = db.table('contacts');

        bench2.add(scenario.name, async () => {
            const results = await table
                .where('company')
                .startsWithIgnoreCase('acme')
                .or('company')
                .startsWithIgnoreCase('tech')
                .or('company')
                .startsWithIgnoreCase('data')
                .toArray();
            if (results.length === 0) throw new Error('Unexpected empty results');
        });
    }

    await bench2.run();
    printResults(bench2);
    tryGC();

    // ========================================================================
    // Benchmark 3: Simple equality query (baseline)
    // ========================================================================
    log('\n┌────────────────────────────────────────────────────────────────────┐');
    log('│  #3 Benchmark: Simple equality query (baseline)                    │');
    log('│  Query: where("company").equals("Acme Corp").toArray()             │');
    log('└────────────────────────────────────────────────────────────────────┘\n');

    const bench3 = new Bench({ warmupIterations: WARMUP_ITERATIONS, iterations: BENCHMARK_ITERATIONS });

    for (const { scenario, db } of setupInstances) {
        const table = db.table('contacts');

        bench3.add(scenario.name, async () => {
            const results = await table.where('company').equals('Acme Corp').toArray();
            if (results.length === 0) throw new Error('Unexpected empty results');
        });
    }

    await bench3.run();
    printResults(bench3);
    tryGC();

    // ========================================================================
    // Benchmark 4: Full table toArray()
    // ========================================================================
    log('\n┌────────────────────────────────────────────────────────────────────┐');
    log('│  #4 Benchmark: Full table toArray()                                │');
    log('│  Query: table.toArray()                                            │');
    log('└────────────────────────────────────────────────────────────────────┘\n');

    const bench4 = new Bench({ warmupIterations: WARMUP_ITERATIONS, iterations: 20 });

    for (const { scenario, db } of setupInstances) {
        const table = db.table('contacts');

        bench4.add(scenario.name, async () => {
            const results = await table.toArray();
            if (results.length !== RECORD_COUNT) throw new Error('Unexpected record count');
        });
    }

    await bench4.run();
    printResults(bench4);
    tryGC();

    // ========================================================================
    // Benchmark 5: anyOf query
    // ========================================================================
    log('\n┌────────────────────────────────────────────────────────────────────┐');
    log('│  #5 Benchmark: anyOf() query                                       │');
    log('│  Query: where("department").anyOf(["Engineering", "Sales", "HR"])  │');
    log('│         .toArray()                                                 │');
    log('└────────────────────────────────────────────────────────────────────┘\n');

    const bench5 = new Bench({ warmupIterations: WARMUP_ITERATIONS, iterations: BENCHMARK_ITERATIONS });

    for (const { scenario, db } of setupInstances) {
        const table = db.table('contacts');

        bench5.add(scenario.name, async () => {
            const results = await table.where('department').anyOf(['Engineering', 'Sales', 'HR']).toArray();
            if (results.length === 0) throw new Error('Unexpected empty results');
        });
    }

    await bench5.run();
    printResults(bench5);
    tryGC();

    // ========================================================================
    // Benchmark 6: Count query
    // ========================================================================
    log('\n┌────────────────────────────────────────────────────────────────────┐');
    log('│  #6 Benchmark: count() query                                       │');
    log('│  Query: where("active").equals(true).count()                       │');
    log('└────────────────────────────────────────────────────────────────────┘\n');

    const bench6 = new Bench({ warmupIterations: WARMUP_ITERATIONS, iterations: BENCHMARK_ITERATIONS });

    for (const { scenario, db } of setupInstances) {
        const table = db.table('contacts');

        bench6.add(scenario.name, async () => {
            const count = await table.where('active').equals(true).count();
            if (count === 0) throw new Error('Unexpected zero count');
        });
    }

    await bench6.run();
    printResults(bench6);

    // Cleanup
    log('\n═══════════════════════════════════════════════════════════════════════');
    log('Cleaning up...');
    for (const { db } of setupInstances) {
        await db.close();
    }
    log('Done!\n');

    // Write results to file
    if (!fs.existsSync(RESULTS_DIR)) {
        fs.mkdirSync(RESULTS_DIR, { recursive: true });
    }
    const resultsFile = path.join(RESULTS_DIR, `${timestamp}.txt`);
    fs.writeFileSync(resultsFile, output.join('\n'), 'utf-8');
    console.log(`Results saved to: ${resultsFile}`);
}

function printResults(bench: Bench) {
    const tasks = bench.tasks;

    // Sort by ops/sec (fastest first)
    const sorted = [...tasks].sort((a, b) => {
        const aHz = a.result?.hz ?? 0;
        const bHz = b.result?.hz ?? 0;
        return bHz - aHz;
    });

    const fastest = sorted[0];
    const fastestHz = fastest?.result?.hz ?? 1;

    log('Results (sorted by ops/sec, fastest first):');
    log('─'.repeat(72));
    log(`${'Adapter'.padEnd(28)} ${'ops/sec'.padStart(12)} ${'avg (ms)'.padStart(12)} ${'relative'.padStart(12)}`);
    log('─'.repeat(72));

    for (const task of sorted) {
        const result = task.result;
        if (!result || result.hz === undefined) continue;

        const hz = result.hz;
        const mean = result.mean * 1000; // Convert to ms
        const relative = hz / fastestHz;
        const relativeStr = relative === 1 ? 'fastest' : `${relative.toFixed(2)}x slower`;

        log(`${task.name.padEnd(28)} ${hz.toFixed(2).padStart(12)} ${mean.toFixed(3).padStart(12)} ${relativeStr.padStart(12)}`);
    }
}

// Run the benchmarks
runBenchmarks().catch(console.error);
