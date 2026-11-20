"use strict";

const api = globalThis.browser ?? globalThis.chrome;
const providers = globalThis.TLDRProviders;
const byId = (id) => document.getElementById(id);
const provider = byId("provider");
const baseUrl = byId("base-url");
const apiKey = byId("api-key");
const model = byId("model");
const prompt = byId("prompt");
const loadModels = byId("load-models");
const save = byId("save");
const isFirefox = typeof globalThis.browser?.runtime?.getBrowserInfo === "function";
const consentError = "Firefox authentication information permission is required to send an API key. Grant it by saving settings or loading models, or enable it in about:addons under Permissions and data.";
let shortcutName;

function setStatus(id, message, isError = false) {
  const element = byId(id);
  element.textContent = message;
  element.classList.toggle("error", isError);
}

function errorMessage(error) {
  return error && error.message ? error.message : String(error);
}

function readConfig() {
  return {
    provider: provider.value,
    baseUrl: baseUrl.value.trim(),
    apiKey: apiKey.value.trim(),
    model: model.value.trim(),
    prompt: prompt.value,
  };
}

function showConfig(config = {}) {
  provider.value = Object.hasOwn(providers.defaults, config.provider) ? config.provider : "openai";
  baseUrl.value = config.baseUrl ?? providers.defaults[provider.value].baseUrl;
  apiKey.value = config.apiKey ?? "";
  model.value = config.model ?? "";
  prompt.value = config.prompt ?? providers.defaultPrompt;
  updateHttpWarning();
}

function updateHttpWarning() {
  const warning = byId("url-warning");
  let insecure = false;
  try {
    const url = new URL(baseUrl.value.trim());
    const host = url.hostname.toLowerCase();
    const loopback = host === "localhost" || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host);
    insecure = url.protocol === "http:" && !loopback;
  } catch (_) {
    // Validation reports malformed URLs when an action is attempted.
  }
  warning.hidden = !insecure;
  warning.textContent = insecure ? "Remote HTTP is not allowed. Use HTTPS, or HTTP on a loopback address for a local service." : "";
}

// Called synchronously from each click handler, before any asynchronous work.
function requestAccess(config) {
  if (!api?.permissions?.request) {
    throw new Error(isFirefox && config.apiKey ? consentError : "This browser does not support requesting host permissions.");
  }
  const requested = { origins: [providers.hostPermissionPattern(config.baseUrl)] };
  if (isFirefox && config.apiKey) requested.data_collection = ["authenticationInfo"];
  try {
    return Promise.resolve(api.permissions.request(requested)).catch(() => {
      throw new Error(isFirefox && config.apiKey ? consentError : "Could not request host permission.");
    });
  } catch (error) {
    throw new Error(isFirefox && config.apiKey ? consentError : errorMessage(error));
  }
}

async function checkConsent(config) {
  if (!isFirefox || !config.apiKey) return;
  try {
    if (!api.permissions?.getAll || !api.permissions?.contains) throw new Error();
    const all = await api.permissions.getAll();
    if (!Array.isArray(all?.data_collection) || !await api.permissions.contains({ data_collection: ["authenticationInfo"] })) throw new Error();
  } catch (_) {
    throw new Error(consentError);
  }
}

function setConnectionBusy(busy) {
  for (const element of [provider, baseUrl, apiKey, model, prompt, loadModels, save, byId("reset-prompt"), byId("clear-key")]) {
    element.disabled = busy;
  }
}

provider.addEventListener("change", () => {
  baseUrl.value = providers.defaults[provider.value].baseUrl;
  apiKey.value = "";
  model.value = "";
  byId("model-list").replaceChildren();
  updateHttpWarning();
});
baseUrl.addEventListener("input", () => {
  byId("model-list").replaceChildren();
  updateHttpWarning();
});
byId("reset-prompt").addEventListener("click", () => {
  prompt.value = providers.defaultPrompt;
  setStatus("save-status", "Default prompt restored. Save settings to apply it.");
});
byId("clear-key").addEventListener("click", async () => {
  setConnectionBusy(true);
  try {
    const { config } = await api.storage.local.get("config");
    if (config) await api.storage.local.set({ config: { ...config, apiKey: "" } });
    apiKey.value = "";
    setStatus("save-status", "Saved API key cleared. Enter a key before using a provider that requires one.");
  } catch (error) {
    setStatus("save-status", errorMessage(error), true);
  } finally {
    setConnectionBusy(false);
  }
});

loadModels.addEventListener("click", () => {
  let config;
  let permission;
  try {
    config = providers.validateConfig(readConfig(), { requireModel: false });
    permission = requestAccess(config);
  } catch (error) {
    setStatus("connection-status", errorMessage(error), true);
    return;
  }
  setConnectionBusy(true);
  setStatus("connection-status", "Loading models...");
  Promise.resolve(permission).then(async (granted) => {
    if (!granted) throw new Error(isFirefox && config.apiKey ? `${consentError} Models were not loaded.` : "Permission was not granted. Models were not loaded.");
    await checkConsent(config);
    return providers.listModels(config, { beforeRequest: () => checkConsent(config) });
  }).then((models) => {
    const list = byId("model-list");
    list.replaceChildren();
    for (const name of models) {
      const option = document.createElement("option");
      option.value = name;
      list.append(option);
    }
    setStatus("connection-status", models.length ? `Loaded ${models.length} model${models.length === 1 ? "" : "s"}.` : "No models found. You can still enter a model name.");
  }).catch((error) => {
    setStatus("connection-status", errorMessage(error), true);
  }).finally(() => setConnectionBusy(false));
});

save.addEventListener("click", () => {
  let config;
  let permission;
  try {
    config = providers.validateConfig(readConfig());
    permission = requestAccess(config);
  } catch (error) {
    setStatus("save-status", errorMessage(error), true);
    return;
  }
  setConnectionBusy(true);
  setStatus("save-status", "Saving settings...");
  Promise.resolve(permission).then(async (granted) => {
    if (!granted) throw new Error(isFirefox && config.apiKey ? `${consentError} Settings were not saved.` : "Permission was not granted. Settings were not saved.");
    await checkConsent(config);
    return api.storage.local.set({ config });
  }).then(() => {
    showConfig(config);
    setStatus("save-status", "Settings saved.");
  }).catch((error) => {
    setStatus("save-status", errorMessage(error), true);
  }).finally(() => setConnectionBusy(false));
});

async function loadShortcut() {
  const isFirefox = /Firefox\//.test(navigator.userAgent);
  if (!isFirefox) {
    byId("shortcut-instructions").hidden = false;
    return;
  }
  if (!api?.commands?.getAll || !api.commands.update || !api.commands.reset) {
    setStatus("shortcut-status", "Shortcut editing is unavailable in this browser. The default is Alt+Shift+S.", true);
    return;
  }
  try {
    const commands = await api.commands.getAll();
    const command = commands.find((item) => item.name === "summarize");
    if (!command) throw new Error("No extension shortcut is available.");
    shortcutName = command.name;
    byId("shortcut").value = command.shortcut || "";
    byId("shortcut-firefox").hidden = false;
  } catch (error) {
    setStatus("shortcut-status", errorMessage(error), true);
  }
}

byId("save-shortcut").addEventListener("click", async () => {
  const value = byId("shortcut").value.trim();
  const button = byId("save-shortcut");
  button.disabled = true;
  byId("reset-shortcut").disabled = true;
  setStatus("shortcut-status", "Updating shortcut...");
  try {
    await api.commands.update({ name: shortcutName, shortcut: value });
    const commands = await api.commands.getAll();
    const updated = commands.find((item) => item.name === shortcutName)?.shortcut || "";
    byId("shortcut").value = updated;
    setStatus("shortcut-status", !value ? "Shortcut removed." : updated ? "Shortcut updated." : "The browser did not assign this shortcut. It may be unavailable or already in use.", Boolean(value && !updated));
  } catch (error) {
    setStatus("shortcut-status", errorMessage(error), true);
  } finally {
    button.disabled = false;
    byId("reset-shortcut").disabled = false;
  }
});

byId("reset-shortcut").addEventListener("click", async () => {
  const button = byId("reset-shortcut");
  button.disabled = true;
  byId("save-shortcut").disabled = true;
  setStatus("shortcut-status", "Resetting shortcut...");
  try {
    await api.commands.reset(shortcutName);
    const commands = await api.commands.getAll();
    byId("shortcut").value = commands.find((item) => item.name === shortcutName)?.shortcut || "";
    setStatus("shortcut-status", "Shortcut reset to the browser default.");
  } catch (error) {
    setStatus("shortcut-status", errorMessage(error), true);
  } finally {
    button.disabled = false;
    byId("save-shortcut").disabled = false;
  }
});

byId("delete-all").addEventListener("click", async () => {
  if (!confirm("Delete existing summaries and cancel queued, running, or pending capture requests? This cannot be undone.")) return;
  const button = byId("delete-all");
  button.disabled = true;
  setStatus("delete-status", "Deleting saved summaries...");
  try {
    const result = await api.runtime.sendMessage({ type: "deleteAll" });
    if (!result?.ok) throw new Error(result?.error || "Could not delete saved summaries.");
    setStatus("delete-status", "Saved summaries deleted.");
  } catch (error) {
    setStatus("delete-status", errorMessage(error), true);
  } finally {
    button.disabled = false;
  }
});

async function initialize() {
  setConnectionBusy(true);
  try {
    const stored = await api.storage.local.get("config");
    showConfig(stored.config);
  } catch (error) {
    showConfig();
    setStatus("save-status", `Could not load settings: ${errorMessage(error)}`, true);
  } finally {
    setConnectionBusy(false);
  }
  loadShortcut();
}

initialize();
