export const normalizeIndexName = (index: string | string[]): string => (Array.isArray(index) ? `[${index.join('+')}]` : index);
