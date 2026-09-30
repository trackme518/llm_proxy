import { UiHelpers } from "./domUtils.js";
import { SortHelpers } from "./sortUtils.js";

class InfoSection {
  constructor(api, elements) {
    this.api = api;
    this.elements = elements;
    this.routes = [];
    this.sortKey = null;
    this.sortDirection = "asc";
    this.registerSortEvents();
  }

  registerSortEvents() {
    const routesTable = this.elements.routesTableBody?.closest("table");
    routesTable?.querySelector("thead")?.addEventListener("click", (event) => {
      const header = event.target.closest("th[data-sort-key]");
      if (!header) return;
      this.toggleSort(header.dataset.sortKey);
    });
  }

  setAuthLevel(level) {
    if (this.elements.authLevelValue) {
      this.elements.authLevelValue.textContent = level === null ? "Not authenticated" : String(level);
    }
  }

  async loadTools() {
    const { response, data, rawText } = await this.api.request("/api/tools", { method: "GET" });
    if (!response.ok) {
      throw new Error(data?.error || rawText || `HTTP ${response.status}`);
    }

    const tools = Array.isArray(data?.tools) ? data.tools : [];
    this.renderTools(tools);
  }

  async loadRoutes() {
    const { response, data, rawText } = await this.api.request("/admin/routes", { method: "POST" });
    if (!response.ok) {
      throw new Error(data?.error || rawText || `HTTP ${response.status}`);
    }

    this.routes = Array.isArray(data?.routes) ? data.routes : [];
    this.renderRoutes();
  }

  toggleSort(sortKey) {
    if (!SortHelpers.toggleSort(this, sortKey)) return;
    this.renderRoutes();
  }

  getSortedRoutes() {
    const routes = [...this.routes];
    if (!this.sortKey) return routes;
    const direction = this.sortDirection === "asc" ? 1 : -1;

    return routes.sort((a, b) => {
      if (this.sortKey === "required_privilege") {
        return (Number(a.required_privilege || 0) - Number(b.required_privilege || 0)) * direction;
      }
      return SortHelpers.compareText(a[this.sortKey], b[this.sortKey]) * direction;
    });
  }

  renderTools(tools) {
    if (!this.elements.toolsTableBody) return;
    if (tools.length === 0) {
      this.elements.toolsTableBody.innerHTML = "<tr><td colspan=\"2\" style=\"color:#777;\">No tools available.</td></tr>";
      return;
    }

    this.elements.toolsTableBody.innerHTML = tools
      .map((tool) => {
        const fn = tool.function || {};
        const name = UiHelpers.escapeHtml(fn.name || "-");
        const description = UiHelpers.escapeHtml(fn.description || "");
        return `<tr><td>${name}</td><td>${description}</td></tr>`;
      })
      .join("");
  }

  renderRoutes() {
    if (!this.elements.routesTableBody) return;
    const routesTable = this.elements.routesTableBody.closest("table");
    SortHelpers.updateHeaderIndicators(routesTable, this);

    const routes = this.getSortedRoutes();
    if (routes.length === 0) {
      this.elements.routesTableBody.innerHTML = "<tr><td colspan=\"3\" style=\"color:#777;\">No endpoints available.</td></tr>";
      return;
    }

    this.elements.routesTableBody.innerHTML = routes
      .map((route) => {
        const method = UiHelpers.escapeHtml(route.method || "-");
        const path = UiHelpers.escapeHtml(route.path || "-");
        const level = Number.isFinite(Number(route.required_privilege)) ? Number(route.required_privilege) : "-";
        return `<tr><td>${method}</td><td>${path}</td><td>${level}</td></tr>`;
      })
      .join("");
  }
}

export { InfoSection };
