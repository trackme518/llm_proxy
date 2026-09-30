import { UiHelpers } from "./domUtils.js";
import { runSequential, updateBulkStatus } from "./actions.js";

const DAY_OPTIONS = Array.from({ length: 8 }, (_, index) => index);
const HOUR_OPTIONS = Array.from({ length: 24 }, (_, index) => index);
const MINUTE_OPTIONS = Array.from({ length: 60 }, (_, index) => index);

class WebSection {
  constructor(api, elements) {
    this.api = api;
    this.elements = elements;
    this.authLevel = 0;
    this.organizationId = null;
    this.crawlers = [];
    this.projectsRefreshHandler = null;
    this.crawlerListChangeHandler = null;
    this.activeStatusPollJobId = null;
    this.selectedCrawlerIds = new Set();

    this.initializeCronSelects();
    this.registerEvents();
  }

  initializeCronSelects() {
    const toOption = (value, selected) => `<option value="${value}" ${selected === value ? "selected" : ""}>${String(value).padStart(2, "0")}</option>`;

    if (this.elements.webCronIntervalDaysSelect) {
      this.elements.webCronIntervalDaysSelect.innerHTML = DAY_OPTIONS
        .map((value) => toOption(value, 1))
        .join("");
    }

    if (this.elements.webCronIntervalHoursSelect) {
      this.elements.webCronIntervalHoursSelect.innerHTML = HOUR_OPTIONS
        .map((value) => toOption(value, 0))
        .join("");
    }

    if (this.elements.webCronIntervalMinutesSelect) {
      this.elements.webCronIntervalMinutesSelect.innerHTML = MINUTE_OPTIONS
        .map((value) => toOption(value, 0))
        .join("");
    }

    if (this.elements.webCronStartHourSelect) {
      this.elements.webCronStartHourSelect.innerHTML = Array.from({ length: 25 }, (_, index) => {
        const label = index === 24 ? "24" : String(index).padStart(2, "0");
        return `<option value="${index}" ${index === 24 ? "selected" : ""}>${label}</option>`;
      }).join("");
    }

    if (this.elements.webCronStartMinuteSelect) {
      this.elements.webCronStartMinuteSelect.innerHTML = MINUTE_OPTIONS
        .map((value) => toOption(value, 0))
        .join("");
    }
  }

  registerEvents() {
    this.elements.webOrganizationSelect?.addEventListener("change", () => {
      this.organizationId = Number(this.elements.webOrganizationSelect.value || 0) || null;
      this.refreshCrawlers();
    });

    this.elements.webAddCrawlerBtn?.addEventListener("click", () => this.addCrawler());
    this.elements.webCancelCrawlerBtn?.addEventListener("click", () => this.cancelCrawler());
    this.elements.webRefreshBtn?.addEventListener("click", () => this.refreshCrawlers());
    this.elements.webSelectAllBtn?.addEventListener("click", () => this.selectAllCrawlers());
    this.elements.webDeselectAllBtn?.addEventListener("click", () => this.deselectAllCrawlers());
    this.elements.webDeleteAllBtn?.addEventListener("click", () => this.deleteAllSelectedCrawlers());

    this.elements.webTableContainer?.addEventListener("change", (event) => {
      const checkbox = event.target.closest("input[name='crawlerSelect']");
      if (!checkbox) return;
      const crawlerId = Number(checkbox.value || 0);
      if (crawlerId <= 0) return;
      if (checkbox.checked) {
        this.selectedCrawlerIds.add(crawlerId);
      } else {
        this.selectedCrawlerIds.delete(crawlerId);
      }
    });

    this.elements.webTableContainer?.addEventListener("click", (event) => {
      const runButton = event.target.closest("button[data-run-crawler-id]");
      if (runButton) {
        const crawlerId = Number(runButton.dataset.runCrawlerId || 0);
        if (crawlerId > 0) this.runCrawler(crawlerId);
        return;
      }

      const updateButton = event.target.closest("button[data-update-crawler-id]");
      if (updateButton) {
        const crawlerId = Number(updateButton.dataset.updateCrawlerId || 0);
        if (crawlerId > 0) this.updateCrawler(crawlerId);
        return;
      }

      const deleteButton = event.target.closest("button[data-delete-crawler-id]");
      if (deleteButton) {
        const crawlerId = Number(deleteButton.dataset.deleteCrawlerId || 0);
        if (crawlerId > 0) this.deleteCrawler(crawlerId);
      }
    });
  }

  setProjectsRefreshHandler(handler) {
    this.projectsRefreshHandler = typeof handler === "function" ? handler : null;
  }

  setCrawlerListChangeHandler(handler) {
    this.crawlerListChangeHandler = typeof handler === "function" ? handler : null;
  }

  async notifyProjectsRefresh() {
    if (!this.projectsRefreshHandler) return;
    await this.projectsRefreshHandler();
  }

  async notifyCrawlerListChange() {
    if (!this.crawlerListChangeHandler) return;
    await this.crawlerListChangeHandler();
  }

  setAuthLevel(level) {
    this.authLevel = Number(level || 0);
  }

  setOrganizations(organizations) {
    const list = Array.isArray(organizations) ? organizations : [];
    this.elements.webOrganizationSelect.innerHTML = list
      .map((org) => `<option value="${org.organization_id}">${UiHelpers.escapeHtml(org.slug || "-")} (${UiHelpers.escapeHtml(org.name || "-")})</option>`)
      .join("");

    if (!this.organizationId && list.length > 0) {
      this.organizationId = Number(list[0].organization_id);
    }

    if (this.organizationId) {
      this.elements.webOrganizationSelect.value = String(this.organizationId);
    }
  }

  toTwoDigit(value) {
    return String(Math.max(0, Number(value) || 0)).padStart(2, "0");
  }

  formatLastRunGmt(value) {
    if (!value) return "-";
    const parsedDate = new Date(value);
    if (Number.isNaN(parsedDate.getTime())) return "-";

    const hours = this.toTwoDigit(parsedDate.getUTCHours());
    const minutes = this.toTwoDigit(parsedDate.getUTCMinutes());
    const day = this.toTwoDigit(parsedDate.getUTCDate());
    const month = this.toTwoDigit(parsedDate.getUTCMonth() + 1);
    const year = parsedDate.getUTCFullYear();
    return `${hours}:${minutes} ${day}.${month}.${year}`;
  }

  readCronFromCreateForm() {
    const useCron = Boolean(this.elements.webUseCronCheckbox?.checked);
    const intervalDays = Number(this.elements.webCronIntervalDaysSelect?.value || 1);
    const intervalHours = Number(this.elements.webCronIntervalHoursSelect?.value || 0);
    const intervalMinutes = Number(this.elements.webCronIntervalMinutesSelect?.value || 0);
    const startHourRaw = Number(this.elements.webCronStartHourSelect?.value || 24);
    const startMinute = Number(this.elements.webCronStartMinuteSelect?.value || 0);

    const intervalTotalMinutes = Math.max(1, (intervalDays * 24 * 60) + (intervalHours * 60) + intervalMinutes);
    const startHour = startHourRaw === 24 ? 0 : startHourRaw;
    const cronStartTime = `${this.toTwoDigit(startHour)}:${this.toTwoDigit(startMinute)}`;

    return {
      useCron,
      cron_interval_minutes: useCron ? intervalTotalMinutes : null,
      cron_start_time: useCron ? cronStartTime : null,
    };
  }

  normalizeMaxPages(value) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) return 300;
    return Math.min(2000, parsed);
  }

  getCreatePayload(runNow = false) {
    const organizationId = Number(this.organizationId || 0);
    const url = this.elements.webUrlInput.value.trim();
    const scope = this.elements.webScopeSelect.value === "whole_domain" ? "whole_domain" : "single_page";
    const useSitemap = Boolean(this.elements.webUseSitemapCheckbox?.checked);
    const useLlmDescription = Boolean(this.elements.webUseLlmDescriptionCheckbox?.checked);
    const maxPages = this.normalizeMaxPages(this.elements.webMaxPagesInput?.value || 300);
    const cron = this.readCronFromCreateForm();

    return {
      organization_id: organizationId,
      url,
      scope,
      use_sitemap: useSitemap,
      max_pages: maxPages,
      use_llm_description: useLlmDescription,
      run_now: runNow,
      use_cron: cron.useCron,
      cron_interval_minutes: cron.cron_interval_minutes,
      cron_start_time: cron.cron_start_time,
    };
  }

  parseCrawlerCron(crawler) {
    const intervalMinutes = Number(crawler?.cron_interval_minutes || 0);
    const intervalDays = Math.floor(intervalMinutes / (24 * 60));
    const remainderAfterDays = intervalMinutes % (24 * 60);
    const intervalHours = Math.floor(remainderAfterDays / 60);
    const intervalMins = remainderAfterDays % 60;

    const start = String(crawler?.cron_start_time || "00:00:00").slice(0, 5);
    const [hourRaw, minuteRaw] = start.split(":");
    const hour = Number(hourRaw || 0);
    const minute = Number(minuteRaw || 0);

    return {
      intervalDays: Number.isInteger(intervalDays) && intervalDays >= 0 ? intervalDays : 1,
      intervalHours: Number.isInteger(intervalHours) && intervalHours >= 0 ? intervalHours : 0,
      intervalMinutes: Number.isInteger(intervalMins) && intervalMins >= 0 ? intervalMins : 0,
      startHour: hour === 0 ? 24 : hour,
      startMinute: Number.isInteger(minute) && minute >= 0 ? minute : 0,
    };
  }

  buildHourOptions(selectedValue) {
    return Array.from({ length: 25 }, (_, index) => {
      const label = index === 24 ? "24" : String(index).padStart(2, "0");
      return `<option value="${index}" ${index === selectedValue ? "selected" : ""}>${label}</option>`;
    }).join("");
  }

  buildDayOptions(selectedValue) {
    return DAY_OPTIONS
      .map((value) => `<option value="${value}" ${value === selectedValue ? "selected" : ""}>${value}d</option>`)
      .join("");
  }

  buildIntervalHourOptions(selectedValue) {
    return HOUR_OPTIONS
      .map((value) => `<option value="${value}" ${value === selectedValue ? "selected" : ""}>${String(value).padStart(2, "0")}h</option>`)
      .join("");
  }

  buildMinuteOptions(selectedValue) {
    return MINUTE_OPTIONS
      .map((value) => `<option value="${value}" ${value === selectedValue ? "selected" : ""}>${String(value).padStart(2, "0")}m</option>`)
      .join("");
  }

  async addCrawler() {
    const organizationId = Number(this.organizationId || 0);
    if (!organizationId) {
      UiHelpers.showAlert(this.elements.webAlert, "Select organization first", "error");
      return;
    }

    const payload = this.getCreatePayload(this.elements.webRunNowCheckbox.checked);
    if (!payload.url) {
      UiHelpers.showAlert(this.elements.webAlert, "URL is required", "error");
      return;
    }

    try {
      const { response, data, rawText } = await this.api.request("/admin/crawl", {
        method: "POST",
        body: payload,
      });

      if (!response.ok) {
        throw new Error(data?.error || rawText || "Failed to save crawler");
      }

      UiHelpers.showAlert(this.elements.webAlert, payload.run_now ? `Crawler started (job: ${data?.job_id || "n/a"})` : "Crawler saved", "success");
      if (payload.run_now && data?.job_id) {
        void this.pollCrawlerStatus(data.job_id);
      }
      this.elements.webUrlInput.value = "";
      await this.refreshCrawlers();
      await this.notifyProjectsRefresh();
    } catch (error) {
      UiHelpers.showAlert(this.elements.webAlert, `Error: ${error.message}`, "error");
    }
  }

  async refreshCrawlers() {
    const organizationId = Number(this.organizationId || 0);
    if (!organizationId) {
      this.selectedCrawlerIds.clear();
      this.elements.webTableContainer.innerHTML = "<div class='no-data'>No organization selected</div>";
      return;
    }

    this.elements.webTableContainer.innerHTML = "<div class='loading'></div><p style='display:inline;'>Loading crawlers...</p>";
    try {
      const { response, data, rawText } = await this.api.request("/admin/list-crawlers", {
        method: "POST",
        body: { organization_id: organizationId },
      });

      if (!response.ok) {
        throw new Error(data?.error || rawText || "Failed to load crawlers");
      }

      this.crawlers = Array.isArray(data?.crawlers) ? data.crawlers : [];
      this.renderCrawlers();
      await this.notifyCrawlerListChange();
    } catch (error) {
      this.elements.webTableContainer.innerHTML = `<div class='no-data' style='color:red;'>${UiHelpers.escapeHtml(error.message)}</div>`;
    }
  }

  renderCrawlers() {
    if (!this.crawlers.length) {
      this.selectedCrawlerIds.clear();
      this.elements.webTableContainer.innerHTML = "<div class='no-data'>No crawlers configured</div>";
      return;
    }

    const validIds = new Set(this.crawlers.map((crawler) => Number(crawler.crawler_id)).filter((id) => id > 0));
    this.selectedCrawlerIds = new Set([...this.selectedCrawlerIds].filter((id) => validIds.has(id)));

    const rows = this.crawlers
      .map((crawler) => {
        const crawlerId = Number(crawler.crawler_id || 0);
        const cron = this.parseCrawlerCron(crawler);
        return `
          <tr data-crawler-row-id="${crawlerId}">
            <td>
              <label class="select-radio">
                <input type="checkbox" name="crawlerSelect" value="${crawlerId}" ${this.selectedCrawlerIds.has(crawlerId) ? "checked" : ""}>
                <span class="radio-dot"></span>
              </label>
            </td>
            <td>${crawlerId}</td>
            <td>${UiHelpers.escapeHtml(crawler.domain_host || "")}</td>
            <td><input type="url" data-field="url" value="${UiHelpers.escapeHtml(crawler.url || "")}"></td>
            <td>
              <select data-field="scope">
                <option value="single_page" ${crawler.scope === "single_page" ? "selected" : ""}>single_page</option>
                <option value="whole_domain" ${crawler.scope === "whole_domain" ? "selected" : ""}>whole_domain</option>
              </select>
            </td>
            <td>
              <label class="toggle-switch">
                <input type="checkbox" data-field="use_sitemap" ${crawler.use_sitemap !== false ? "checked" : ""}>
                <span class="toggle-slider"></span>
              </label>
            </td>
            <td>
              <input type="number" data-field="max_pages" value="${this.normalizeMaxPages(crawler.max_pages)}" min="1" max="2000" step="1">
            </td>
            <td>
              <label class="toggle-switch">
                <input type="checkbox" data-field="use_llm_description" ${crawler.use_llm_description ? "checked" : ""}>
                <span class="toggle-slider"></span>
              </label>
            </td>
            <td>
              <label class="toggle-switch">
                <input type="checkbox" data-field="use_cron" ${crawler.use_cron ? "checked" : ""}>
                <span class="toggle-slider"></span>
              </label>
            </td>
            <td>
              <div class="cron-grid web-interval-grid">
                <select class="web-mini-select" data-field="interval_days">${this.buildDayOptions(cron.intervalDays)}</select>
                <select class="web-mini-select" data-field="interval_hours">${this.buildIntervalHourOptions(cron.intervalHours)}</select>
                <select class="web-mini-select" data-field="interval_minutes">${this.buildMinuteOptions(cron.intervalMinutes)}</select>
              </div>
            </td>
            <td>
              <div class="cron-grid web-start-grid">
                <select class="web-mini-select" data-field="start_hour">${this.buildHourOptions(cron.startHour)}</select>
                <select class="web-mini-select" data-field="start_minute">${this.buildMinuteOptions(cron.startMinute)}</select>
              </div>
            </td>
            <td>${UiHelpers.escapeHtml(this.formatLastRunGmt(crawler.last_run_at))}</td>
            <td>
              <div class="web-actions">
                <button class="secondary" data-run-crawler-id="${crawlerId}">Run</button>
                <button class="success" data-update-crawler-id="${crawlerId}">Update</button>
                <button class="danger" data-delete-crawler-id="${crawlerId}">Delete</button>
              </div>
            </td>
          </tr>
        `;
      })
      .join("");

    this.elements.webTableContainer.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Select</th>
            <th>ID</th>
            <th>Domain</th>
            <th>URL</th>
            <th>Scope</th>
            <th>Use sitemap</th>
            <th>Max pages</th>
            <th>LLM description</th>
            <th>Cron</th>
            <th>Interval (D:H:M)</th>
            <th>Start (H:M)</th>
            <th>Last Run [GMT]</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  getCrawlerRowPayload(crawlerId, runNow = false) {
    const row = this.elements.webTableContainer?.querySelector(`tr[data-crawler-row-id="${crawlerId}"]`);
    if (!row) throw new Error("Crawler row not found");

    const readValue = (field) => row.querySelector(`[data-field="${field}"]`);

    const useSitemap = Boolean(readValue("use_sitemap")?.checked);
    const maxPages = this.normalizeMaxPages(readValue("max_pages")?.value || 300);
    const useLlmDescription = Boolean(readValue("use_llm_description")?.checked);
    const useCron = Boolean(readValue("use_cron")?.checked);
    const intervalDays = Number(readValue("interval_days")?.value || 0);
    const intervalHours = Number(readValue("interval_hours")?.value || 0);
    const intervalMinutes = Number(readValue("interval_minutes")?.value || 0);
    const startHourRaw = Number(readValue("start_hour")?.value || 24);
    const startMinute = Number(readValue("start_minute")?.value || 0);
    const startHour = startHourRaw === 24 ? 0 : startHourRaw;

    return {
      organization_id: Number(this.organizationId || 0),
      crawler_id: crawlerId,
      url: String(readValue("url")?.value || "").trim(),
      scope: String(readValue("scope")?.value || "single_page"),
      use_sitemap: useSitemap,
      max_pages: maxPages,
      use_llm_description: useLlmDescription,
      use_cron: useCron,
      cron_interval_minutes: useCron ? Math.max(1, (intervalDays * 24 * 60) + (intervalHours * 60) + intervalMinutes) : null,
      cron_start_time: useCron ? `${this.toTwoDigit(startHour)}:${this.toTwoDigit(startMinute)}` : null,
      run_now: runNow,
    };
  }

  async updateCrawler(crawlerId) {
    const payload = this.getCrawlerRowPayload(crawlerId, false);
    if (!payload.url) {
      UiHelpers.showAlert(this.elements.webAlert, "URL is required", "error");
      return;
    }

    try {
      const { response, data, rawText } = await this.api.request("/admin/crawl", {
        method: "POST",
        body: payload,
      });

      if (!response.ok) {
        throw new Error(data?.error || rawText || "Failed to update crawler");
      }

      UiHelpers.showAlert(this.elements.webAlert, `Crawler ${crawlerId} updated`, "success");
      await this.refreshCrawlers();
      await this.notifyProjectsRefresh();
    } catch (error) {
      UiHelpers.showAlert(this.elements.webAlert, `Error: ${error.message}`, "error");
    }
  }

  async runCrawler(crawlerId) {
    const organizationId = Number(this.organizationId || 0);
    if (!organizationId) return;

    try {
      const { response, data, rawText } = await this.api.request("/admin/crawl", {
        method: "POST",
        body: {
          organization_id: organizationId,
          crawler_id: crawlerId,
          run_now: true,
        },
      });

      if (!response.ok) {
        throw new Error(data?.error || rawText || "Failed to run crawler");
      }

      UiHelpers.showAlert(this.elements.webAlert, `Crawler started (job: ${data?.job_id || "n/a"})`, "success");
      await this.refreshCrawlers();
      if (data?.job_id) {
        void this.pollCrawlerStatus(data.job_id);
      }
    } catch (error) {
      UiHelpers.showAlert(this.elements.webAlert, `Error: ${error.message}`, "error");
    }
  }

  async cancelCrawler() {
    const organizationId = Number(this.organizationId || 0);
    if (!organizationId) {
      UiHelpers.showAlert(this.elements.webAlert, "Select organization first", "error");
      return;
    }

    try {
      const { response, data, rawText } = await this.api.request("/admin/stop-crawler", {
        method: "POST",
        body: { organization_id: organizationId },
      });

      if (!response.ok) {
        throw new Error(data?.error || rawText || "Failed to cancel crawler");
      }

      UiHelpers.showAlert(this.elements.webAlert, `Crawler cancellation requested (job: ${data?.job_id || "n/a"})`, "success");
      UiHelpers.setStatus(this.elements.webProgressStatus, "Crawler cancellation requested...", "");
      if (data?.job_id) {
        void this.pollCrawlerStatus(data.job_id);
      }
    } catch (error) {
      UiHelpers.showAlert(this.elements.webAlert, `Error: ${error.message}`, "error");
    }
  }

  async pollCrawlerStatus(jobId) {
    const pollingId = String(jobId || "").trim();
    if (!pollingId) return;
    this.activeStatusPollJobId = pollingId;

    const statusElement = this.elements.webProgressStatus;

    for (let attempt = 0; attempt < 1800; attempt += 1) {
      if (this.activeStatusPollJobId !== pollingId) return;

      try {
        const { response, data, rawText } = await this.api.request(`/admin/crawler-status?job_id=${encodeURIComponent(pollingId)}`, {
          method: "GET",
        });

        if (!response.ok) {
          throw new Error(data?.error || rawText || "Failed to load crawler status");
        }

        const state = String(data?.state || "not found");
        const progress = Number(data?.progress || 0);
        const total = Number(data?.total || 0);

        if (state === "processing") {
          UiHelpers.setStatus(statusElement, `Crawler progress: ${progress}/${total || "?"}`, "");
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }

        if (state === "finished") {
          UiHelpers.setStatus(statusElement, `Crawler finished: ${progress}/${total || progress} pages`, "success");
          await this.refreshCrawlers();
          await this.notifyProjectsRefresh();
          return;
        }

        if (state === "failed") {
          UiHelpers.setStatus(statusElement, `Crawler failed: ${UiHelpers.escapeHtml(data?.error || "Unknown error")}`, "error");
          await this.refreshCrawlers();
          return;
        }

        UiHelpers.setStatus(statusElement, "Crawler status not found", "error");
        return;
      } catch (error) {
        UiHelpers.setStatus(statusElement, `Crawler status error: ${error.message}`, "error");
        return;
      }
    }

    UiHelpers.setStatus(statusElement, "Crawler status polling timed out", "error");
  }

  selectAllCrawlers() {
    this.crawlers.forEach((crawler) => {
      const crawlerId = Number(crawler.crawler_id || 0);
      if (crawlerId > 0) this.selectedCrawlerIds.add(crawlerId);
    });
    this.renderCrawlers();
  }

  deselectAllCrawlers() {
    this.selectedCrawlerIds.clear();
    this.renderCrawlers();
  }

  async performDeleteCrawler(crawlerId) {
    const organizationId = Number(this.organizationId || 0);
    if (!organizationId) throw new Error("No organization selected");

    const { response, data, rawText } = await this.api.request("/admin/delete-crawler", {
      method: "POST",
      body: {
        organization_id: organizationId,
        crawler_id: crawlerId,
      },
    });

    if (!response.ok) {
      throw new Error(data?.error || rawText || "Failed to delete crawler");
    }
  }

  async deleteAllSelectedCrawlers() {
    const ids = [...this.selectedCrawlerIds];
    if (!ids.length) {
      UiHelpers.showAlert(this.elements.webAlert, "No crawlers selected", "error");
      return;
    }

    if (!confirm(`Delete ${ids.length} selected crawler(s)?`)) return;

    const results = await runSequential(ids, async (crawlerId) => {
      await this.performDeleteCrawler(crawlerId);
    });

    this.selectedCrawlerIds.clear();
    await this.refreshCrawlers();
    updateBulkStatus(this.elements.webAlert, results, "Delete crawlers");
  }

  async deleteCrawler(crawlerId) {
    if (!confirm(`Delete crawler ${crawlerId}?`)) return;

    try {
      await this.performDeleteCrawler(crawlerId);
      this.selectedCrawlerIds.delete(Number(crawlerId || 0));
      UiHelpers.showAlert(this.elements.webAlert, "Crawler deleted", "success");
      await this.refreshCrawlers();
    } catch (error) {
      UiHelpers.showAlert(this.elements.webAlert, `Error: ${error.message}`, "error");
    }
  }
}

export { WebSection };

