/**
 * Browser Test Harness
 *
 * This script runs in the browser and executes stress tests against
 * different storage adapters, including WaSqlite.
 */

import { runStressTest, type StressTestResult, type StressTestOptions } from './stressTestRunner';
import { DexieAdapter } from '../../src/storage/dexie';
import { MemoryAdapter } from '../../src/storage/memory';
import { SQLiteAdapter } from '../../src/storage/sqlite';
import { WaSqliteDriver, type WaSqliteDriverOptions } from '../../src/storage/sqlite/drivers/WaSqliteDriver';

// =============================================================================
// Adapter Factories
// =============================================================================

type AdapterConfig = {
    key: string;
    label: string;
    useSqliteSchema: boolean;
    factory: (dbName: string) => any;
};

const adapters: AdapterConfig[] = [
    {
        key: 'dexie',
        label: 'Dexie (IndexedDB)',
        useSqliteSchema: false,
        factory: (dbName) => new DexieAdapter(dbName),
    },
    {
        key: 'memory',
        label: 'MemoryAdapter',
        useSqliteSchema: false,
        factory: (dbName) => new MemoryAdapter(dbName),
    },
    {
        key: 'wa-sqlite-idb',
        label: 'WaSqlite (IDBBatchAtomicVFS)',
        useSqliteSchema: true,
        factory: async (dbName) => {
            const options: WaSqliteDriverOptions = { vfs: 'IDBBatchAtomicVFS' };
            const driver = new WaSqliteDriver(dbName, options);
            return new SQLiteAdapter(driver);
        },
    },
    {
        key: 'wa-sqlite-idb-mirror',
        label: 'WaSqlite (IDBMirrorVFS)',
        useSqliteSchema: true,
        factory: async (dbName) => {
            const options: WaSqliteDriverOptions = { vfs: 'IDBMirrorVFS' };
            const driver = new WaSqliteDriver(dbName, options);
            return new SQLiteAdapter(driver);
        },
    },
];

// =============================================================================
// UI Helpers
// =============================================================================

function log(message: string, type: 'info' | 'success' | 'error' = 'info'): void {
    const logEl = document.getElementById('log');
    if (!logEl) return;

    const line = document.createElement('div');
    line.className = `log-${type}`;
    line.textContent = `[${new Date().toISOString().slice(11, 19)}] ${message}`;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;

    console.log(`[${type.toUpperCase()}] ${message}`);
}

function updateStatus(adapterId: string, status: string, className: string): void {
    const el = document.getElementById(`status-${adapterId}`);
    if (el) {
        el.textContent = status;
        el.className = `status ${className}`;
    }
}

function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}

// =============================================================================
// Test Runner
// =============================================================================

async function runAdapterTest(adapter: AdapterConfig, options: StressTestOptions): Promise<StressTestResult> {
    log(`Starting test: ${adapter.label}`);
    updateStatus(adapter.key, 'Running...', 'running');

    try {
        const result = await runStressTest(adapter.factory, options, adapter.useSqliteSchema);

        if (result.success) {
            const msg = `✓ ${adapter.label}: Passed (${result.clientCount} items, ${formatDuration(result.duration)})`;
            log(msg, 'success');
            updateStatus(adapter.key, `Passed (${formatDuration(result.duration)})`, 'passed');
        } else {
            const msg = `✗ ${adapter.label}: Failed - ${result.error}`;
            log(msg, 'error');
            updateStatus(adapter.key, `Failed: ${result.error}`, 'failed');
        }

        return result;
    } catch (err: any) {
        const msg = `✗ ${adapter.label}: Error - ${err.message}`;
        log(msg, 'error');
        updateStatus(adapter.key, `Error: ${err.message}`, 'failed');
        return {
            success: false,
            clientCount: 0,
            serverCount: 0,
            duration: 0,
            error: err.message,
        };
    }
}

async function runAllTests(): Promise<void> {
    const runBtn = document.getElementById('run-btn') as HTMLButtonElement;
    const resultsEl = document.getElementById('results');

    if (runBtn) runBtn.disabled = true;
    if (resultsEl) resultsEl.innerHTML = '';

    // Get options from form
    const opCountEl = document.getElementById('op-count') as HTMLInputElement;
    const errorRateEl = document.getElementById('error-rate') as HTMLInputElement;
    const selectedAdaptersEl = document.querySelectorAll<HTMLInputElement>('input[name="adapter"]:checked');

    const opCount = parseInt(opCountEl?.value || '500', 10);

    // Scale timeout based on operation count - allow ~200ms per op for sync time
    const baseTimeout = 60_000; // 1 minute minimum
    const perOpTimeout = 200; // 200ms per operation
    const dynamicTimeout = Math.max(baseTimeout, opCount * perOpTimeout);

    // Check URL for explicit timeout override
    const params = new URLSearchParams(window.location.search);
    const urlTimeout = params.get('timeoutMs');

    const options: StressTestOptions = {
        opCount,
        errorRate: parseFloat(errorRateEl?.value || '0.06'),
        maxDelayMs: 40,
        syncInterval: 15,
        timeoutMs: urlTimeout ? parseInt(urlTimeout, 10) : dynamicTimeout,
    };

    const selectedKeys = Array.from(selectedAdaptersEl).map((el) => el.value);
    const selectedAdapters = adapters.filter((a) => selectedKeys.includes(a.key));

    log(`Running stress tests with ${options.opCount} operations, ${(options.errorRate! * 100).toFixed(0)}% error rate`);
    log(`Selected adapters: ${selectedAdapters.map((a) => a.label).join(', ')}`);

    const results: Record<string, StressTestResult> = {};

    for (const adapter of selectedAdapters) {
        results[adapter.key] = await runAdapterTest(adapter, options);
    }

    // Store results for Playwright to read
    (window as any).__STRESS_TEST_RESULTS__ = results;

    const passed = Object.values(results).filter((r) => r.success).length;
    const total = Object.values(results).length;

    log(`\nCompleted: ${passed}/${total} tests passed`, passed === total ? 'success' : 'error');

    if (runBtn) runBtn.disabled = false;
}

// =============================================================================
// Initialization
// =============================================================================

function initUI(): void {
    const app = document.getElementById('app');
    if (!app) return;

    app.innerHTML = `
        <h1>Dync Browser Stress Test</h1>
        
        <div class="controls">
            <div class="form-group">
                <label for="op-count">Operations:</label>
                <input type="number" id="op-count" value="500" min="100" max="5000" step="100">
            </div>
            
            <div class="form-group">
                <label for="error-rate">Error Rate:</label>
                <input type="number" id="error-rate" value="0.06" min="0" max="0.5" step="0.01">
            </div>
            
            <div class="form-group">
                <label>Adapters:</label>
                <div class="adapter-list">
                    ${adapters
                        .map(
                            (a) => `
                        <label class="adapter-option">
                            <input type="checkbox" name="adapter" value="${a.key}" checked>
                            ${a.label}
                            <span id="status-${a.key}" class="status"></span>
                        </label>
                    `,
                        )
                        .join('')}
                </div>
            </div>
            
            <button id="run-btn" type="button">Run Tests</button>
        </div>
        
        <div id="log" class="log"></div>
    `;

    document.getElementById('run-btn')?.addEventListener('click', runAllTests);
}

// Auto-run if query param is set (for Playwright)
function checkAutoRun(): void {
    const params = new URLSearchParams(window.location.search);
    if (params.get('autorun') === 'true') {
        const opCount = params.get('opCount');
        if (opCount) {
            const el = document.getElementById('op-count') as HTMLInputElement;
            if (el) el.value = opCount;
        }

        const adaptersParam = params.get('adapters');
        if (adaptersParam) {
            const selectedKeys = adaptersParam.split(',');
            document.querySelectorAll<HTMLInputElement>('input[name="adapter"]').forEach((el) => {
                el.checked = selectedKeys.includes(el.value);
            });
        }

        // Small delay to ensure UI is ready
        setTimeout(runAllTests, 100);
    }
}

// Initialize on DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        initUI();
        checkAutoRun();
    });
} else {
    initUI();
    checkAutoRun();
}

// Export for Playwright access
(window as any).__runStressTest__ = runStressTest;
(window as any).__adapters__ = adapters;

// Export classes for persistence tests
(window as any).__WaSqliteDriver__ = WaSqliteDriver;
(window as any).__SQLiteAdapter__ = SQLiteAdapter;

// Export Dync for full integration tests
import { Dync } from '../../src/index';
(window as any).__Dync__ = Dync;
