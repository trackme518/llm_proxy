import { UiHelpers } from "./domUtils.js";
import { SortHelpers } from "./sortUtils.js";
import { runSequential, updateBulkStatus } from "./actions.js";

const toSlug = (value) => String(value || "")
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "")
  .slice(0, 120);

const truncateText = (value, maxLen = 90) => {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}...`;
};

class ProjectsSection {
  constructor(api, elements) {
    this.api = api;
    this.elements = elements;
    this.projects = [];
    this.organizationId = null;
    this.organizationFilterIds = new Set();
    this.availableOrganizations = [];
    this.selectedProjectIds = new Set();
    this.onSelectionChange = null;
    this.onProjectsChange = null;
    this.authLevel = 0;
    this.sortKey = null;
    this.sortDirection = "asc";
    this.editingProjectId = null;
    this.registerEvents();
    this.updatePrimaryActionButtonLabel();
  }

  registerEvents() {
    this.elements.addProjectBtn?.addEventListener("click", () => this.addProject());
    this.elements.clearProjectBtn?.addEventListener("click", () => this.clearProjectForm());
    this.elements.refreshProjectsBtn?.addEventListener("click", () => this.refreshProjectsList());
    this.elements.selectAllProjectsBtn?.addEventListener("click", () => this.selectAllProjects());
    this.elements.deselectAllProjectsBtn?.addEventListener("click", () => this.deselectAllProjects());
    this.elements.deleteAllProjectsBtn?.addEventListener("click", () => this.deleteAllSelectedProjects());

    this.elements.projectOrganizationSelect?.addEventListener("change", () => {
      this.organizationId = Number(this.elements.projectOrganizationSelect.value || 0) || null;
    });

    this.elements.projectsTableContainer?.addEventListener("change", (event) => {
      const target = event.target;
      if (!target || !target.matches("input[name='projectSelect']")) return;
      const projectId = Number(target.value || 0);
      if (!projectId) return;
      if (target.checked) {
        this.selectedProjectIds.add(projectId);
      } else {
        this.selectedProjectIds.delete(projectId);
      }
      this.notifySelectionChange();
    });

    this.elements.projectsTableContainer?.addEventListener("click", (event) => {
      const header = event.target.closest("th[data-sort-key]");
      if (header) {
        this.toggleSort(header.dataset.sortKey);
        return;
      }

      const button = event.target.closest("button[data-project-id]");
      if (!button) return;
      const projectId = Number(button.dataset.projectId || 0);
      if (!projectId) return;

      const action = button.dataset.action || "delete";
      if (action === "edit") {
        this.editProject(projectId);
        return;
      }

      this.deleteProject(projectId);
    });
  }

  setOrganizationScope(organizationId) {
    this.organizationId = Number(organizationId) || null;
    if (this.elements.projectOrganizationSelect) {
      this.elements.projectOrganizationSelect.value = this.organizationId ? String(this.organizationId) : "";
    }
  }

  setAuthLevel(level) {
    this.authLevel = Number(level || 0);
    this.renderProjectOrganizationOptions();
  }

  setAvailableOrganizations(organizations) {
    this.availableOrganizations = Array.isArray(organizations) ? organizations : [];
    this.renderProjectOrganizationOptions();
  }

  setOrganizationFilter(organizationIds) {
    const list = Array.isArray(organizationIds) ? organizationIds : [];
    this.organizationFilterIds = new Set(list.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0));
  }

  setSelectionChangeHandler(handler) {
    this.onSelectionChange = typeof handler === "function" ? handler : null;
  }

  setProjectsChangeHandler(handler) {
    this.onProjectsChange = typeof handler === "function" ? handler : null;
  }

  setSelectedProjects(ids, notify = true) {
    const list = Array.isArray(ids) ? ids : [];
    this.selectedProjectIds = new Set(list.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0));
    this.renderProjectsTable();
    if (notify) {
      this.notifySelectionChange();
    }
  }

  notifySelectionChange() {
    if (!this.onSelectionChange) return;
    this.onSelectionChange([...this.selectedProjectIds]);
  }

  notifyProjectsChange() {
    if (!this.onProjectsChange) return;
    this.onProjectsChange([...this.projects]);
  }

  updatePrimaryActionButtonLabel() {
    if (!this.elements.addProjectBtn) return;
    this.elements.addProjectBtn.textContent = this.editingProjectId ? "Update" : "Add";
  }

  clearProjectForm() {
    this.editingProjectId = null;
    if (this.elements.projectTitleInput) {
      this.elements.projectTitleInput.value = "";
    }
    if (this.elements.projectDescriptionInput) {
      this.elements.projectDescriptionInput.value = "";
    }
    this.updatePrimaryActionButtonLabel();
  }

  renderProjectOrganizationOptions() {
    const select = this.elements.projectOrganizationSelect;
    if (!select) return;

    select.innerHTML = this.availableOrganizations
      .map((org) => `<option value="${org.organization_id}">${UiHelpers.escapeHtml(org.slug || "-")} (${UiHelpers.escapeHtml(org.name || "-")})</option>`)
      .join("");

    if (!this.organizationId && this.availableOrganizations.length > 0) {
      this.organizationId = Number(this.availableOrganizations[0].organization_id);
    }

    if (this.organizationId) {
      select.value = String(this.organizationId);
    }

    if (this.authLevel >= 1000) {
      select.disabled = false;
    } else {
      select.disabled = true;
    }
  }

  toggleSort(sortKey) {
    if (!SortHelpers.toggleSort(this, sortKey)) return;
    this.renderProjectsTable();
  }

  getSortIndicator(sortKey) {
    return SortHelpers.getSortIndicator(this, sortKey);
  }

  getSortedProjects() {
    if (!this.sortKey) return [...this.projects];
    const direction = this.sortDirection === "asc" ? 1 : -1;
    return [...this.projects].sort((a, b) => {
      if (this.sortKey === "organization_id" || this.sortKey === "project_id" || this.sortKey === "document_count") {
        return (Number(a[this.sortKey]) - Number(b[this.sortKey])) * direction;
      }
      return SortHelpers.compareText(a[this.sortKey], b[this.sortKey]) * direction;
    });
  }

  renderProjectsTable() {
    if (!this.projects.length) {
      this.selectedProjectIds.clear();
      this.elements.projectsTableContainer.innerHTML = "<div class=\"no-data\">No projects found</div>";
      return;
    }

    const validIds = new Set(this.projects.map((project) => Number(project.project_id)));
    this.selectedProjectIds = new Set([...this.selectedProjectIds].filter((id) => validIds.has(id)));

    const rows = this.getSortedProjects().map((project) => `
      <tr>
        <td>
          <label class="select-radio">
            <input type="checkbox" name="projectSelect" value="${project.project_id}" ${this.selectedProjectIds.has(Number(project.project_id)) ? "checked" : ""}>
            <span class="radio-dot"></span>
          </label>
        </td>
        <td>${UiHelpers.escapeHtml(project.name || "")}</td>
        <td title="${UiHelpers.escapeHtml(project.description || "")}">${UiHelpers.escapeHtml(truncateText(project.description || ""))}</td>
        <td>${Number(project.document_count || 0)}</td>
        <td>${project.project_id}</td>
        <td>${project.organization_id}</td>
        <td>
          <button class="secondary" data-action="edit" data-project-id="${project.project_id}">Edit</button>
          <button class="danger" data-action="delete" data-project-id="${project.project_id}">Delete</button>
        </td>
      </tr>
    `).join("");

    this.elements.projectsTableContainer.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Select</th>
            <th data-sort-key="name">Title ${this.getSortIndicator("name")}</th>
            <th data-sort-key="description">Description</th>
            <th data-sort-key="document_count">Docs ${this.getSortIndicator("document_count")}</th>
            <th data-sort-key="project_id">Project ID ${this.getSortIndicator("project_id")}</th>
            <th data-sort-key="organization_id">Organization ID ${this.getSortIndicator("organization_id")}</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;

  }

  selectAllProjects() {
    this.projects.forEach((project) => {
      const id = Number(project.project_id);
      if (id > 0) this.selectedProjectIds.add(id);
    });
    this.renderProjectsTable();
    this.notifySelectionChange();
  }

  deselectAllProjects() {
    this.selectedProjectIds.clear();
    this.renderProjectsTable();
    this.notifySelectionChange();
  }

  async deleteAllSelectedProjects() {
    const ids = [...this.selectedProjectIds];
    if (!ids.length) {
      UiHelpers.showAlert(this.elements.projectsAlert, "No projects selected", "error");
      return;
    }

    if (!confirm(`Delete ${ids.length} selected project(s)?`)) return;

    const results = await runSequential(ids, async (projectId) => {
      const { response, data, rawText } = await this.api.request("/admin/delete-project", {
        method: "POST",
        body: { project_id: projectId },
      });
      if (!response.ok) {
        throw new Error(data?.error || rawText || "Failed to delete project");
      }
    });

    await this.refreshProjectsList();
    updateBulkStatus(this.elements.projectsAlert, results, "Delete projects");
  }

  async addProject() {
    const title = this.elements.projectTitleInput.value.trim();
    const description = this.elements.projectDescriptionInput?.value?.trim() || "";

    if (!title) {
      UiHelpers.showAlert(this.elements.projectsAlert, "Title is required.", "error");
      return;
    }

    try {
      if (this.editingProjectId) {
        const { response, data, rawText } = await this.api.request("/admin/update-project", {
          method: "POST",
          body: {
            project_id: this.editingProjectId,
            name: title,
            description,
          },
        });

        if (!response.ok) {
          throw new Error(data?.error || rawText || "Failed to update project");
        }

        UiHelpers.showAlert(this.elements.projectsAlert, "Project updated.", "success");
      } else {
        const body = { name: title, slug: toSlug(title), description };
        if (this.organizationId) {
          body.organization_id = this.organizationId;
        }

        const { response, data, rawText } = await this.api.request("/admin/add-project", {
          method: "POST",
          body,
        });

        if (!response.ok) {
          throw new Error(data?.error || rawText || "Failed to add project");
        }

        UiHelpers.showAlert(this.elements.projectsAlert, "Project added.", "success");
      }

      this.clearProjectForm();
      await this.refreshProjectsList();
    } catch (error) {
      UiHelpers.showAlert(this.elements.projectsAlert, `Error: ${error.message}`, "error");
    }
  }

  async editProject(projectId) {
    const project = this.projects.find((item) => Number(item.project_id) === Number(projectId));
    if (!project) {
      UiHelpers.showAlert(this.elements.projectsAlert, "Project not found.", "error");
      return;
    }

    this.editingProjectId = Number(project.project_id);
    this.organizationId = Number(project.organization_id || 0) || this.organizationId;

    if (this.elements.projectOrganizationSelect && this.organizationId) {
      this.elements.projectOrganizationSelect.value = String(this.organizationId);
    }

    if (this.elements.projectTitleInput) {
      this.elements.projectTitleInput.value = String(project.name || "");
      this.elements.projectTitleInput.focus();
    }

    if (this.elements.projectDescriptionInput) {
      this.elements.projectDescriptionInput.value = String(project.description || "");
    }

    this.updatePrimaryActionButtonLabel();
    UiHelpers.showAlert(this.elements.projectsAlert, `Editing project ${project.project_id}. Update fields and click Update, or Clear to cancel.`, "success");
  }

  async deleteProject(projectId) {
    if (!confirm(`Delete project ${projectId}?`)) return;

    try {
      const { response, data, rawText } = await this.api.request("/admin/delete-project", {
        method: "POST",
        body: { project_id: projectId },
      });

      if (!response.ok) {
        throw new Error(data?.error || rawText || "Failed to delete project");
      }

      UiHelpers.showAlert(this.elements.projectsAlert, "Project deleted.", "success");
      if (Number(this.editingProjectId) === Number(projectId)) {
        this.clearProjectForm();
      }
      await this.refreshProjectsList();
    } catch (error) {
      UiHelpers.showAlert(this.elements.projectsAlert, `Error: ${error.message}`, "error");
    }
  }

  async refreshProjectsList() {
    this.elements.projectsTableContainer.innerHTML = "<div class=\"loading\"></div><p style=\"display:inline;\">Loading projects...</p>";

    try {
      const organizationsToLoad = this.organizationFilterIds.size > 0
        ? [...this.organizationFilterIds]
        : (this.organizationId ? [this.organizationId] : []);

      if (organizationsToLoad.length === 0) {
        this.projects = [];
        this.renderProjectsTable();
        return;
      }

      const allProjects = [];
      for (const organizationId of organizationsToLoad) {
        const { response, data, rawText } = await this.api.request("/admin/projects", {
          method: "POST",
          body: { organization_id: organizationId },
        });
        if (!response.ok) {
          throw new Error(data?.error || rawText || "Failed to load projects");
        }
        const orgProjects = Array.isArray(data?.projects) ? data.projects : [];
        allProjects.push(...orgProjects);
      }

      const dedup = new Map();
      allProjects.forEach((project) => {
        const id = Number(project.project_id);
        if (!dedup.has(id)) dedup.set(id, project);
      });

      this.projects = [...dedup.values()];
      if (this.editingProjectId) {
        const editingStillExists = this.projects.some((project) => Number(project.project_id) === Number(this.editingProjectId));
        if (!editingStillExists) {
          this.clearProjectForm();
        }
      }
      this.renderProjectsTable();
      this.notifySelectionChange();
      this.notifyProjectsChange();
    } catch (error) {
      this.elements.projectsTableContainer.innerHTML = `<div class="no-data" style="color:red;">Error loading projects: ${UiHelpers.escapeHtml(error.message)}</div>`;
    }
  }
}

export { ProjectsSection };
