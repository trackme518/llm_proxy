import { UiHelpers, TabManager } from "./domUtils.js";
import { SortHelpers } from "./sortUtils.js";
import { runSequential, updateBulkStatus } from "./actions.js";
import { extractTextFromPdfArrayBuffer } from "./pdf.js";

class DocumentSection {
  constructor(api, elements) {
    this.api = api;
    this.elements = elements;
    this.documents = [];
    this.filteredDocuments = [];
    this.sortKey = null;
    this.sortDirection = "asc";
    this.selectedDocument = null;
    this.selectedDocumentIds = new Set();
    this.documentIds = new Set();
    this.availableOrganizations = [];
    this.availableProjects = [];
    this.filterProjectIds = new Set();
    this.formProjectIds = new Set();
    this.selectedOrganizationIds = new Set();
    this.mode = "upload";
    this.authLevel = 0;
    this.mammothLoader = null;
    this.subTabs = new TabManager(elements.documentTabs, (tabId) => this.switchSubTab(tabId));
    this.registerEvents();
  
    this.updateOverlapVisibility();
    this.updateOverlapLabel();
  }

  registerEvents() {
    this.elements.documentProjectFilter?.addEventListener("change", event => {
      const input = event.target.closest("input[name=projectFilter]");
      if (!input) return;
      if (input.checked) this.filterProjectIds.add(Number(input.value));
      else this.filterProjectIds.delete(Number(input.value));
      this.applyFilters();
    });
    this.elements.clearDocumentProjectFilter?.addEventListener("click", () => {
      this.filterProjectIds.clear();
      this.renderProjectOptions();
      this.applyFilters();
    });
    this.elements.documentProjectsList?.addEventListener("change", event => {
      const input = event.target.closest("input[name=documentProject]");
      if (!input) return;
      if (input.checked) this.formProjectIds.add(Number(input.value));
      else this.formProjectIds.delete(Number(input.value));
      this.renderProjectOptions();
      this.elements.documentProjectsList.querySelector(`input[value="${Number(input.value)}"]`)?.focus();
    });
    this.elements.modifyDocumentSelect?.addEventListener("change", () => {
      const id = Number(this.elements.modifyDocumentSelect.value);
      if (id) this.selectDocumentById(id);
      else {
        this.selectedDocument = null;
        this.clearForm();
        this.setMode("modify");
      }
    });
    this.elements.chunkingStrategy?.addEventListener("change", () => this.updateOverlapVisibility());
    this.elements.chunkOverlapPercent?.addEventListener("input", () => this.updateOverlapLabel());
    this.elements.chunkMaxChars?.addEventListener("blur", () => this.normalizeChunkMaxChars());
    this.elements.docFile?.addEventListener("change", (event) => this.handleFileChange(event));
    this.elements.convertPdfToMdBtn?.addEventListener("click", () => this.convertSelectedPdfToMarkdown());
    this.elements.uploadBtn?.addEventListener("click", () => this.handleUpload("upload"));
    this.elements.updateMetadataBtn?.addEventListener("click", () => this.handleUpload("metadata"));
    this.elements.updateContentBtn?.addEventListener("click", () => this.handleUpload("content"));
    this.elements.refreshDocsBtn?.addEventListener("click", () => this.fetchDocuments());
    this.elements.selectAllDocsBtn?.addEventListener("click", () => this.selectAllDocuments());
    this.elements.deselectAllDocsBtn?.addEventListener("click", () => this.deselectAllDocuments());
    this.elements.deleteAllDocsBtn?.addEventListener("click", () => this.deleteAllSelectedDocuments());
    this.elements.embeddingsAllDocsBtn?.addEventListener("click", () => this.recalculateAllSelectedDocuments());

    this.elements.documentsTableBody?.addEventListener("change", (event) => {
      const target = event.target;
      if (target && target.matches("input[name='docSelect']")) {
        const id = Number(target.value);
        if (target.checked) {
          this.selectedDocumentIds.add(id);
        } else {
          this.selectedDocumentIds.delete(id);
        }
      }
    });

    this.elements.documentsTableBody?.addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button) return;

      const editId = button.dataset.editId;
      const recalcId = button.dataset.recalcId;
      const deleteId = button.dataset.deleteId;

      if (editId) {
        this.selectedDocumentIds.clear();
        this.selectedDocumentIds.add(Number(editId));
        this.selectDocumentById(Number(editId));
        this.renderDocumentsTable();
      }

      if (recalcId) {
        this.recalculateEmbeddings(Number(recalcId));
      }

      if (deleteId) {
        this.deleteDocument(Number(deleteId));
      }
    });

    const documentsTable = this.elements.documentsTableBody?.closest("table");
    documentsTable?.querySelector("thead")?.addEventListener("click", (event) => {
      const header = event.target.closest("th[data-sort-key]");
      if (!header) return;
      this.toggleSort(header.dataset.sortKey);
    });
  }

  toggleSort(sortKey) {
    if (!SortHelpers.toggleSort(this, sortKey)) return;
    this.renderDocumentsTable();
  }

  getSortIndicator(sortKey) {
    return SortHelpers.getSortIndicator(this, sortKey);
  }

  getSortedDocuments() {
    if (!this.sortKey) return [...this.filteredDocuments];
    const direction = this.sortDirection === "asc" ? 1 : -1;
    const sorted = [...this.filteredDocuments].sort((a, b) => {
      if (this.sortKey === "document_id") {
        return (Number(a.document_id) - Number(b.document_id)) * direction;
      }
      if (this.sortKey === "title") {
        return SortHelpers.compareText(a.title, b.title) * direction;
      }
      if (this.sortKey === "author") {
        return SortHelpers.compareText(a.author, b.author) * direction;
      }
      if (this.sortKey === "organization_slug") {
        return SortHelpers.compareText(a.organization_slug || "-", b.organization_slug || "-") * direction;
      }
      return 0;
    });
    return sorted;
  }

  renderDocumentHeaderSortIndicators() {
    const documentsTable = this.elements.documentsTableBody?.closest("table");
    SortHelpers.updateHeaderIndicators(documentsTable, this);
  }

  switchSubTab(tabId) {
    const isForm = tabId !== "listTab";
    if (isForm) {
      const mode = tabId === "modifyTab" ? "modify" : "upload";
      if (mode !== this.mode) {
        this.clearForm();
        if (mode === "modify" && this.selectedDocument) this.populateForm(this.selectedDocument);
        UiHelpers.setStatus(this.elements.uploadStatus, "");
      }
      this.setMode(mode);
    }
    UiHelpers.toggleDisplay(this.elements.uploadTab, isForm);
    UiHelpers.toggleDisplay(this.elements.listTab, !isForm);
    this.elements.uploadTab?.classList.toggle("active", isForm);
    this.elements.listTab?.classList.toggle("active", !isForm);
  }

  setMode(mode) {
    this.mode = mode;
    const isModify = mode === "modify";
    UiHelpers.toggleDisplay(this.elements.modifyDocumentGroup, isModify);
    UiHelpers.toggleDisplay(this.elements.uploadProjectGroup, !isModify || !!this.selectedDocument);
    this.renderProjectOptions();
    UiHelpers.toggleDisplay(this.elements.documentFields, !isModify || !!this.selectedDocument);
    this.elements.modifyDocumentSelect.value = this.selectedDocument ? String(this.selectedDocument.document_id) : "";
    UiHelpers.toggleDisplay(this.elements.selectedDocInfo, isModify && !!this.selectedDocument);
    if (isModify && this.selectedDocument) {
      this.elements.selectedDocInfo.textContent = `Editing document ID ${this.selectedDocument.document_id}: ${this.selectedDocument.title || "(untitled)"}`;
    }
    this.elements.uploadHeading.textContent = isModify ? "Modify Document" : "Upload Document";
    this.elements.uploadDescription.textContent = isModify
      ? "Update metadata or content for the selected document."
      : "The server will automatically generate the document ID. Provide all metadata about your document.";

    UiHelpers.toggleDisplay(this.elements.uploadBtn, !isModify);
    UiHelpers.toggleDisplay(this.elements.updateMetadataBtn, isModify);
    UiHelpers.toggleDisplay(this.elements.updateContentBtn, isModify);

    if (!isModify) {
      UiHelpers.toggleDisplay(this.elements.selectedDocInfo, false);
    }
  }

  clearForm() {
    this.formProjectIds.clear();
    this.renderProjectOptions();
    this.elements.title.value = "";
    this.elements.author.value = "";
    this.elements.summary.value = "";
    this.elements.domain.value = "";
    this.elements.keywords.value = "";
    this.elements.datePublished.value = "";
    this.elements.language.value = "";
    this.elements.chunkingStrategy.value = "semantic";
    this.elements.chunkMaxChars.value = "1000";
    if (this.elements.chunkOverlapPercent) {
      this.elements.chunkOverlapPercent.value = "50";
      this.updateOverlapLabel();
    }
    this.updateOverlapVisibility();
    this.elements.docText.value = "";
    this.elements.docFile.value = "";
    UiHelpers.setStatus(this.elements.fileStatus, "");
  }

  populateForm(doc) {
    this.formProjectIds = new Set(this.getDocumentProjectIds(doc));
    this.renderProjectOptions();
    this.elements.title.value = doc.title || "";
    this.elements.author.value = doc.author || "";
    this.elements.summary.value = doc.summary || "";
    this.elements.domain.value = doc.domain || "";
    this.elements.keywords.value = this.normalizeKeywords(doc.keywords).join(", ");
    this.elements.datePublished.value = doc.date_published ? String(doc.date_published).slice(0, 10) : "";
    this.elements.language.value = doc.language || "";
    this.elements.chunkingStrategy.value = doc.chunking_strategy || "semantic";
    this.elements.chunkMaxChars.value = doc.chunk_max_chars ? String(doc.chunk_max_chars) : "1000";

    if (doc.chunking_strategy === "fixed") {
      const effectiveMax = doc.chunk_max_chars || 1000;
      const percent = doc.chunk_overlap_chars ? Math.round((doc.chunk_overlap_chars / effectiveMax) * 100) : 0;
      const clamped = this.clampOverlapPercent(percent);
      if (this.elements.chunkOverlapPercent) {
        this.elements.chunkOverlapPercent.value = String(clamped);
        this.updateOverlapLabel();
      }
    }

    this.updateOverlapVisibility();
    this.elements.docText.value = doc.content || "";
  }

  selectDocumentById(id) {
    const doc = this.documents.find((item) => Number(item.document_id) === id);
    if (!doc) return;
    this.selectedDocument = doc;
    this.clearForm();
    this.populateForm(doc);
    this.elements.selectedDocInfo.textContent = `Editing document ID ${doc.document_id}: ${doc.title || "(untitled)"}`;
    this.elements.selectedDocInfo.className = "status success";
    UiHelpers.toggleDisplay(this.elements.selectedDocInfo, true);
    this.setMode("modify");
    this.subTabs.activate("modifyTab");
  }

  clearSelection() {
    this.selectedDocument = null;
    this.clearForm();
    this.setMode(this.mode);
  }

  updateOverlapVisibility() {
    const isFixed = this.elements.chunkingStrategy.value === "fixed";
    UiHelpers.toggleDisplay(this.elements.chunkOverlapGroup, isFixed);
  }

  updateOverlapLabel() {
    if (!this.elements.chunkOverlapLabel || !this.elements.chunkOverlapPercent) return;
    const clamped = this.clampOverlapPercent(this.elements.chunkOverlapPercent.value);
    this.elements.chunkOverlapPercent.value = String(clamped);
    this.elements.chunkOverlapLabel.textContent = `${clamped}%`;
  }

  normalizeChunkMaxChars() {
    const clamped = this.clampChunkMaxChars(this.elements.chunkMaxChars.value.trim());
    this.elements.chunkMaxChars.value = clamped === null ? "" : String(clamped);
  }

  clampChunkMaxChars(value) {
    if (value === null || value === undefined || value === "") return null;
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    return Math.min(4096, Math.max(100, Math.floor(num)));
  }

  clampOverlapPercent(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    return Math.min(50, Math.max(0, Math.floor(num)));
  }

  trimText(value, max = 25) {
    if (!value) return "-";
    const text = String(value);
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }

  isHttpUrl(value) {
    const text = String(value || "").trim();
    if (!text) return false;
    try {
      const parsed = new URL(text);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }

  renderDomainCellContent(value) {
    const text = String(value || "").trim();
    if (!text) return "-";

    const label = UiHelpers.escapeHtml(this.trimText(text, 40));
    if (!this.isHttpUrl(text)) {
      return label;
    }

    const href = UiHelpers.escapeHtml(text);
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  }

  parsePositiveInt(value) {
    const num = Number(value);
    return Number.isInteger(num) && num > 0 ? num : null;
  }

  normalizeKeywords(value) {
    const source = Array.isArray(value)
      ? value
      : typeof value === "string"
        ? [value]
        : [];

    return source
      .flatMap((entry) => String(entry).split(/[|,;\n]+/))
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  getDocumentProjectIds(doc) {
    return (Array.isArray(doc.project_ids) ? doc.project_ids : [doc.project_id]).map(Number).filter(id => id > 0);
  }

  renderProjectOptions() {
    const visibleProjects = this.availableProjects.filter(project =>
      !this.selectedOrganizationIds.size || this.selectedOrganizationIds.has(Number(project.organization_id)));
    const validIds = new Set(visibleProjects.map(project => Number(project.project_id)));
    if (this.mode === "upload") this.formProjectIds = new Set([...this.formProjectIds].filter(id => validIds.has(id)));
    this.filterProjectIds = new Set([...this.filterProjectIds].filter(id => validIds.has(id)));
    const selectedProject = this.availableProjects.find(project => this.formProjectIds.has(Number(project.project_id)));
    const organizationId = this.mode === "modify" && this.selectedDocument
      ? Number(this.selectedDocument.organization_id)
      : selectedProject ? Number(selectedProject.organization_id) : null;
    const render = (projects, selected, name, lockOrganization) => projects.length
      ? projects.map(project => {
        const id = Number(project.project_id);
        const disabled = lockOrganization && organizationId && Number(project.organization_id) !== organizationId;
        const org = this.availableOrganizations.find(org => Number(org.organization_id) === Number(project.organization_id));
        const label = project.name || project.title || project.slug || "Project";
        return `<label class="project-selection-row ${disabled ? "is-disabled" : ""}">
          <span class="select-radio"><input type="checkbox" name="${name}" value="${id}" ${selected.has(id) ? "checked" : ""} ${disabled ? "disabled" : ""}><span class="radio-dot"></span></span>
          <span>${UiHelpers.escapeHtml(label)} <small>#${id}${org ? ` · ${UiHelpers.escapeHtml(org.name || org.slug || "")}` : ""}</small></span>
        </label>`;
      }).join("")
      : '<p class="project-selection-hint">No projects available.</p>';
    this.elements.documentProjectFilter.innerHTML = render(visibleProjects, this.filterProjectIds, "projectFilter", false);
    const formProjects = this.mode === "modify" && this.selectedDocument
      ? this.availableProjects.filter(project => Number(project.organization_id) === Number(this.selectedDocument.organization_id))
      : visibleProjects;
    this.elements.documentProjectsList.innerHTML = render(formProjects, this.formProjectIds, "documentProject", true);
  }

  selectedFormProjectIds() {
    return [...this.elements.documentProjectsList.querySelectorAll("input[name=documentProject]:checked")].map(input => Number(input.value));
  }

  renderDocumentOptions() {
    const select = this.elements.modifyDocumentSelect;
    select.innerHTML = '<option value="">Select a document</option>' + this.documents.map((doc) =>
      `<option value="${Number(doc.document_id)}">${UiHelpers.escapeHtml(doc.title || "Untitled")} (#${Number(doc.document_id)})</option>`
    ).join("");
    if (this.selectedDocument) {
      this.selectedDocument = this.documents.find((doc) => Number(doc.document_id) === Number(this.selectedDocument.document_id)) || null;
      if (!this.selectedDocument) this.clearForm();
    }
    this.setMode(this.mode);
  }

  setScopeOptions({ organizations, projects, authLevel }) {
    this.availableOrganizations = Array.isArray(organizations) ? organizations : [];
    this.availableProjects = Array.isArray(projects) ? projects : [];
    this.authLevel = Number(authLevel || 0);
    this.renderProjectOptions();
    this.applyFilters();
  }

  setScopeSelection({ organizationIds }) {
    this.selectedOrganizationIds = new Set(Array.isArray(organizationIds) ? organizationIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0) : []);
    this.renderProjectOptions();
    this.applyFilters();
  }

  applyFilters() {
    const filtered = this.documents.filter((doc) => {
      const projectIds = this.getDocumentProjectIds(doc);
      const organizationId = Number(doc.organization_id);
      const orgMatch = this.selectedOrganizationIds.size === 0 || this.selectedOrganizationIds.has(organizationId);
      const projectMatch = !this.filterProjectIds.size || projectIds.some(id => this.filterProjectIds.has(id));
      return orgMatch && projectMatch;
    });

    this.filteredDocuments = filtered;
    const validIds = new Set(filtered.map((doc) => Number(doc.document_id)));
    this.selectedDocumentIds = new Set([...this.selectedDocumentIds].filter((id) => validIds.has(id)));
    this.renderDocumentsTable();
    UiHelpers.showAlert(this.elements.listStatus, `${filtered.length} document(s) shown`, "info");
  }

  async fetchDocuments() {
    UiHelpers.showAlert(this.elements.listStatus, "Loading documents...", "info");
    try {
      const { response, data, rawText } = await this.api.request("/api/tools/list-documents", {
        method: "POST",
        body: {},
      });
      if (!response.ok) {
        throw new Error(data?.error || rawText || `HTTP ${response.status}`);
      }
      if (!data?.success) {
        throw new Error(data?.error || "Failed to list documents");
      }

      this.documents = Array.isArray(data.documents) ? data.documents : [];
      this.documentIds = new Set(this.documents.map((doc) => Number(doc.document_id)));
      this.renderDocumentOptions();
      this.applyFilters();
      UiHelpers.showAlert(this.elements.listStatus, `${this.filteredDocuments.length} document(s) shown`, "info");
    } catch (error) {
      UiHelpers.showAlert(this.elements.listStatus, `Failed to load: ${error.message}`, "error");
    }
  }

  renderDocumentsTable() {
    if (!this.elements.documentsTableBody) return;
    this.renderDocumentHeaderSortIndicators();
    if (!this.filteredDocuments.length) {
      this.elements.documentsTableBody.innerHTML = "<tr><td colspan=\"8\" style=\"color:#777;\">No documents available.</td></tr>";
      return;
    }

    const rows = this.getSortedDocuments();
    this.elements.documentsTableBody.innerHTML = rows
      .map((doc) => {
        const isSelected = this.selectedDocumentIds.has(Number(doc.document_id));
        const title = UiHelpers.escapeHtml(doc.title || "");
        const author = UiHelpers.escapeHtml(doc.author || "");
        const organizationSlug = UiHelpers.escapeHtml(doc.organization_slug || "-");
        const domainTitle = UiHelpers.escapeHtml(doc.domain || "-");
        const domainContent = this.renderDomainCellContent(doc.domain || "");
        const datePublished = UiHelpers.escapeHtml(doc.date_published ? String(doc.date_published).slice(0, 10) : "-");
        return `
          <tr>
            <td>
              <label class="select-radio">
                <input type="checkbox" name="docSelect" value="${doc.document_id}" ${isSelected ? "checked" : ""}>
                <span class="radio-dot"></span>
              </label>
            </td>
            <td title="${title}">${this.trimText(doc.title)}</td>
            <td title="${author}">${this.trimText(doc.author)}</td>
            <td title="${organizationSlug}">${this.trimText(doc.organization_slug || "-")}</td>
            <td title="${domainTitle}">${domainContent}</td>
            <td>${datePublished}</td>
            <td>${doc.document_id}</td>
            <td class="table-actions">
              <button class="edit-btn" data-edit-id="${doc.document_id}">Edit</button>
              <button class="recalc-btn" data-recalc-id="${doc.document_id}">Embeddings</button>
              <button class="delete-btn" data-delete-id="${doc.document_id}">Delete</button>
            </td>
          </tr>
        `;
      })
      .join("");
  }

  selectAllDocuments() {
    for (const doc of this.filteredDocuments) {
      this.selectedDocumentIds.add(Number(doc.document_id));
    }
    this.renderDocumentsTable();
    UiHelpers.showAlert(this.elements.listStatus, `${this.selectedDocumentIds.size} document(s) selected`, "info");
  }

  deselectAllDocuments() {
    this.selectedDocumentIds.clear();
    this.clearSelection();
    this.renderDocumentsTable();
    UiHelpers.showAlert(this.elements.listStatus, "Selection cleared", "info");
  }

  async deleteAllSelectedDocuments() {
    const ids = [...this.selectedDocumentIds];
    if (ids.length === 0) {
      UiHelpers.showAlert(this.elements.listStatus, "No documents selected", "error");
      return;
    }

    if (!confirm(`Delete ${ids.length} selected document(s)? This will remove all chunks.`)) return;

    const results = await runSequential(ids, async (id) => {
      const { response, data, rawText } = await this.api.request("/documents/delete", {
        method: "POST",
        body: { document_id: id },
      });
      if (!response.ok) {
        throw new Error(data?.error || rawText || `HTTP ${response.status}`);
      }
    });

    this.selectedDocumentIds.clear();
    await this.fetchDocuments();
    updateBulkStatus(this.elements.listStatus, results, "Delete documents");
  }

  async waitForProcessingJob(data, options = {}) {
    const {
      missingJobError = "Missing job_id",
      statusElement = this.elements.uploadStatus,
      processingLabel = "Processing",
      failedError = "Job failed",
      notFoundError = "Job not found",
    } = options;

    const jobId = typeof data?.job_id === "string" ? data.job_id : "";
    if (!jobId) {
      throw new Error(missingJobError);
    }

    const result = await this.pollIngestJob(jobId, {
      statusElement,
      processingLabel,
    });

    if (result.state === "failed") {
      throw new Error(failedError);
    }
    if (result.state !== "finished") {
      throw new Error(notFoundError);
    }

    return result;
  }

  async runRecalculateEmbeddingsJob(id, statusElement = this.elements.listStatus) {
    const { response, data, rawText } = await this.api.request("/documents/recalculate-embeddings", {
      method: "POST",
      body: { document_id: id },
    });
    if (!response.ok) {
      throw new Error(data?.error || rawText || `HTTP ${response.status}`);
    }

    return this.waitForProcessingJob(data, {
      missingJobError: "Missing recalculate job_id",
      statusElement,
      processingLabel: `Recalculating embeddings for document ${id}`,
      failedError: `Recalculation failed for document ${id}`,
      notFoundError: `Recalculation job not found for document ${id}`,
    });
  }

  async recalculateAllSelectedDocuments() {
    const ids = [...this.selectedDocumentIds];
    if (ids.length === 0) {
      UiHelpers.showAlert(this.elements.listStatus, "No documents selected", "error");
      return;
    }

    if (!confirm(`Recalculate embeddings for ${ids.length} selected document(s)?`)) return;

    const results = await runSequential(ids, async (id) => {
      await this.runRecalculateEmbeddingsJob(id, this.elements.listStatus);
    });

    updateBulkStatus(this.elements.listStatus, results, "Recalculate embeddings");
  }

  async deleteDocument(id) {
    const doc = this.documents.find((item) => Number(item.document_id) === id);
    if (!doc) return;
    if (!confirm(`Delete document ID ${id}? This will remove all chunks.`)) return;

    try {
      const { response, data, rawText } = await this.api.request("/documents/delete", {
        method: "POST",
        body: { document_id: id },
      });

      if (!response.ok) {
        throw new Error(data?.error || rawText || `HTTP ${response.status}`);
      }

      if (this.selectedDocument && Number(this.selectedDocument.document_id) === id) {
        this.clearSelection();
      }

      await this.fetchDocuments();
      UiHelpers.showAlert(this.elements.listStatus, `Deleted document ${id}`, "success");
    } catch (error) {
      UiHelpers.showAlert(this.elements.listStatus, `Delete failed: ${error.message}`, "error");
    }
  }

  async recalculateEmbeddings(id) {
    const doc = this.documents.find((item) => Number(item.document_id) === id);
    if (!doc) return;
    if (!confirm(`Recalculate embeddings for document ID ${id}?`)) return;

    try {
      const result = await this.runRecalculateEmbeddingsJob(id, this.elements.listStatus);
      UiHelpers.setStatus(this.elements.listStatus, `Recalculated embeddings for document ${id} (${result.total} chunks)`, "success");
    } catch (error) {
      UiHelpers.setStatus(this.elements.listStatus, `Recalculate failed: ${error.message}`, "error");
    }
  }

  async handleFileChange(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    UiHelpers.setStatus(this.elements.fileStatus, "Extracting text from file...", "");
    try {
      const ext = this.getFileExtension(file.name);
      const arrayBuffer = await file.arrayBuffer();

      let extractedText = "";
      if (ext === "pdf") {
        extractedText = await this.extractTextFromPdf(arrayBuffer);
      } else if (ext === "docx") {
        extractedText = await this.extractTextFromDocx(arrayBuffer);
      } else if (ext === "txt") {
        extractedText = await this.extractTextFromTxt(arrayBuffer);
      } else {
        throw new Error("Unsupported file type. Use PDF, TXT, or DOCX.");
      }

      if (!extractedText) {
        throw new Error("No text could be extracted from the file.");
      }

      this.elements.docText.value = extractedText;
      if (!this.elements.title.value.trim()) {
        this.elements.title.value = file.name.replace(/\.[^/.]+$/, "");
      }

      UiHelpers.setStatus(
        this.elements.fileStatus,
        `Extracted ${extractedText.length.toLocaleString()} characters from ${file.name}`,
        "success"
      );
    } catch (error) {
      UiHelpers.setStatus(this.elements.fileStatus, `Extraction failed: ${error.message}`, "error");
    }
  }

  async convertSelectedPdfToMarkdown() {
    const status = this.elements.fileStatus;
    const authHeader = this.api.getAuthHeader();
    if (!authHeader) {
      UiHelpers.setStatus(status, "Please authenticate first.", "error");
      return;
    }

    const file = this.elements.docFile?.files?.[0];
    if (!file) {
      UiHelpers.setStatus(status, "Please select a PDF file first.", "error");
      return;
    }

    const isPdf = this.getFileExtension(file.name) === "pdf" || (file.type || "").toLowerCase() === "application/pdf";
    if (!isPdf) {
      UiHelpers.setStatus(status, "Convert PDF2MD supports PDF files only.", "error");
      return;
    }

    UiHelpers.setStatus(status, "Converting PDF to markdown...", "");

    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch(`${this.api.baseUrl}/extract-markdown`, {
        method: "POST",
        headers: {
          Authorization: authHeader,
        },
        body: formData,
      });

      const rawText = await response.text();
      let data = null;

      if (rawText) {
        try {
          data = JSON.parse(rawText);
        } catch {
          data = null;
        }
      }

      if (!response.ok) {
        throw new Error(data?.error || rawText || `HTTP ${response.status}`);
      }

      const markdown = typeof data?.markdown === "string" ? data.markdown : "";
      if (!markdown) {
        throw new Error("Conversion returned empty markdown text.");
      }

      this.elements.docText.value = markdown;
      if (!this.elements.title.value.trim()) {
        this.elements.title.value = file.name.replace(/\.[^/.]+$/, "");
      }

      UiHelpers.setStatus(status, `Converted ${file.name} to markdown (${markdown.length.toLocaleString()} characters).`, "success");
    } catch (error) {
      UiHelpers.setStatus(status, `PDF2MD conversion failed: ${error.message}`, "error");
    }
  }

  getFileExtension(name) {
    const parts = name.toLowerCase().split(".");
    return parts.length > 1 ? parts.pop() : "";
  }

  async extractTextFromPdf(arrayBuffer) {
    return extractTextFromPdfArrayBuffer(arrayBuffer, { batchSize: 10 });
  }

  async loadMammoth() {
    if (window.mammoth) return window.mammoth;
    if (!this.mammothLoader) {
      this.mammothLoader = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "/console/js/lib/mammoth.browser@1.11.0.min.js";
        script.onload = () => window.mammoth ? resolve(window.mammoth) : reject(new Error("DOCX parser not available"));
        script.onerror = () => reject(new Error("DOCX parser not available"));
        document.head.appendChild(script);
      });
    }
    return this.mammothLoader;
  }

  async extractTextFromDocx(arrayBuffer) {
    const mammoth = await this.loadMammoth();
    const result = await mammoth.extractRawText({ arrayBuffer });
    return (result.value || "").trim();
  }

  async extractTextFromTxt(arrayBuffer) {
    const decoder = new TextDecoder("utf-8");
    return decoder.decode(arrayBuffer).trim();
  }

  async pollIngestJob(jobId, options = {}) {
    const intervalMs = 1000;
    const maxAttempts = 1800;
    const statusElement = options.statusElement || this.elements.uploadStatus;
    const processingLabel = options.processingLabel || "Processing";

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const { response, data, rawText } = await this.api.request(`/documents/ingest-status?job_id=${encodeURIComponent(jobId)}`, {
        method: "GET",
      });

      if (!response.ok) {
        throw new Error(data?.error || rawText || `HTTP ${response.status}`);
      }

      const progress = Number(data?.progress ?? 0);
      const total = Number(data?.total ?? 0);
      const state = typeof data?.state === "string" ? data.state : "not found";

      if (state === "processing") {
        const progressLabel = total > 0 ? `${progress}/${total}` : `${progress}`;
        UiHelpers.setStatus(statusElement, `${processingLabel}... ${progressLabel} chunks`, "");
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        continue;
      }

      return { state, progress, total, duplicate: data?.duplicate === true, documentId: Number(data?.document_id ?? 0) || null };
    }

    throw new Error("Job polling timed out");
  }

  async handleUpload(action = "upload") {
    const status = this.elements.uploadStatus;
    if (!this.api.getAuthHeader()) {
      UiHelpers.setStatus(status, "Please authenticate first.", "error");
      return;
    }

    const title = this.elements.title.value.trim();
    const author = this.elements.author.value.trim();
    const summary = this.elements.summary.value.trim();
    const domain = this.elements.domain.value.trim();
    const keywordsStr = this.elements.keywords.value.trim();
    const datePublished = this.elements.datePublished.value;
    const language = this.elements.language.value.trim();
    const chunkingStrategy = this.elements.chunkingStrategy.value;
    const chunkMaxCharsRaw = this.elements.chunkMaxChars.value.trim();
    const chunkOverlapPercentValue = this.elements.chunkOverlapPercent
      ? Number(this.elements.chunkOverlapPercent.value)
      : 50;
    const docText = this.elements.docText.value.trim();

    UiHelpers.setStatus(status, "Saving...", "");

    try {
      const keywords = this.normalizeKeywords(keywordsStr);
      const chunkMaxChars = this.clampChunkMaxChars(chunkMaxCharsRaw);
      const effectiveMaxChars = chunkMaxChars ?? 1000;
      const overlapPercent = this.clampOverlapPercent(chunkOverlapPercentValue);
      const overlapChars = chunkingStrategy === "fixed"
        ? Math.floor((effectiveMaxChars * overlapPercent) / 100)
        : null;

      const payload = {
        title: title || null,
        author: author || null,
        summary: summary || null,
        domain: domain || null,
        keywords: keywords.length ? keywords : null,
        date_published: datePublished || null,
        language: language || null,
        chunking_strategy: chunkingStrategy || "semantic",
        chunk_max_chars: Number.isFinite(chunkMaxChars) ? chunkMaxChars : null,
        chunk_overlap_chars: Number.isFinite(overlapChars) ? overlapChars : null,
      };

      if (this.mode === "modify") {
        if (!this.selectedDocument) throw new Error("Select a document to modify.");
        if (action === "content") {
          if (!docText) {
            UiHelpers.setStatus(status, "Document text is required to update content.", "error");
            return;
          }
          const { response, data, rawText } = await this.api.request("/documents/update-content", {
            method: "POST",
            body: {
              document_id: this.selectedDocument.document_id,
              content: docText,
            },
          });

          if (!response.ok) {
            throw new Error(data?.error || rawText || `HTTP ${response.status}`);
          }
          UiHelpers.setStatus(
            status,
            `Content updated for document ID ${this.selectedDocument.document_id} (${data?.chunks ?? 0} chunks)`,
            "success"
          );
        } else {
          const projectIds = this.selectedFormProjectIds();
          if (!projectIds.length) throw new Error("Select at least one project.");
          const { response, data, rawText } = await this.api.request("/documents/update", {
            method: "POST",
            body: {
              document_id: this.selectedDocument.document_id,
              ...payload,
              project_ids: projectIds,
            },
          });

          if (!response.ok) {
            throw new Error(data?.error || rawText || `HTTP ${response.status}`);
          }
          UiHelpers.setStatus(status, `Metadata updated for document ID ${this.selectedDocument.document_id}`, "success");
        }

        await this.fetchDocuments();
        if (this.selectedDocument) this.populateForm(this.selectedDocument);
        return;
      }

      if (!title || !docText) {
        UiHelpers.setStatus(status, "Title and Document Text are required.", "error");
        return;
      }

      const selectedProjectIds = this.selectedFormProjectIds();
      if (!selectedProjectIds.length) {
        UiHelpers.setStatus(status, "Select at least one project before uploading a new document.", "error");
        return;
      }
      const selectedProjectId = selectedProjectIds[0];
      const selectedProject = this.availableProjects.find((p) => Number(p.project_id) === Number(selectedProjectId));
      const organizationId = selectedProject ? Number(selectedProject.organization_id) : null;
      if (!organizationId) {
        UiHelpers.setStatus(status, "Cannot resolve organization for selected project.", "error");
        return;
      }

      const { response, data, rawText } = await this.api.request("/documents/ingest", {
        method: "POST",
        body: {
          ...payload,
          content: docText,
          organization_id: organizationId,
          project_ids: selectedProjectIds,
        },
      });

      if (!response.ok) {
        throw new Error(data?.error || rawText || `HTTP ${response.status}`);
      }

      const result = await this.waitForProcessingJob(data, {
        missingJobError: "Missing ingest job_id",
        statusElement: status,
        processingLabel: `Ingesting "${title}"`,
        failedError: `Ingest failed for "${title}"`,
        notFoundError: `Ingest job not found for "${title}"`,
      });

      if (result.duplicate) {
        UiHelpers.setStatus(
          status,
          `Duplicate content: already ingested as document ID ${result.documentId}. Selected project memberships have been added.`,
          "error"
        );
        await this.fetchDocuments();
        return;
      }

      UiHelpers.setStatus(
        status,
        `Document "${title}" ingested successfully (${result.total} chunks)`,
        "success"
      );

      await this.fetchDocuments();
      this.clearForm();
    } catch (error) {
      UiHelpers.setStatus(status, `Save failed: ${error.message}`, "error");
    }
  }
}

export { DocumentSection };
