import fs from 'node:fs';
import path from 'node:path';
import type { Bench } from 'tinybench';

// ============================================================================
// Constants
// ============================================================================

export const RECORD_COUNT = 1_000;
export const WARMUP_ITERATIONS = 3;
export const BENCHMARK_ITERATIONS = 50; // Reduced iterations
export const RESULTS_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'results');

// ============================================================================
// Output collection for file writing
// ============================================================================

const output: string[] = [];

export function log(message: string) {
    console.log(message);
    output.push(message);
}

export function getOutput(): string[] {
    return output;
}

export function clearOutput(): void {
    output.length = 0;
}

// ============================================================================
// Helper to hint GC (if available)
// ============================================================================

export function tryGC() {
    if (typeof global !== 'undefined' && typeof (global as any).gc === 'function') {
        (global as any).gc();
    }
}

// ============================================================================
// Suite header printing
// ============================================================================

export interface SuiteHeaderOptions {
    title: string;
    recordCount: number;
    warmupIterations: number;
    startTime: Date;
}

export function logSuiteHeader(options: SuiteHeaderOptions) {
    const { title, recordCount, warmupIterations, startTime } = options;
    const width = 66; // Inner width between ║ borders

    log('╔' + '═'.repeat(width) + '╗');
    log('║' + `           ${title}`.padEnd(width) + '║');
    log('╠' + '═'.repeat(width) + '╣');
    log('║' + `  Records: ${recordCount.toLocaleString().padEnd(10)} Warmup iterations: ${warmupIterations.toString().padEnd(17)}`.padEnd(width) + '║');
    log('║' + `  Started: ${startTime.toISOString()}`.padEnd(width) + '║');
    log('╚' + '═'.repeat(width) + '╝\n');
}

// ============================================================================
// Benchmark header printing
// ============================================================================

export interface BenchmarkHeaderOptions {
    number: number;
    name: string;
    queryLines: string[];
}

export function logBenchmarkHeader(options: BenchmarkHeaderOptions, newlineBefore = true) {
    const { number, name, queryLines } = options;
    const prefix = newlineBefore ? '\n' : '';
    const width = 66; // Inner width between │ borders

    log(`${prefix}┌${'─'.repeat(width)}┐`);
    log('│' + `  #${number} Benchmark: ${name}`.padEnd(width) + '│');

    for (let i = 0; i < queryLines.length; i++) {
        const line = queryLines[i]!;
        const linePrefix = i === 0 ? 'Query: ' : '       ';
        log('│' + `  ${linePrefix}${line}`.padEnd(width) + '│');
    }

    log(`└${'─'.repeat(width)}┘\n`);
}

// ============================================================================
// Results printing
// ============================================================================

export function printResults(bench: Bench) {
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

// ============================================================================
// Results file writing
// ============================================================================

export function writeResultsFile(timestamp: string) {
    if (!fs.existsSync(RESULTS_DIR)) {
        fs.mkdirSync(RESULTS_DIR, { recursive: true });
    }
    const resultsFile = path.join(RESULTS_DIR, `${timestamp}.txt`);
    fs.writeFileSync(resultsFile, output.join('\n'), 'utf-8');
    console.log(`Results saved to: ${resultsFile}`);
}
