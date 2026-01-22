import type { VisibilitySubscription } from './types';

export function addVisibilityChangeListener(
    add: boolean,
    currentSubscription: VisibilitySubscription | undefined,
    onVisibilityChange: (isVisible: boolean) => void,
): VisibilitySubscription | undefined {
    if (add && !currentSubscription) {
        let nativeSubscription: { remove: () => void } | undefined;

        void (async () => {
            try {
                const ReactNative = await import('react-native');
                const handler = (state: Parameters<typeof ReactNative.AppState.addEventListener>[1] extends (state: infer S) => any ? S : never) => {
                    onVisibilityChange(state === 'active');
                };
                nativeSubscription = ReactNative.AppState.addEventListener('change', handler);
            } catch {
                // AppState unavailable
            }
        })();

        return {
            remove: () => {
                nativeSubscription?.remove();
            },
        };
    } else if (!add && currentSubscription) {
        currentSubscription.remove();
        return undefined;
    }
    return currentSubscription;
}
