import { UiHelpers } from "./domUtils.js";
import { SortHelpers } from "./sortUtils.js";
import { runSequential, updateBulkStatus } from "./actions.js";

class KeysSection {
  constructor(api, elements) {
    this.api = api;
    this.elements = elements;
    this.authLevel = 0;
    this.issueOrganizations = [];
    this.issueProjects = [];
    this.selectedOrganizationScopeId = null;
    this.selectedIssueProjectIds = new Set();
    this.keys = [];
    this.selectedKeyIds = new Set();
    this.sortKey = null;
    this.sortDirection = "asc";
    this.registerEvents();
    this.updateIssueOrganizationUi();
  }

  registerEvents() {
    this.elements.issueKeyBtn?.addEventListener("click", () => this.issueKey());
    this.elements.refreshKeysBtn?.addEventListener("click", () => this.refreshKeysList());
    this.elements.copyIssuedKeyBtn?.addEventListener("click", () => this.copyIssuedKey());
    this.elements.dismissIssuedKeyBtn?.addEventListener("click", () => this.dismissIssuedKey());
    this.elements.selectAllKeysBtn?.addEventListener("click", () => this.selectAllKeys());
    this.elements.deselectAllKeysBtn?.addEventListener("click", () => this.deselectAllKeys());
    this.elements.deleteAllKeysBtn?.addEventListener("click", () => this.deleteAllSelectedKeys());
    this.elements.keyPrivilege?.addEventListener("change", () => this.updateIssueOrganizationUi());
    this.elements.keyOrganizationSelect?.addEventListener("change", () => this.handleIssueOrganizationChange());
    this.elements.keyProjectsList?.addEventListener("change", (event) => {
      const target = event.target;
      if (!target || !target.matches("input[name='issueProjectSelect']")) return;
      const projectId = Number(target.value || 0);
      if (!projectId) return;
      if (target.checked) {
        this.selectedIssueProjectIds.add(projectId);
      } else {
        this.selectedIssueProjectIds.delete(projectId);
      }
    });

    this.elements.keysTableContainer?.addEventListener("change", (event) => {
      const target = event.target;
      if (!target || !target.matches("input[name='keySelect']")) return;
      const keyId = String(target.value || "").trim();
      if (!keyId) return;
      if (target.checked) {
        this.selectedKeyIds.add(keyId);
      } else {
        this.selectedKeyIds.delete(keyId);
      }
    });

    this.elements.keysTableContainer?.addEventListener("click", (event) => {
      const header = event.target.closest("th[data-sort-key]");
      if (header) {
        this.toggleSort(header.dataset.sortKey);
        return;
      }

      const button = event.target.closest("button");
      if (!button) return;
      const action = button.dataset.action;
      const keyId = button.dataset.keyId;
      if (!action || !keyId) return;

      if (action === "disable") {
        this.disableKey(keyId);
      } else if (action === "enable") {
        this.enableKey(keyId);
      } else if (action === "delete") {
        this.deleteKey(keyId);
      }
    });
  }

  setAuthLevel(level) {
    this.authLevel = Number(level || 0);
    this.updateIssueOrganizationUi();
  }

  setOrganizationScope(organizationId) {
    this.selectedOrganizationScopeId = Number(organizationId) || null;
  }

  getIssueSelectedOrganizationId() {
    const value = String(this.elements.keyOrganizationSelect?.value || "").trim();
    if (!value) return null;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }

  async loadIssueOrganizations() {
    try {
      const { response, data, rawText } = await this.api.request("/admin/organizations", { method: "POST" });
      if (!response.ok) {
        throw new Error(data?.error || rawText || "Failed to load organizations");
      }
      this.issueOrganizations = Array.isArray(data?.organizations) ? data.organizations : [];
      this.renderIssueOrganizationsSelect();
      await this.loadIssueProjects();
    } catch (error) {
      UiHelpers.showAlert(this.elements.issueAlert, `Error loading organizations: ${error.message}`, "error");
      this.issueOrganizations = [];
      this.renderIssueOrganizationsSelect();
    }
  }

  renderIssueOrganizationsSelect() {
    const select = this.elements.keyOrganizationSelect;
    if (!select) return;

    const options = ["<option value=\"\">None</option>"];
    for (const org of this.issueOrganizations) {
      options.push(`<option value="${org.organization_id}">${UiHelpers.escapeHtml(org.slug || "-")} (${UiHelpers.escapeHtml(org.name || "-")})</option>`);
    }

    select.innerHTML = options.join("");
    if (this.authLevel >= 1000) {
      select.value = "";
    } else if (this.selectedOrganizationScopeId) {
      select.value = String(this.selectedOrganizationScopeId);
    }
  }

  async loadIssueProjects() {
    const orgId = this.getIssueSelectedOrganizationId() || this.selectedOrganizationScopeId;
    if (!orgId) {
      this.issueProjects = [];
      this.selectedIssueProjectIds.clear();
      this.renderIssueProjectsList();
      return;
    }

    try {
      const { response, data, rawText } = await this.api.request("/admin/projects", {
        method: "POST",
        body: { organization_id: orgId },
      });
      if (!response.ok) {
        throw new Error(data?.error || rawText || "Failed to load projects");
      }

      this.issueProjects = Array.isArray(data?.projects) ? data.projects : [];
      const validProjectIds = new Set(this.issueProjects.map((project) => Number(project.project_id)));
      this.selectedIssueProjectIds = new Set(
        [...this.selectedIssueProjectIds].filter((id) => validProjectIds.has(id))
      );
      this.renderIssueProjectsList();
      this.updateIssueOrganizationUi();
    } catch (error) {
      UiHelpers.showAlert(this.elements.issueAlert, `Error loading projects: ${error.message}`, "error");
      this.issueProjects = [];
      this.selectedIssueProjectIds.clear();
      this.renderIssueProjectsList();
    }
  }

  renderIssueProjectsList() {
    const container = this.elements.keyProjectsList;
    if (!container) return;

    if (!this.issueProjects.length) {
      container.innerHTML = "<div class=\"no-data\" style=\"padding:8px 0; text-align:left;\">No projects available.</div>";
      return;
    }

    container.innerHTML = this.issueProjects
      .map((project) => {
        const projectId = Number(project.project_id);
        const checked = this.selectedIssueProjectIds.has(projectId) ? "checked" : "";
        return `
          <label class="select-radio issue-project-option">
            <input type="checkbox" name="issueProjectSelect" value="${projectId}" ${checked}>
            <span class="radio-dot"></span>
            <span>${UiHelpers.escapeHtml(project.name || "-")} (${UiHelpers.escapeHtml(project.slug || "-")}) • ID: ${UiHelpers.escapeHtml(String(projectId))}</span>
          </label>
        `;
      })
      .join("");
  }

  getSelectedIssueProjectIds() {
    return [...this.selectedIssueProjectIds];
  }

  async handleIssueOrganizationChange() {
    await this.loadIssueProjects();
    this.updateIssueOrganizationUi();
  }

  updateIssueOrganizationUi() {
    const privilege = Number(this.elements.keyPrivilege?.value || 0);
    const isSuperadminKey = privilege >= 1000;
    const canChooseOrg = this.authLevel >= 1000 && !isSuperadminKey;
    const requiresProjects = privilege < 100;

    if (this.elements.keyOrganizationSelect) {
      this.elements.keyOrganizationSelect.disabled = !canChooseOrg;
      if (!canChooseOrg) {
        if (this.selectedOrganizationScopeId) {
          this.elements.keyOrganizationSelect.value = String(this.selectedOrganizationScopeId);
        }
      }
    }

    if (this.elements.issueOrganizationHint) {
      if (isSuperadminKey) {
        this.elements.issueOrganizationHint.textContent = "Superadmin keys are global and must use Organization: None.";
      } else if (this.authLevel >= 1000) {
        this.elements.issueOrganizationHint.textContent = "Choose the organization for non-superadmin keys.";
      } else {
        this.elements.issueOrganizationHint.textContent = "Organization is set from your admin key scope.";
      }
    }

    if (this.elements.keyProjectsList) {
      const checkboxes = Array.from(this.elements.keyProjectsList.querySelectorAll("input[name='issueProjectSelect']"));
      checkboxes.forEach((checkbox) => {
        checkbox.disabled = !requiresProjects;
      });
      this.elements.keyProjectsList.style.opacity = requiresProjects ? "1" : "0.6";

      if (!requiresProjects) {
        this.selectedIssueProjectIds.clear();
        checkboxes.forEach((checkbox) => {
          checkbox.checked = false;
        });
      }
    }

    if (this.elements.issueProjectsHint) {
      if (requiresProjects) {
        this.elements.issueProjectsHint.textContent = "Select one or more projects for user/editor/projectadmin keys in the list below.";
      } else {
        this.elements.issueProjectsHint.textContent = "Admin and superadmin keys get implicit all-project access.";
      }
    }
  }

  toggleSort(sortKey) {
    if (!SortHelpers.toggleSort(this, sortKey)) return;
    this.renderKeysTable();
  }

  getSortIndicator(sortKey) {
    return SortHelpers.getSortIndicator(this, sortKey);
  }

  getSortedKeys() {
    const rows = [...this.keys];
    if (!this.sortKey) return rows;

    const direction = this.sortDirection === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      if (this.sortKey === "username" || this.sortKey === "status" || this.sortKey === "organization") {
        const left = this.sortKey === "organization" ? (a.organization_slug || "-") : (a[this.sortKey] || "");
        const right = this.sortKey === "organization" ? (b.organization_slug || "-") : (b[this.sortKey] || "");
        return SortHelpers.compareText(left, right) * direction;
      }

      if (this.sortKey === "privilege_level") {
        return (Number(a.privilege_level) - Number(b.privilege_level)) * direction;
      }

      if (this.sortKey === "valid_until") {
        const left = Number(a.valid_until) === 0 ? Number.POSITIVE_INFINITY : Number(a.valid_until);
        const right = Number(b.valid_until) === 0 ? Number.POSITIVE_INFINITY : Number(b.valid_until);
        return (left - right) * direction;
      }

      if (this.sortKey === "last_used") {
        return (Number(a.last_used || 0) - Number(b.last_used || 0)) * direction;
      }

      if (this.sortKey === "created_at") {
        return (Number(a.created_at || 0) - Number(b.created_at || 0)) * direction;
      }

      return SortHelpers.compareText(a.id || "", b.id || "") * direction;
    });

    return rows;
  }

  renderKeysTable() {
    if (!this.keys.length) {
      this.selectedKeyIds.clear();
      this.elements.keysTableContainer.innerHTML = "<div class=\"no-data\">No API keys issued yet</div>";
      return;
    }

    const validIds = new Set(this.keys.map((key) => String(key.id || "").trim()).filter(Boolean));
    this.selectedKeyIds = new Set([...this.selectedKeyIds].filter((id) => validIds.has(id)));

    const rows = this.getSortedKeys()
      .map((key) => {
        const keyId = String(key.id || "").trim();
        const isSelected = this.selectedKeyIds.has(keyId);
        const keyIdDisplay = key.id ? String(key.id).substring(0, 8) : "";
        const validUntil = key.valid_until === 0
          ? "Infinite"
          : new Date(key.valid_until * 1000).toLocaleDateString();
        const lastUsed = key.last_used
          ? new Date(key.last_used * 1000).toLocaleDateString()
          : "Never";
        const created = new Date(key.created_at * 1000).toLocaleDateString();
        const status = UiHelpers.escapeHtml(key.status || "");
        const username = UiHelpers.escapeHtml(key.username || "");
        const organizationDisplay = UiHelpers.escapeHtml(key.organization_slug || "-");
        const projectDisplay = Array.isArray(key.project_ids) && key.project_ids.length
          ? UiHelpers.escapeHtml(key.project_ids.join(", "))
          : "All";

        const actions = [];
        if (key.status === "active") {
          actions.push(`<button class=\"danger\" data-action=\"disable\" data-key-id=\"${key.id}\">Disable</button>`);
        }
        if (key.status === "disabled") {
          actions.push(`<button class=\"success\" data-action=\"enable\" data-key-id=\"${key.id}\">Enable</button>`);
        }
        actions.push(`<button class=\"danger\" data-action=\"delete\" data-key-id=\"${key.id}\">Delete</button>`);

        return `
          <tr>
            <td>
              <label class="select-radio">
                <input type="checkbox" name="keySelect" value="${UiHelpers.escapeHtml(keyId)}" ${isSelected ? "checked" : ""}>
                <span class="radio-dot"></span>
              </label>
            </td>
            <td>${UiHelpers.escapeHtml(keyIdDisplay)}</td>
            <td>${username}</td>
            <td>${key.privilege_level}</td>
            <td>${organizationDisplay}</td>
            <td>${projectDisplay}</td>
            <td>${status}</td>
            <td>${validUntil}</td>
            <td>${lastUsed}</td>
            <td>${created}</td>
            <td><div class=\"actions\">${actions.join(" ")}</div></td>
          </tr>
        `;
      })
      .join("");

    this.elements.keysTableContainer.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Select</th>
            <th data-sort-key="id">Key ID ${this.getSortIndicator("id")}</th>
            <th data-sort-key="username">Username ${this.getSortIndicator("username")}</th>
            <th data-sort-key="privilege_level">Privilege ${this.getSortIndicator("privilege_level")}</th>
            <th data-sort-key="organization">Organization ${this.getSortIndicator("organization")}</th>
            <th>Projects</th>
            <th data-sort-key="status">Status ${this.getSortIndicator("status")}</th>
            <th data-sort-key="valid_until">Valid Until ${this.getSortIndicator("valid_until")}</th>
            <th data-sort-key="last_used">Last Used ${this.getSortIndicator("last_used")}</th>
            <th data-sort-key="created_at">Created ${this.getSortIndicator("created_at")}</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    `;
  }

  selectAllKeys() {
    this.keys.forEach((key) => {
      const keyId = String(key.id || "").trim();
      if (keyId) this.selectedKeyIds.add(keyId);
    });
    this.renderKeysTable();
  }

  deselectAllKeys() {
    this.selectedKeyIds.clear();
    this.renderKeysTable();
  }

  async deleteAllSelectedKeys() {
    const ids = [...this.selectedKeyIds];
    if (!ids.length) {
      UiHelpers.showAlert(this.elements.issueAlert, "No keys selected", "error");
      return;
    }

    if (!confirm(`Delete ${ids.length} selected key(s)? This cannot be undone.`)) return;

    const results = await runSequential(ids, async (keyId) => {
      const { response, data, rawText } = await this.api.request("/admin/delete-key", {
        method: "POST",
        body: { key_id: keyId },
      });
      if (!response.ok) {
        throw new Error(data?.error || rawText || "Failed to delete key");
      }
    });

    this.selectedKeyIds.clear();
    await this.refreshKeysList();
    updateBulkStatus(this.elements.issueAlert, results, "Delete keys");
  }

  async issueKey() {
    const username = this.elements.keyUsername.value.trim();
    const privilege = Number(this.elements.keyPrivilege.value);
    const validDays = Number(this.elements.keyValidDays.value) || 0;
    const validUntilUnix = validDays > 0
      ? Math.floor(Date.now() / 1000) + validDays * 86400
      : 0;
    const selectedOrganizationId = this.getIssueSelectedOrganizationId();
    const selectedProjectIds = this.getSelectedIssueProjectIds();

    if (!username) {
      UiHelpers.showAlert(this.elements.issueAlert, "Please enter username", "error");
      return;
    }

    if (this.authLevel >= 1000 && privilege < 1000 && !selectedOrganizationId) {
      UiHelpers.showAlert(this.elements.issueAlert, "Please select an organization for non-superadmin key.", "error");
      return;
    }

    if (privilege < 100 && selectedProjectIds.length === 0) {
      UiHelpers.showAlert(this.elements.issueAlert, "Select at least one project for user/editor/projectadmin key.", "error");
      return;
    }

    try {
      const payload = {
        username,
        privilege_level: privilege,
        valid_until_unix: validUntilUnix,
        project_ids: privilege < 100 ? selectedProjectIds : [],
      };

      if (this.authLevel >= 1000 && privilege < 1000) {
        payload.organization_id = selectedOrganizationId;
      }

      const { response, data, rawText } = await this.api.request("/admin/issue-key", {
        method: "POST",
        body: payload,
      });

      if (!response.ok) {
        UiHelpers.showAlert(this.elements.issueAlert, `Error: ${data?.error || rawText}`, "error");
        return;
      }

      UiHelpers.showAlert(this.elements.issueAlert, "API key issued successfully!", "success");
      this.elements.issuedKeyValue.textContent = data.api_key;
      UiHelpers.toggleDisplay(this.elements.issuedKeyDisplay, true);
      this.elements.keyUsername.value = "";
      this.elements.keyValidDays.value = "0";
      this.selectedIssueProjectIds.clear();
      this.renderIssueOrganizationsSelect();
      this.renderIssueProjectsList();
      this.updateIssueOrganizationUi();
      await this.refreshKeysList();
    } catch (error) {
      UiHelpers.showAlert(this.elements.issueAlert, `Error: ${error.message}`, "error");
    }
  }

  copyIssuedKey() {
    const text = this.elements.issuedKeyValue.textContent;
    if (!text) return;
    navigator.clipboard.writeText(text);
  }

  dismissIssuedKey() {
    UiHelpers.toggleDisplay(this.elements.issuedKeyDisplay, false);
  }

  async refreshKeysList() {
    this.elements.keysTableContainer.innerHTML = "<div class=\"loading\"></div><p style=\"display:inline;\">Loading keys...</p>";

    try {
      const { response, data, rawText } = await this.api.request("/admin/keys", { method: "POST" });
      if (!response.ok) throw new Error(data?.error || rawText || "Failed to load keys");

      const keys = Array.isArray(data?.keys) ? data.keys : [];
      this.keys = keys;
      this.renderKeysTable();
    } catch (error) {
      this.elements.keysTableContainer.innerHTML = `<div class=\"no-data\" style=\"color:red;\">Error loading keys: ${UiHelpers.escapeHtml(error.message)}</div>`;
    }
  }

  async disableKey(keyId) {
    if (!confirm("Disable this API key?")) return;

    try {
      const { response, data, rawText } = await this.api.request("/admin/disable-key", {
        method: "POST",
        body: { key_id: keyId },
      });

      if (!response.ok) {
        throw new Error(data?.error || rawText || "Failed to disable key");
      }

      await this.refreshKeysList();
    } catch (error) {
      alert(`Error: ${error.message}`);
    }
  }

  async enableKey(keyId) {
    if (!confirm("Enable this API key?")) return;

    try {
      const { response, data, rawText } = await this.api.request("/admin/enable-key", {
        method: "POST",
        body: { key_id: keyId },
      });

      if (!response.ok) {
        throw new Error(data?.error || rawText || "Failed to enable key");
      }

      await this.refreshKeysList();
    } catch (error) {
      alert(`Error: ${error.message}`);
    }
  }

  async deleteKey(keyId) {
    if (!confirm("Delete this API key? This cannot be undone.")) return;

    try {
      const { response, data, rawText } = await this.api.request("/admin/delete-key", {
        method: "POST",
        body: { key_id: keyId },
      });

      if (!response.ok) {
        throw new Error(data?.error || rawText || "Failed to delete key");
      }

      await this.refreshKeysList();
    } catch (error) {
      alert(`Error: ${error.message}`);
    }
  }
}

export { KeysSection };
