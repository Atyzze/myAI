export function pickSelection(items, remembered) {
    const list = Array.isArray(items) ? items : [];
    if (list.length === 0) return null;
    const newest = list[0];
    if (!remembered || remembered.id == null) return newest.id;

    if (!list.some(item => item.id == remembered.id)) return newest.id;

    const producedAt = Number(newest.time);
    const chosenAt = Number(remembered.at);
    if (Number.isFinite(producedAt) && Number.isFinite(chosenAt) && producedAt > chosenAt) {
        return newest.id;
    }
    return remembered.id;
}

export function rememberSelection(id) {
    return { id, at: Date.now() };
}
