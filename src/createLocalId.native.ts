import * as Crypto from 'expo-crypto';

export function createLocalId(): string {
    if (Crypto.randomUUID) {
        return Crypto.randomUUID();
    }
    throw new Error('createLocalId(): expo-crypto randomUUID is not available');
}
