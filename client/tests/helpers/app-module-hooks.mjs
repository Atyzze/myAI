const MEMORY_IDB = new URL('../fixtures/memory-idb.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
    const parent = String(context.parentURL || '');
    if (specifier === './idb-min.js' && parent.endsWith('/src/js/db.js')) {
        return { url: MEMORY_IDB, shortCircuit: true };
    }
    return nextResolve(specifier, context);
}
