export function createLocalId(): string {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
        return globalThis.crypto.randomUUID();
    }
    throw new Error('createLocalId(): crypto.randomUUID is not available');
}
