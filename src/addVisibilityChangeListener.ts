import type { VisibilitySubscription } from './types';

export function addVisibilityChangeListener(
    add: boolean,
    currentSubscription: VisibilitySubscription | undefined,
    onVisibilityChange: (isVisible: boolean) => void,
): VisibilitySubscription | undefined {
    if (add && !currentSubscription) {
        const handler = () => {
            onVisibilityChange(document.visibilityState === 'visible');
        };
        document.addEventListener('visibilitychange', handler);

        return {
            remove: () => {
                document.removeEventListener('visibilitychange', handler);
            },
        };
    } else if (!add && currentSubscription) {
        currentSubscription.remove();
        return undefined;
    }
    return currentSubscription;
}
