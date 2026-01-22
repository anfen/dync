import { vi } from 'vitest';

// simple wait utility
export async function wait(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}

// Poll until predicate returns true or timeout expires
export async function waitUntil(predicate: () => boolean, timeout = 800, step = 20) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        if (predicate()) return;

        await wait(step);
    }
    // leave final assertion to caller for clearer failure messages
}

export async function waitUntilAsync(predicate: () => Promise<boolean>, timeout = 800, step = 20) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        if (await predicate()) return;
        await wait(step);
    }
    // caller handles timeout messaging
}

// Deterministic UUID mock for tests. Call install once (module load) and
// call resetDeterministicUUID() in beforeEach to reset the sequence.
let _nextId = 0;
export function installDeterministicUUID() {
    if (!globalThis.crypto?.randomUUID) {
        // test shim for environments missing crypto.randomUUID
        global.crypto = { randomUUID: () => '' } as any;
    }
    vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => {
        const n = (++_nextId).toString().padStart(8, '0');
        return `${n.slice(0, 8)}-1111-2222-3333-${n.slice(0, 8)}444444`;
    });
}
export function resetDeterministicUUID() {
    _nextId = 0;
}

// small tick helper used in some specs
export async function tick(ms = 90) {
    return wait(ms);
}

// visibility helper used in advanced specs
export function setVisibility(state: DocumentVisibilityState) {
    Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => state,
    });
    document.dispatchEvent(new Event('visibilitychange'));
}
