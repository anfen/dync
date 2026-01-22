import { describe, it, expect, vi } from 'vitest';
import { createLocalId, changeKeysTo, changeKeysFrom, orderFor, sleep, omitFields, addOnSetDo, deleteKeyIfEmptyObject } from '../../src/helpers';
import { SyncAction } from '../../src/types';
import { Dync, MemoryAdapter } from '../../src/index';

// ============================================================================
// Pure helper function tests
// ============================================================================

describe('helpers', () => {
    describe('createLocalId', () => {
        it('generates a unique uuid-like string', () => {
            const first = createLocalId();
            const second = createLocalId();
            expect(typeof first).toBe('string');
            expect(typeof second).toBe('string');
            expect(first).not.toBe(second);
        });
    });

    describe('changeKeysTo / changeKeysFrom', () => {
        it('remaps keys on single object', () => {
            const source = { id: 1, updated_at: 'now', deleted: false, name: 'Item' };
            const remapped = changeKeysTo(source, 'remoteId', 'remoteUpdatedAt', 'remoteDeleted');
            expect(remapped).toEqual({ remoteId: 1, remoteUpdatedAt: 'now', remoteDeleted: false, name: 'Item' });
            const roundTrip = changeKeysFrom(remapped, 'remoteId', 'remoteUpdatedAt', 'remoteDeleted');
            expect(roundTrip).toEqual(source);
        });

        it('works on arrays', () => {
            const source = [
                { id: 1, updated_at: 'a', deleted: false },
                { id: 2, updated_at: 'b', deleted: true },
            ];
            const remapped = changeKeysTo(source, 'remoteId', 'remoteUpdatedAt', 'remoteDeleted');
            expect(Array.isArray(remapped)).toBe(true);
            expect(remapped[0]).toHaveProperty('remoteId', 1);
            const roundTrip = changeKeysFrom(remapped, 'remoteId', 'remoteUpdatedAt', 'remoteDeleted');
            expect(roundTrip).toEqual(source);
        });
    });

    describe('orderFor', () => {
        it('returns priority numbers for sync actions', () => {
            expect(orderFor(SyncAction.Create)).toBe(1);
            expect(orderFor(SyncAction.Update)).toBe(2);
            expect(orderFor(SyncAction.Remove)).toBe(3);
        });
    });

    describe('sleep', () => {
        it('resolves after specified milliseconds', async () => {
            vi.useFakeTimers();
            try {
                const sleeper = sleep(1000);
                const resolveSpy = vi.fn();

                sleeper.then(resolveSpy);

                await vi.advanceTimersByTimeAsync(999);
                expect(resolveSpy).not.toHaveBeenCalled();

                await vi.advanceTimersByTimeAsync(1);
                expect(resolveSpy).toHaveBeenCalledTimes(1);

                await sleeper;
            } finally {
                vi.useRealTimers();
            }
        });
    });

    describe('omitFields', () => {
        it('returns a shallow copy without specified fields', () => {
            const source = { id: 1, secret: 'hidden', name: 'visible' };
            const result = omitFields(source, ['secret']);

            expect(result).toEqual({ id: 1, name: 'visible' });
            expect(source).toHaveProperty('secret', 'hidden');
            expect(result).not.toBe(source);
        });
    });

    describe('addOnSetDo', () => {
        it('invokes callback every time the property is set', () => {
            const obj: { value?: number } = { value: 1 };
            const callback = vi.fn();

            addOnSetDo(obj, 'value', callback);

            obj.value = 2;
            obj.value = 3;

            expect(callback).toHaveBeenNthCalledWith(1, 2);
            expect(callback).toHaveBeenNthCalledWith(2, 3);
            expect(obj.value).toBe(3);
        });
    });

    describe('deleteKeyIfEmptyObject', () => {
        it('removes key when value is an empty object', () => {
            const target: Record<string, unknown> = { keep: { a: 1 }, remove: {} };

            deleteKeyIfEmptyObject(target, 'remove');
            deleteKeyIfEmptyObject(target, 'keep');

            expect(target).toEqual({ keep: { a: 1 } });
            expect('remove' in target).toBe(false);
        });

        it('leaves key when value is nullish or populated', () => {
            const target: Record<string, unknown> = { nil: null, nested: { a: 1 } };

            deleteKeyIfEmptyObject(target, 'nil');
            deleteKeyIfEmptyObject(target, 'nested');

            expect(target).toEqual({ nil: null, nested: { a: 1 } });
        });
    });
});

// ============================================================================
// Dync reactive helpers tests
// ============================================================================

describe('Dync reactive helpers', () => {
    const createSilentLogger = () => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    });

    it('notifies onSyncStateChange listeners when syncStatus updates', async () => {
        const dbName = 'reactive-onSyncStateChange';
        const db = new Dync(dbName, {}, new MemoryAdapter(dbName), { logger: createSilentLogger(), minLogLevel: 'none' });
        const listener = vi.fn();
        const unsubscribe = db.sync.onStateChange(listener);

        (db as any).syncStatus = 'syncing';
        (db as any).syncStatus = 'idle';

        expect(listener).toHaveBeenCalledTimes(2);
        expect(listener).toHaveBeenNthCalledWith(1, expect.objectContaining({ status: 'syncing' }));
        expect(listener).toHaveBeenNthCalledWith(2, expect.objectContaining({ status: 'idle' }));

        unsubscribe();
        (db as any).syncStatus = 'disabled';
        expect(listener).toHaveBeenCalledTimes(2);

        await db.close();
    });

    it('addOnSetDo defines accessors and invokes callback on assignment', async () => {
        const dbName = 'reactive-addOnSetDo';
        const db = new Dync(dbName, {}, new MemoryAdapter(dbName), { logger: createSilentLogger(), minLogLevel: 'none' });
        const target: { value: number } = { value: 1 };
        const callback = vi.fn();

        addOnSetDo(target, 'value', callback);

        const descriptor = Object.getOwnPropertyDescriptor(target, 'value');
        expect(typeof descriptor?.get).toBe('function');
        expect(typeof descriptor?.set).toBe('function');

        expect(target.value).toBe(1);
        target.value = 42;
        expect(callback).toHaveBeenCalledWith(42);
        expect(target.value).toBe(42);

        target.value = 99;
        expect(callback).toHaveBeenLastCalledWith(99);

        await db.close();
    });
});
