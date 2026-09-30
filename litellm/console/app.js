(function () {
  "use strict";

  var API_KEY_STORAGE = "litellm_console_key";
  var editingSite = null; // null = not editing, string = site name

  function $(id) { return document.getElementById(id); }

  // Works both directly (http://host:8001/console/) and behind the /llm
  // traefik prefix (https://domain/llm/console/): derive the mount prefix
  // from the current URL so API calls follow the console location.
  var BASE_PREFIX = (function () {
    var pathname = window.location.pathname;
    var match = pathname.match(/^(.*)\/console\/?$/);
    return match ? match[1] : "";
  })();

  function url(path) {
    return BASE_PREFIX + "/" + path.replace(/^\//, "");
  }

  function getApiKey() {
    return sessionStorage.getItem(API_KEY_STORAGE) || "";
  }

  function showError(message) {
    var box = $("error");
    if (!message) {
      box.classList.add("hidden");
      box.textContent = "";
      return;
    }
    box.classList.remove("hidden");
    box.textContent = message;
  }

  function api(method, path, body) {
    var init = {
      method: method,
      headers: {
        "Authorization": "Bearer " + getApiKey(),
        "Content-Type": "application/json"
      }
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    return fetch(url(path), init).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (payload) {
        if (!response.ok) {
          throw new Error(payload.error || ("HTTP " + response.status));
        }
        return payload;
      });
    });
  }

  // ---------- key handling ----------

  function activeTab() {
    var active = document.querySelector("nav button.active");
    return active ? active.dataset.tab : "sites";
  }

  function loadActiveTab() {
    if (activeTab() === "settings") {
      loadSettings();
    } else {
      loadSites();
    }
  }

  function refreshKeyStatus() {
    var hasKey = !!getApiKey();
    $("keyStatus").textContent = hasKey ? "logged in" : "not logged in";
    $("saveKey").textContent = hasKey ? "Logout" : "Login";
  }

  function logout() {
    sessionStorage.removeItem(API_KEY_STORAGE);
    $("siteForm").classList.add("hidden");
    $("settingsForm").reset();
    $("sitesTable").querySelector("tbody").innerHTML = "";
    showError("");
    refreshKeyStatus();
  }

  $("saveKey").addEventListener("click", function () {
    if (getApiKey()) {
      logout();
      return;
    }

    var candidate = $("apiKey").value.trim();
    if (!candidate) {
      showError("Enter the admin API key first");
      return;
    }

    sessionStorage.setItem(API_KEY_STORAGE, candidate);
    api("GET", "admin/settings").then(function () {
      showError("");
      refreshKeyStatus();
      loadActiveTab();
    }).catch(function (err) {
      sessionStorage.removeItem(API_KEY_STORAGE);
      refreshKeyStatus();
      showError("Login failed: " + err.message);
    });
  });

  // ---------- tabs ----------

  var tabs = document.querySelectorAll("nav button");
  tabs.forEach(function (button) {
    button.addEventListener("click", function () {
      tabs.forEach(function (b) { b.classList.remove("active"); });
      button.classList.add("active");
      var tab = button.dataset.tab;
      $("tab-sites").classList.toggle("hidden", tab !== "sites");
      $("tab-settings").classList.toggle("hidden", tab !== "settings");
      showError("");
      if (tab === "sites") loadSites();
      if (tab === "settings") loadSettings();
    });
  });

  // ---------- sites ----------

  function renderSites(sites) {
    var tbody = $("sitesTable").querySelector("tbody");
    tbody.innerHTML = "";
    sites.forEach(function (site) {
      var tr = document.createElement("tr");
      tr.dataset.site = site.site;

      function cell(text) {
        var td = document.createElement("td");
        td.textContent = text === null || text === undefined ? "" : String(text);
        return td;
      }

      tr.appendChild(cell(site.site));
      tr.appendChild(cell(site.model));
      tr.appendChild(cell(site.api_base));
      tr.appendChild(cell(site.api_key_set ? "set" : "missing"));
      tr.appendChild(cell(site.thinking_model ? (site.thinking_effort || "yes") : "no"));
      tr.appendChild(cell(Array.isArray(site.tools) ? site.tools.length : 0));

      var actionTd = document.createElement("td");
      actionTd.textContent = "edit";
      tr.appendChild(actionTd);

      tr.addEventListener("click", function () { openSiteForm(site.site); });
      tbody.appendChild(tr);
    });
  }

  function loadSites() {
    return api("GET", "admin/sites").then(function (payload) {
      renderSites(payload.sites || []);
    }).catch(function (err) {
      showError(err.message);
    });
  }

  function markSelected(site) {
    var rows = $("sitesTable").querySelectorAll("tbody tr");
    rows.forEach(function (row) {
      row.classList.toggle("selected", row.dataset.site === site);
    });
  }

  function parseJsonField(value, label) {
    var trimmed = (value || "").trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed);
    } catch (err) {
      throw new Error(label + " is not valid JSON");
    }
  }

  function openSiteForm(siteName) {
    editingSite = siteName;
    showError("");

    var loadPromise;
    if (siteName) {
      $("formTitle").textContent = "Edit site: " + siteName;
      $("fSite").value = siteName;
      $("fSite").disabled = true;
      $("deleteSite").classList.remove("hidden");
      loadPromise = api("GET", "admin/sites/" + encodeURIComponent(siteName)).then(function (site) {
        $("fInstructions").value = site.instructions || "";
        $("fModel").value = site.model || "";
        $("fApiBase").value = site.api_base || "";
        $("fApiKey").value = "";
        $("fApiKeyHint").textContent = site.api_key_set ? ("current: " + (site.api_key_hint || "set")) : "no key set";
        $("fThinkingModel").checked = !!site.thinking_model;
        $("fThinkingEffort").value = site.thinking_effort || "";
        $("fTools").value = site.tools ? JSON.stringify(site.tools, null, 2) : "";
        $("fToolChoice").value = site.tool_choice || "";
        $("fInclude").value = site.include ? JSON.stringify(site.include, null, 2) : "";
        markSelected(siteName);
      });
    } else {
      $("formTitle").textContent = "New site";
      $("siteForm").reset();
      $("fSite").disabled = false;
      $("fApiKeyHint").textContent = "";
      $("deleteSite").classList.add("hidden");
      loadPromise = Promise.resolve();
    }

    loadPromise.then(function () {
      $("siteForm").classList.remove("hidden");
    }).catch(function (err) {
      showError(err.message);
    });
  }

  $("newSite").addEventListener("click", function () { openSiteForm(null); });
  $("reloadSites").addEventListener("click", loadSites);
  $("cancelSite").addEventListener("click", function () {
    $("siteForm").classList.add("hidden");
    editingSite = null;
    markSelected(null);
  });

  $("deleteSite").addEventListener("click", function () {
    if (!editingSite) return;
    if (!window.confirm("Delete site '" + editingSite + "'?")) return;
    api("DELETE", "admin/sites/" + encodeURIComponent(editingSite)).then(function () {
      $("siteForm").classList.add("hidden");
      editingSite = null;
      loadSites();
    }).catch(function (err) {
      showError(err.message);
    });
  });

  $("siteForm").addEventListener("submit", function (event) {
    event.preventDefault();
    showError("");

    var tools, include;
    try {
      tools = parseJsonField($("fTools").value, "Tools");
      include = parseJsonField($("fInclude").value, "Include");
    } catch (err) {
      showError(err.message);
      return;
    }

    var apiKeyValue = $("fApiKey").value.trim();
    if (!editingSite && !apiKeyValue) {
      showError("API key is required when creating a site");
      return;
    }

    var payload = {
      site: $("fSite").value.trim(),
      instructions: $("fInstructions").value || null,
      model: $("fModel").value.trim() || null,
      api_base: $("fApiBase").value.trim() || null,
      api_key: apiKeyValue || null,
      thinking_model: $("fThinkingModel").checked,
      thinking_effort: $("fThinkingEffort").value || null,
      tools: tools,
      tool_choice: $("fToolChoice").value.trim() || null,
      include: include
    };

    var request;
    if (editingSite) {
      request = api("PUT", "admin/sites/" + encodeURIComponent(editingSite), payload);
    } else {
      request = api("POST", "admin/sites", payload);
    }

    request.then(function () {
      $("siteForm").classList.add("hidden");
      editingSite = null;
      loadSites();
    }).catch(function (err) {
      showError(err.message);
    });
  });

  // ---------- settings ----------

  function loadSettings() {
    return api("GET", "admin/settings").then(function (settings) {
      $("sTokenDuration").value = settings.token_duration;
      $("sAllowlist").value = (settings.allowlist || []).join("\n");
      $("sReloadKey").value = settings.reload_key || "";
    }).catch(function (err) {
      showError(err.message);
    });
  }

  $("settingsForm").addEventListener("submit", function (event) {
    event.preventDefault();
    showError("");

    var allowlist = $("sAllowlist").value
      .split("\n")
      .map(function (line) { return line.trim(); })
      .filter(function (line) { return line.length > 0; });

    var payload = {
      token_duration: parseInt($("sTokenDuration").value, 10) || null,
      allowlist: allowlist,
      regenerate_reload_key: false
    };

    api("PUT", "admin/settings", payload).then(function () {
      loadSettings();
    }).catch(function (err) {
      showError(err.message);
    });
  });

  $("regenReloadKey").addEventListener("click", function () {
    if (!window.confirm("Regenerate reload key? The old key stops working immediately.")) return;
    api("PUT", "admin/settings", { regenerate_reload_key: true }).then(function () {
      loadSettings();
    }).catch(function (err) {
      showError(err.message);
    });
  });

  // ---------- init ----------

  $("apiKey").value = getApiKey();
  refreshKeyStatus();
  if (getApiKey()) {
    loadActiveTab();
  }
})();
