class SortHelpers {
  static toggleSort(state, sortKey) {
    if (!sortKey) return false;
    if (state.sortKey === sortKey) {
      state.sortDirection = state.sortDirection === "asc" ? "desc" : "asc";
    } else {
      state.sortKey = sortKey;
      state.sortDirection = "asc";
    }
    return true;
  }

  static getSortIndicator(state, sortKey) {
    if (state.sortKey !== sortKey) return "";
    return state.sortDirection === "asc" ? "↑" : "↓";
  }

  static compareText(a, b) {
    return String(a || "").localeCompare(String(b || ""), undefined, { sensitivity: "base" });
  }

  static updateHeaderIndicators(table, state) {
    if (!table) return;
    const headers = table.querySelectorAll("th[data-sort-key]");
    headers.forEach((header) => {
      const currentText = String(header.textContent || "").replace(/[\s]*[↑↓]$/, "").trim();
      const label = header.dataset.sortLabel || currentText;
      header.dataset.sortLabel = label;
      const indicator = SortHelpers.getSortIndicator(state, header.dataset.sortKey || "");
      header.textContent = indicator ? `${label} ${indicator}` : label;
    });
  }
}

export { SortHelpers };
