class UiHelpers {
  static showAlert(element, message, type = "error") {
    if (!element) return;
    element.textContent = message;
    element.className = `alert ${type}`;
    element.style.visibility = "visible";
    clearTimeout(element.dataset.timeoutId);
    const timeoutId = window.setTimeout(() => {
      element.style.visibility = "hidden";
    }, 5000);
    element.dataset.timeoutId = String(timeoutId);
  }

  static setStatus(element, message, type = "") {
    if (!element) return;
    element.textContent = message;
    element.className = `status ${type}`.trim();
    element.style.visibility = "visible";
    clearTimeout(element.dataset.timeoutId);
    element.classList.toggle("hidden", !message);
  }

  static toggleDisplay(element, shouldShow) {
    if (!element) return;
    element.classList.toggle("hidden", !shouldShow);
  }

  static escapeHtml(text) {
    if (text === null || text === undefined) return "";
    return String(text).replace(/[&<>"']/g, (char) => {
      const map = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      };
      return map[char] || char;
    });
  }
}

class TabManager {
  constructor(container, onSwitch) {
    this.container = container;
    this.buttons = container ? Array.from(container.querySelectorAll("[data-tab]")) : [];
    this.onSwitch = onSwitch;

    this.buttons.forEach((button) => {
      button.addEventListener("click", () => this.activate(button.dataset.tab));
    });
  }

  activate(tabId) {
    this.buttons.forEach((button) => {
      button.classList.toggle("active", button.dataset.tab === tabId);
    });
    if (this.onSwitch) {
      this.onSwitch(tabId);
    }
  }
}

function selectAllIds(items, idGetter) {
  return new Set((Array.isArray(items) ? items : []).map((item) => idGetter(item)).filter((id) => id !== null && id !== undefined));
}

function getSelectedIds(selectedSet) {
  return Array.from(selectedSet || []).filter((id) => id !== null && id !== undefined);
}

function clearSelectedIds(selectedSet) {
  if (selectedSet && typeof selectedSet.clear === "function") {
    selectedSet.clear();
  }
}

export { UiHelpers, TabManager, selectAllIds, getSelectedIds, clearSelectedIds };
