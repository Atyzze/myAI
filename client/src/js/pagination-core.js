export const PAGINATION_BARS = Object.freeze([
    Object.freeze({
        id: 'bottom', wrap: 'pagination', info: 'pageInfo',
        prev: 'prevPageBtn', next: 'nextPageBtn', onlyAfterFirstPage: false
    }),
    Object.freeze({
        id: 'top', wrap: 'paginationTop', info: 'pageInfoTop',
        prev: 'prevPageTopBtn', next: 'nextPageTopBtn', onlyAfterFirstPage: true
    })
]);

export function paginationBarVisible(bar, totalPages, curPage) {
    if (!bar) return false;
    if (!(Number(totalPages) > 1)) return false;
    if (!bar.onlyAfterFirstPage) return true;
    return Number(curPage) > 0;
}

export function visiblePaginationBars(totalPages, curPage) {
    return PAGINATION_BARS
        .filter(bar => paginationBarVisible(bar, totalPages, curPage))
        .map(bar => bar.id);
}
