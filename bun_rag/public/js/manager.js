import { API_URL, ApiClient } from "./api.js";
import { UiHelpers, TabManager } from "./domUtils.js";
import { InfoSection } from "./info.js";
import { DocumentSection } from "./documents.js";
import { KeysSection } from "./keys.js";
import { OrganizationsSection } from "./organizations.js";
import { ProjectsSection } from "./projects.js";
import { WebSection } from "./web.js";

class AdminApp {
  constructor() {
    this.api = new ApiClient(API_URL);
    this.elements = this.cacheElements();
    this.infoSection = new InfoSection(this.api, {
      authLevelValue: this.elements.authLevelValue,
      toolsTableBody: this.elements.toolsTableBody,
      routesTableBody: this.elements.routesTableBody,
    });
    this.documentSection = new DocumentSection(this.api, this.elements.documentSection);
    this.keysSection = new KeysSection(this.api, this.elements.keysSection);
    this.organizationsSection = new OrganizationsSection(this.api, this.elements.organizationsSection);
    this.projectsSection = new ProjectsSection(this.api, this.elements.projectsSection);
    this.webSection = new WebSection(this.api, this.elements.webSection);
    this.webSection.setProjectsRefreshHandler(async () => {
      await this.projectsSection.refreshProjectsList();
    });
    this.webSection.setCrawlerListChangeHandler(async () => {
      await this.projectsSection.refreshProjectsList();
    });
    this.mainTabs = new TabManager(this.elements.mainTabs, (tabId) => this.switchMainTab(tabId));
    this.activeTab = "infoTab";
    this.currentOrganizations = [];
    this.currentProjects = [];
    this.selectedOrganizationIds = new Set();
    this.selectedProjectIds = new Set();

    this.organizationsSection.setSelectionChangeHandler((ids) => this.handleOrganizationSelectionChange(ids));
    this.projectsSection.setSelectionChangeHandler((ids) => this.handleProjectSelectionChange(ids));
    this.projectsSection.setProjectsChangeHandler((projects) => this.handleProjectsChange(projects));
    this.registerAuth();
    this.applyAccess(null);
    void this.tryRestoreSession();
  }

  cacheElements() {
    return {
      authSection: document.getElementById("authSection"),
      apiKeyInput: document.getElementById("apiKeyInput"),
      authButton: document.getElementById("authButton"),
      logoutButton: document.getElementById("logoutButton"),
      authAlert: document.getElementById("authAlert"),
      mainTabs: document.getElementById("mainTabs"),
      documentsTabBtn: document.getElementById("documentsTabBtn"),
      keysTabBtn: document.getElementById("keysTabBtn"),
      organizationsTabBtn: document.getElementById("organizationsTabBtn"),
      projectsTabBtn: document.getElementById("projectsTabBtn"),
      webTabBtn: document.getElementById("webTabBtn"),
      infoTab: document.getElementById("infoTab"),
      documentsTab: document.getElementById("documentsTab"),
      keysTab: document.getElementById("keysTab"),
      organizationsTab: document.getElementById("organizationsTab"),
      projectsTab: document.getElementById("projectsTab"),
      webTab: document.getElementById("webTab"),
      authLevelValue: document.getElementById("authLevelValue"),
      toolsTableBody: document.getElementById("toolsTableBody"),
      routesTableBody: document.getElementById("routesTableBody"),
      documentSection: {
        modifyDocumentGroup: document.getElementById("modifyDocumentGroup"),
        modifyDocumentSelect: document.getElementById("modifyDocumentSelect"),
        documentFields: document.getElementById("documentFields"),
        uploadProjectGroup: document.getElementById("uploadProjectGroup"),
        documentProjectsList: document.getElementById("documentProjectsList"),
        clearDocumentProjectFilter: document.getElementById("clearDocumentProjectFilter"),
        documentProjectFilter: document.getElementById("documentProjectFilter"),
        documentTabs: document.getElementById("documentTabs"),
        uploadTab: document.getElementById("uploadTab"),
        listTab: document.getElementById("listTab"),
        uploadHeading: document.getElementById("uploadHeading"),
        uploadDescription: document.getElementById("uploadDescription"),
        selectedDocInfo: document.getElementById("selectedDocInfo"),
        title: document.getElementById("title"),
        author: document.getElementById("author"),
        summary: document.getElementById("summary"),
        domain: document.getElementById("domain"),
        keywords: document.getElementById("keywords"),
        datePublished: document.getElementById("datePublished"),
        language: document.getElementById("language"),
        chunkingStrategy: document.getElementById("chunkingStrategy"),
        chunkMaxChars: document.getElementById("chunkMaxChars"),
        chunkOverlapGroup: document.getElementById("chunkOverlapGroup"),
        chunkOverlapPercent: document.getElementById("chunkOverlapPercent"),
        chunkOverlapLabel: document.getElementById("chunkOverlapLabel"),
        docFile: document.getElementById("docFile"),
        convertPdfToMdBtn: document.getElementById("convertPdfToMdBtn"),
        fileStatus: document.getElementById("fileStatus"),
        docText: document.getElementById("docText"),
        uploadBtn: document.getElementById("uploadBtn"),
        updateMetadataBtn: document.getElementById("updateMetadataBtn"),
        updateContentBtn: document.getElementById("updateContentBtn"),
        uploadStatus: document.getElementById("uploadStatus"),
        refreshDocsBtn: document.getElementById("refreshDocsBtn"),
        selectAllDocsBtn: document.getElementById("selectAllDocsBtn"),
        deselectAllDocsBtn: document.getElementById("deselectAllDocsBtn"),
        deleteAllDocsBtn: document.getElementById("deleteAllDocsBtn"),
        embeddingsAllDocsBtn: document.getElementById("embeddingsAllDocsBtn"),
        listStatus: document.getElementById("listStatus"),
        documentsTableBody: document.getElementById("documentsTableBody"),
      },
      keysSection: {
        issueAlert: document.getElementById("issueAlert"),
        keyUsername: document.getElementById("keyUsername"),
        keyPrivilege: document.getElementById("keyPrivilege"),
        keyValidDays: document.getElementById("keyValidDays"),
        keyOrganizationSelect: document.getElementById("keyOrganizationSelect"),
        issueOrganizationHint: document.getElementById("issueOrganizationHint"),
        keyProjectsList: document.getElementById("keyProjectsList"),
        issueProjectsHint: document.getElementById("issueProjectsHint"),
        issueKeyBtn: document.getElementById("issueKeyBtn"),
        issuedKeyDisplay: document.getElementById("issuedKeyDisplay"),
        issuedKeyValue: document.getElementById("issuedKeyValue"),
        copyIssuedKeyBtn: document.getElementById("copyIssuedKeyBtn"),
        dismissIssuedKeyBtn: document.getElementById("dismissIssuedKeyBtn"),
        keysTableContainer: document.getElementById("keysTableContainer"),
        refreshKeysBtn: document.getElementById("refreshKeysBtn"),
        selectAllKeysBtn: document.getElementById("selectAllKeysBtn"),
        deselectAllKeysBtn: document.getElementById("deselectAllKeysBtn"),
        deleteAllKeysBtn: document.getElementById("deleteAllKeysBtn"),
      },
      organizationsSection: {
        organizationsAlert: document.getElementById("organizationsAlert"),
        organizationTitleInput: document.getElementById("organizationTitleInput"),
        organizationSlugInput: document.getElementById("organizationSlugInput"),
        addOrganizationBtn: document.getElementById("addOrganizationBtn"),
        refreshOrganizationsBtn: document.getElementById("refreshOrganizationsBtn"),
        selectAllOrganizationsBtn: document.getElementById("selectAllOrganizationsBtn"),
        deselectAllOrganizationsBtn: document.getElementById("deselectAllOrganizationsBtn"),
        deleteAllOrganizationsBtn: document.getElementById("deleteAllOrganizationsBtn"),
        organizationsTableContainer: document.getElementById("organizationsTableContainer"),
      },
      projectsSection: {
        projectsAlert: document.getElementById("projectsAlert"),
        projectOrganizationSelect: document.getElementById("projectOrganizationSelect"),
        projectTitleInput: document.getElementById("projectTitleInput"),
        projectDescriptionInput: document.getElementById("projectDescriptionInput"),
        addProjectBtn: document.getElementById("addProjectBtn"),
        clearProjectBtn: document.getElementById("clearProjectBtn"),
        refreshProjectsBtn: document.getElementById("refreshProjectsBtn"),
        selectAllProjectsBtn: document.getElementById("selectAllProjectsBtn"),
        deselectAllProjectsBtn: document.getElementById("deselectAllProjectsBtn"),
        deleteAllProjectsBtn: document.getElementById("deleteAllProjectsBtn"),
        projectsTableContainer: document.getElementById("projectsTableContainer"),
      },
      webSection: {
        webAlert: document.getElementById("webAlert"),
        webOrganizationSelect: document.getElementById("webOrganizationSelect"),
        webUrlInput: document.getElementById("webUrlInput"),
        webScopeSelect: document.getElementById("webScopeSelect"),
        webUseSitemapCheckbox: document.getElementById("webUseSitemapCheckbox"),
        webUseLlmDescriptionCheckbox: document.getElementById("webUseLlmDescriptionCheckbox"),
        webMaxPagesInput: document.getElementById("webMaxPagesInput"),
        webUseCronCheckbox: document.getElementById("webUseCronCheckbox"),
        webCronIntervalDaysSelect: document.getElementById("webCronIntervalDaysSelect"),
        webCronIntervalHoursSelect: document.getElementById("webCronIntervalHoursSelect"),
        webCronIntervalMinutesSelect: document.getElementById("webCronIntervalMinutesSelect"),
        webCronStartHourSelect: document.getElementById("webCronStartHourSelect"),
        webCronStartMinuteSelect: document.getElementById("webCronStartMinuteSelect"),
        webRunNowCheckbox: document.getElementById("webRunNowCheckbox"),
        webProgressStatus: document.getElementById("webProgressStatus"),
        webAddCrawlerBtn: document.getElementById("webAddCrawlerBtn"),
        webCancelCrawlerBtn: document.getElementById("webCancelCrawlerBtn"),
        webRefreshBtn: document.getElementById("webRefreshBtn"),
        webSelectAllBtn: document.getElementById("webSelectAllBtn"),
        webDeselectAllBtn: document.getElementById("webDeselectAllBtn"),
        webDeleteAllBtn: document.getElementById("webDeleteAllBtn"),
        webTableContainer: document.getElementById("webTableContainer"),
      },
    };
  }

  registerAuth() {
    this.elements.authButton.addEventListener("click", () => this.authenticate());
    this.elements.logoutButton?.addEventListener("click", () => this.logout());
  }

  logout() {
    this.api.clearApiKey();
    window.location.reload();
  }

  async tryRestoreSession() {
    if (!this.api.getAuthHeader()) return;

    try {
      const { response, data } = await this.api.request("/admin/check-key", { method: "POST" });
      if (!response.ok) {
        this.api.clearApiKey();
        return;
      }

      const level = Number(data?.level ?? 0);
      await this.applyAuthenticatedLevel(level);
      UiHelpers.showAlert(this.elements.authAlert, "Session restored", "success");
    } catch {
      // Keep stored key on transient network errors; user stays on login form.
    }
  }

  switchMainTab(tabId) {
    this.activeTab = tabId;
    const tabs = [
      { id: "infoTab", element: this.elements.infoTab },
      { id: "documentsTab", element: this.elements.documentsTab },
      { id: "projectsTab", element: this.elements.projectsTab },
      { id: "webTab", element: this.elements.webTab },
      { id: "keysTab", element: this.elements.keysTab },
      { id: "organizationsTab", element: this.elements.organizationsTab },
    ];

    tabs.forEach((tab) => {
      tab.element.classList.toggle("active", tab.id === tabId);
      UiHelpers.toggleDisplay(tab.element, tab.id === tabId);
    });
  }

  applyAccess(level) {
    const authenticated = level !== null;
    UiHelpers.toggleDisplay(this.elements.mainTabs, authenticated);

    const canSeeDocs = authenticated && level >= 30;
    const canSeeKeys = authenticated && level >= 100;
    const canSeeOrganizations = authenticated && level >= 1000;
    const canSeeProjects = authenticated && level >= 100;
    const canSeeWeb = authenticated && level >= 100;

    UiHelpers.toggleDisplay(this.elements.documentsTabBtn, canSeeDocs);
    UiHelpers.toggleDisplay(this.elements.documentsTab, canSeeDocs);
    UiHelpers.toggleDisplay(this.elements.keysTabBtn, canSeeKeys);
    UiHelpers.toggleDisplay(this.elements.keysTab, canSeeKeys);
    UiHelpers.toggleDisplay(this.elements.organizationsTabBtn, canSeeOrganizations);
    UiHelpers.toggleDisplay(this.elements.organizationsTab, canSeeOrganizations);
    UiHelpers.toggleDisplay(this.elements.projectsTabBtn, canSeeProjects);
    UiHelpers.toggleDisplay(this.elements.projectsTab, canSeeProjects);
    UiHelpers.toggleDisplay(this.elements.webTabBtn, canSeeWeb);
    UiHelpers.toggleDisplay(this.elements.webTab, canSeeWeb);

    if (!canSeeDocs && this.activeTab === "documentsTab") {
      this.mainTabs.activate("infoTab");
    }

    if (!canSeeKeys && this.activeTab === "keysTab") {
      this.mainTabs.activate("infoTab");
    }

    if (!canSeeOrganizations && this.activeTab === "organizationsTab") {
      this.mainTabs.activate("infoTab");
    }

    if (!canSeeProjects && this.activeTab === "projectsTab") {
      this.mainTabs.activate("infoTab");
    }

    if (!canSeeWeb && this.activeTab === "webTab") {
      this.mainTabs.activate("infoTab");
    }
  }

  async loadScopeData(level) {
    const orgRes = await this.api.request("/admin/organizations", { method: "POST" });
    if (!orgRes.response.ok) {
      throw new Error(orgRes.data?.error || orgRes.rawText || "Failed to load organizations");
    }
    this.currentOrganizations = Array.isArray(orgRes.data?.organizations) ? orgRes.data.organizations : [];

    if (this.selectedOrganizationIds.size === 0 && this.currentOrganizations.length > 0) {
      this.currentOrganizations.forEach((org) => {
        const id = Number(org.organization_id);
        if (id > 0) this.selectedOrganizationIds.add(id);
      });
    }

    const validOrganizationIds = new Set(this.currentOrganizations.map((org) => Number(org.organization_id)));
    this.selectedOrganizationIds = new Set([...this.selectedOrganizationIds].filter((id) => validOrganizationIds.has(id)));

    this.organizationsSection.setSelectedOrganizations([...this.selectedOrganizationIds], false);
    this.projectsSection.setAuthLevel(level);
    this.webSection.setAuthLevel(level);
    this.webSection.setOrganizations(this.currentOrganizations);
    this.projectsSection.setAvailableOrganizations(this.currentOrganizations);
    this.projectsSection.setOrganizationFilter([...this.selectedOrganizationIds]);
    await this.projectsSection.refreshProjectsList();

    this.currentProjects = Array.isArray(this.projectsSection.projects) ? this.projectsSection.projects : [];
    const validProjectIds = new Set(this.currentProjects.map((project) => Number(project.project_id)));
    this.selectedProjectIds = new Set([...this.selectedProjectIds].filter((id) => validProjectIds.has(id)));
    this.projectsSection.setSelectedProjects([...this.selectedProjectIds], false);

    this.documentSection.setScopeOptions({
      organizations: this.currentOrganizations,
      projects: this.currentProjects,
      authLevel: level,
    });
    this.documentSection.setScopeSelection({
      organizationIds: [...this.selectedOrganizationIds],
    });

    const firstSelectedOrganizationId = [...this.selectedOrganizationIds][0] || null;
    this.keysSection.setOrganizationScope(firstSelectedOrganizationId);
    await this.keysSection.loadIssueOrganizations();
    await this.keysSection.loadIssueProjects();

    if (level >= 100) {
      await this.webSection.refreshCrawlers();
    }
  }

  async handleOrganizationSelectionChange(ids) {
    this.selectedOrganizationIds = new Set(Array.isArray(ids) ? ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0) : []);
    this.projectsSection.setOrganizationFilter([...this.selectedOrganizationIds]);
    await this.projectsSection.refreshProjectsList();

    this.currentProjects = Array.isArray(this.projectsSection.projects) ? this.projectsSection.projects : [];
    const validProjectIds = new Set(this.currentProjects.map((project) => Number(project.project_id)));
    this.selectedProjectIds = new Set([...this.selectedProjectIds].filter((id) => validProjectIds.has(id)));
    this.projectsSection.setAvailableOrganizations(this.currentOrganizations);
    this.projectsSection.setSelectedProjects([...this.selectedProjectIds], false);

    this.documentSection.setScopeOptions({
      organizations: this.currentOrganizations,
      projects: this.currentProjects,
      authLevel: this.keysSection.authLevel || 0,
    });
    this.documentSection.setScopeSelection({
      organizationIds: [...this.selectedOrganizationIds],
    });

    const firstSelectedOrganizationId = [...this.selectedOrganizationIds][0] || null;
    this.keysSection.setOrganizationScope(firstSelectedOrganizationId);
    this.webSection.setOrganizations(this.currentOrganizations);
  }

  handleProjectSelectionChange(ids) {
    this.selectedProjectIds = new Set(Array.isArray(ids) ? ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0) : []);
  }

  async handleProjectsChange(projects) {
    this.currentProjects = Array.isArray(projects) ? projects : [];

    const validProjectIds = new Set(this.currentProjects.map((project) => Number(project.project_id)));
    this.selectedProjectIds = new Set([...this.selectedProjectIds].filter((id) => validProjectIds.has(id)));

    this.documentSection.setScopeOptions({
      organizations: this.currentOrganizations,
      projects: this.currentProjects,
      authLevel: this.keysSection.authLevel || 0,
    });
    this.documentSection.setScopeSelection({
      organizationIds: [...this.selectedOrganizationIds],
    });

    await this.keysSection.loadIssueProjects();
    this.webSection.setOrganizations(this.currentOrganizations);
  }

  async authenticate() {
    const apiKey = this.elements.apiKeyInput.value.trim();
    if (!apiKey) {
      UiHelpers.showAlert(this.elements.authAlert, "Please enter API key", "error");
      return;
    }

    this.api.setApiKey(apiKey);

    try {
      const { response, data, rawText } = await this.api.request("/admin/check-key", { method: "POST" });
      if (response.status === 401) {
        this.api.clearApiKey();
        UiHelpers.showAlert(this.elements.authAlert, "Invalid API key", "error");
        return;
      }

      if (!response.ok) {
        UiHelpers.showAlert(this.elements.authAlert, data?.error || rawText || "Authentication failed", "error");
        return;
      }

      const level = Number(data?.level ?? 0);
      await this.applyAuthenticatedLevel(level);

      UiHelpers.showAlert(this.elements.authAlert, "Authenticated", "success");
    } catch (error) {
      UiHelpers.showAlert(this.elements.authAlert, `Error: ${error.message}`, "error");
    }
  }

  async applyAuthenticatedLevel(level) {
    this.infoSection.setAuthLevel(level);
    this.applyAccess(level);
    this.keysSection.setAuthLevel(level);

    await this.loadScopeData(level);

    await this.infoSection.loadTools();
    await this.infoSection.loadRoutes();

    if (level >= 30) {
      await this.documentSection.fetchDocuments();
      this.documentSection.subTabs.activate("listTab");
    }

    this.mainTabs.activate("infoTab");

    if (level >= 100) {
      await this.keysSection.refreshKeysList();
      await this.webSection.refreshCrawlers();
    }

    if (level >= 1000) {
      await this.organizationsSection.refreshOrganizationsList();
    }
  }
}

new AdminApp();

export { AdminApp };
