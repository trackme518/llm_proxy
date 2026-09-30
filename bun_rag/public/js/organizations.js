import { UiHelpers } from "./domUtils.js";
import { SortHelpers } from "./sortUtils.js";
import { runSequential, updateBulkStatus } from "./actions.js";

class OrganizationsSection {
  constructor(api, elements) {
    this.api = api;
    this.elements = elements;
    this.organizations = [];
    this.selectedOrganizationIds = new Set();
    this.onSelectionChange = null;
    this.sortKey = null;
    this.sortDirection = "asc";
    this.registerEvents();
  }

  registerEvents() {
    this.elements.addOrganizationBtn?.addEventListener("click", () => this.addOrganization());
    this.elements.refreshOrganizationsBtn?.addEventListener("click", () => this.refreshOrganizationsList());
    this.elements.selectAllOrganizationsBtn?.addEventListener("click", () => this.selectAllOrganizations());
    this.elements.deselectAllOrganizationsBtn?.addEventListener("click", () => this.deselectAllOrganizations());
    this.elements.deleteAllOrganizationsBtn?.addEventListener("click", () => this.deleteAllSelectedOrganizations());

    this.elements.organizationsTableContainer?.addEventListener("change", (event) => {
      const target = event.target;
      if (!target || !target.matches("input[name='organizationSelect']")) return;
      const organizationId = Number(target.value || 0);
      if (!organizationId) return;
      if (target.checked) {
        this.selectedOrganizationIds.add(organizationId);
      } else {
        this.selectedOrganizationIds.delete(organizationId);
      }
      this.notifySelectionChange();
    });

    this.elements.organizationsTableContainer?.addEventListener("click", (event) => {
      const header = event.target.closest("th[data-sort-key]");
      if (header) {
        this.toggleSort(header.dataset.sortKey);
        return;
      }

      const button = event.target.closest("button");
      if (!button) return;
      const organizationId = Number(button.dataset.organizationId || 0);
      if (!organizationId) return;
      this.deleteOrganization(organizationId);
    });
  }

  toggleSort(sortKey) {
    if (!SortHelpers.toggleSort(this, sortKey)) return;
    this.renderOrganizationsTable();
  }

  getSortIndicator(sortKey) {
    return SortHelpers.getSortIndicator(this, sortKey);
  }

  getSortedOrganizations() {
    if (!this.sortKey) return [...this.organizations];
    const direction = this.sortDirection === "asc" ? 1 : -1;
    return [...this.organizations].sort((a, b) => {
      const left = String(a[this.sortKey] || "");
      const right = String(b[this.sortKey] || "");
      return SortHelpers.compareText(left, right) * direction;
    });
  }

  setSelectionChangeHandler(handler) {
    this.onSelectionChange = typeof handler === "function" ? handler : null;
  }

  setSelectedOrganizations(ids, notify = true) {
    const list = Array.isArray(ids) ? ids : [];
    this.selectedOrganizationIds = new Set(list.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0));
    this.renderOrganizationsTable();
    if (notify) {
      this.notifySelectionChange();
    }
  }

  notifySelectionChange() {
    if (!this.onSelectionChange) return;
    this.onSelectionChange([...this.selectedOrganizationIds]);
  }

  renderOrganizationsTable() {
    if (!this.organizations.length) {
      this.selectedOrganizationIds.clear();
      this.elements.organizationsTableContainer.innerHTML = "<div class=\"no-data\">No organizations found</div>";
      return;
    }

    const validIds = new Set(this.organizations.map((org) => Number(org.organization_id)));
    this.selectedOrganizationIds = new Set([...this.selectedOrganizationIds].filter((id) => validIds.has(id)));

    const rows = this.getSortedOrganizations()
      .map((org) => {
        const title = UiHelpers.escapeHtml(org.name || "");
        const slug = UiHelpers.escapeHtml(org.slug || "");
        const organizationId = Number(org.organization_id);
        const isSelected = this.selectedOrganizationIds.has(organizationId);
        return `
          <tr>
            <td>
              <label class="select-radio">
                <input type="checkbox" name="organizationSelect" value="${organizationId}" ${isSelected ? "checked" : ""}>
                <span class="radio-dot"></span>
              </label>
            </td>
            <td>${title}</td>
            <td>${slug}</td>
            <td><button class="danger" data-organization-id="${org.organization_id}">Delete</button></td>
          </tr>
        `;
      })
      .join("");

    this.elements.organizationsTableContainer.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Select</th>
            <th data-sort-key="name">Title ${this.getSortIndicator("name")}</th>
            <th data-sort-key="slug">Slug ${this.getSortIndicator("slug")}</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  selectAllOrganizations() {
    this.organizations.forEach((org) => {
      const id = Number(org.organization_id);
      if (id > 0) this.selectedOrganizationIds.add(id);
    });
    this.renderOrganizationsTable();
    this.notifySelectionChange();
  }

  deselectAllOrganizations() {
    this.selectedOrganizationIds.clear();
    this.renderOrganizationsTable();
    this.notifySelectionChange();
  }

  async deleteAllSelectedOrganizations() {
    const ids = [...this.selectedOrganizationIds];
    if (!ids.length) {
      UiHelpers.showAlert(this.elements.organizationsAlert, "No organizations selected", "error");
      return;
    }

    if (!confirm(`Delete ${ids.length} selected organization(s)?`)) return;

    const results = await runSequential(ids, async (organizationId) => {
      const { response, data, rawText } = await this.api.request("/admin/delete-organization", {
        method: "POST",
        body: { organization_id: organizationId },
      });
      if (!response.ok) {
        throw new Error(data?.error || rawText || "Failed to delete organization");
      }
    });

    await this.refreshOrganizationsList();
    updateBulkStatus(this.elements.organizationsAlert, results, "Delete organizations");
  }

  async addOrganization() {
    const title = this.elements.organizationTitleInput.value.trim();
    const slug = this.elements.organizationSlugInput.value.trim();

    if (!title || !slug) {
      UiHelpers.showAlert(this.elements.organizationsAlert, "Title and slug are required.", "error");
      return;
    }

    try {
      const { response, data, rawText } = await this.api.request("/admin/add-organization", {
        method: "POST",
        body: { name: title, slug },
      });

      if (!response.ok) {
        throw new Error(data?.error || rawText || "Failed to add organization");
      }

      UiHelpers.showAlert(this.elements.organizationsAlert, "Organization added.", "success");
      this.elements.organizationTitleInput.value = "";
      this.elements.organizationSlugInput.value = "";
      await this.refreshOrganizationsList();
    } catch (error) {
      UiHelpers.showAlert(this.elements.organizationsAlert, `Error: ${error.message}`, "error");
    }
  }

  async deleteOrganization(organizationId) {
    if (!confirm(`Delete organization ${organizationId}?`)) return;

    try {
      const { response, data, rawText } = await this.api.request("/admin/delete-organization", {
        method: "POST",
        body: { organization_id: organizationId },
      });

      if (!response.ok) {
        throw new Error(data?.error || rawText || "Failed to delete organization");
      }

      UiHelpers.showAlert(this.elements.organizationsAlert, "Organization deleted.", "success");
      await this.refreshOrganizationsList();
    } catch (error) {
      UiHelpers.showAlert(this.elements.organizationsAlert, `Error: ${error.message}`, "error");
    }
  }

  async refreshOrganizationsList() {
    this.elements.organizationsTableContainer.innerHTML = "<div class=\"loading\"></div><p style=\"display:inline;\">Loading organizations...</p>";

    try {
      const { response, data, rawText } = await this.api.request("/admin/organizations", { method: "POST" });
      if (!response.ok) {
        throw new Error(data?.error || rawText || "Failed to load organizations");
      }

      const organizations = Array.isArray(data?.organizations) ? data.organizations : [];
      this.organizations = organizations;
      this.renderOrganizationsTable();
      this.notifySelectionChange();
    } catch (error) {
      this.elements.organizationsTableContainer.innerHTML = `<div class=\"no-data\" style=\"color:red;\">Error loading organizations: ${UiHelpers.escapeHtml(error.message)}</div>`;
    }
  }
}

export { OrganizationsSection };
