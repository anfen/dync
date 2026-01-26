/**
 * Dync Query Performance Benchmark
 *
 * Measures the performance of complex chained where() queries across all storage adapters.
 * Uses tinybench (modern, stable successor to benchmark.js) for accurate measurements.
 *
 * Run with: pnpm benchmark
 */

import { Bench } from 'tinybench';

// Polyfill IndexedDB for Node.js (required for Dexie)
import 'fake-indexeddb/auto';

import { Dync } from '../src/index';
import { DexieAdapter } from '../src/storage/dexie';
import { MemoryAdapter } from '../src/storage/memory';
import { SQLiteAdapter } from '../src/storage/sqlite';
import type { StorageAdapter } from '../src/storage/types';

import {
    createSqlJsDriver,
    type Contact,
    type BenchmarkSchema,
    structuredSchema,
    dexieSchema,
    dummyApis,
    generateContacts,
    RECORD_COUNT,
    WARMUP_ITERATIONS,
    BENCHMARK_ITERATIONS,
    log,
    tryGC,
    logSuiteHeader,
    logBenchmarkHeader,
    printResults,
    writeResultsFile,
} from './helpers';

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

    const db = new Dync<BenchmarkSchema>({
        databaseName: dbName,
        storageAdapter: adapter,
        sync: dummyApis,
        options: {
            syncInterval: 0, // Disable sync
            minLogLevel: 'none',
        },
    });

    db.version(1).stores(scenario.schema as any);

    return db;
}

// ============================================================================
// Benchmark Runner
// ============================================================================

async function runBenchmarks() {
    const startTime = new Date();
    const timestamp = startTime.toISOString().replace(/[:.]/g, '-');

    logSuiteHeader({
        title: 'Dync Query Performance Benchmark',
        recordCount: RECORD_COUNT,
        warmupIterations: WARMUP_ITERATIONS,
        startTime,
    });

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
    // Benchmark 1: Complex chained OR query
    // ========================================================================
    logBenchmarkHeader(
        {
            number: 1,
            name: 'Complex chained .or() query',
            queryLines: ['where("name").startsWith("Contact 1")', '.or("name").startsWith("Contact 2")', '.or("name").startsWith("Contact 3")', '.toArray()'],
        },
        false,
    );

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
    logBenchmarkHeader({
        number: 2,
        name: 'Case-insensitive chained .or() query',
        queryLines: [
            'where("company").startsWithIgnoreCase("acme")',
            '.or("company").startsWithIgnoreCase("tech")',
            '.or("company").startsWithIgnoreCase("data")',
            '.toArray()',
        ],
    });

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
    logBenchmarkHeader({
        number: 3,
        name: 'Simple equality query (baseline)',
        queryLines: ['where("company").equals("Acme Corp").toArray()'],
    });

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
    logBenchmarkHeader({
        number: 4,
        name: 'Full table toArray()',
        queryLines: ['table.toArray()'],
    });

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
    logBenchmarkHeader({
        number: 5,
        name: 'anyOf() query',
        queryLines: ['where("department").anyOf(["Engineering", "Sales", "HR"])', '.toArray()'],
    });

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
    logBenchmarkHeader({
        number: 6,
        name: 'count() query',
        queryLines: ['where("active").equals(true).count()'],
    });

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
    writeResultsFile(timestamp);
}

// Run the benchmarks
runBenchmarks().catch(console.error);
