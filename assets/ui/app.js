"use strict";

/* AI CHAT ARCHIVE — 纯原生前端逻辑
   ES2020 / 无框架 / 无构建 / 无外部依赖。 */

(() => {
  // ---------- 小工具 ----------

  const $ = (id) => document.getElementById(id);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const WEIGHT_KEYS = ["fts", "pinyin", "vec"];
  const NUMBER_FORMAT = new Intl.NumberFormat("zh-CN");
  const BUTTON_LABELS = new WeakMap();
  const requestFrame = window.requestAnimationFrame
    ? window.requestAnimationFrame.bind(window)
    : (callback) => window.setTimeout(callback, 16);

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function paintWeightValues() {
    for (const key of WEIGHT_KEYS) {
      const input = ui.weightInputs[key];
      const output = ui.weightOutputs[key];
      if (!input || !output) continue;
      output.textContent = normalizeWeight(input.value).toFixed(1);
    }
  }

  let weightFrame = 0;
  function scheduleWeightPaint() {
    if (weightFrame) return;
    weightFrame = requestFrame(() => {
      weightFrame = 0;
      paintWeightValues();
    });
  }

  function normalizeWeight(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 1;
    return Math.round(Math.min(2, Math.max(0, number)) * 10) / 10;
  }

  function formatCount(value) {
    if (value === null || value === undefined || value === "") return "—";
    const number = Number(value);
    return Number.isFinite(number) ? NUMBER_FORMAT.format(number) : "—";
  }

  function formatScore(value) {
    if (value === null || value === undefined || value === "") return "—";
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(3) : "—";
  }

  function formatVia(value) {
    if (Array.isArray(value)) {
      const parts = value
        .filter((item) => item !== null && item !== undefined && String(item).trim() !== "")
        .map((item) => String(item));
      return parts.length ? parts.join("+") : "—";
    }
    if (typeof value === "string" && value.trim()) return value.trim();
    return "—";
  }

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function formatTime(value) {
    if (value === null || value === undefined || value === "") return "—";

    let date;
    if (value instanceof Date) {
      date = value;
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) return "—";
      date = new Date(value < 1e12 ? value * 1000 : value);
    } else {
      const text = String(value).trim();
      if (!text) return "—";
      if (/^\d+(\.\d+)?$/.test(text)) {
        const number = Number(text);
        date = new Date(number < 1e12 ? number * 1000 : number);
      } else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text)) {
        date = new Date(text.replace(" ", "T"));
      } else {
        date = new Date(text);
      }
    }

    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return String(value);
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  }

  function formatBytes(value) {
    if (value === null || value === undefined || value === "") return "—";
    if (typeof value === "string" && !Number.isFinite(Number(value))) return value;
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return "—";

    const units = ["B", "KB", "MB", "GB", "TB"];
    let size = bytes;
    let index = 0;
    while (size >= 1024 && index < units.length - 1) {
      size /= 1024;
      index += 1;
    }
    const digits = size >= 100 ? 0 : size >= 10 ? 1 : 2;
    return `${size.toFixed(digits)} ${units[index]}`;
  }

  function summarize(value, maxLength = 260) {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    if (!text) return "（无内容）";
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
  }

  function getErrorMessage(error) {
    if (error instanceof Error && error.message) return error.message;
    return String(error);
  }

  function setButtonBusy(button, busy, label) {
    if (!button) return;
    if (busy) {
      if (!BUTTON_LABELS.has(button)) BUTTON_LABELS.set(button, button.textContent);
      button.disabled = true;
      button.textContent = label;
      button.setAttribute("aria-busy", "true");
      return;
    }
    const original = BUTTON_LABELS.get(button);
    if (original !== undefined) button.textContent = original;
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }

  function writeLog(node, text) {
    if (!node) return;
    node.classList.remove("is-error");
    node.textContent = text === null || text === undefined ? "" : String(text);
    node.scrollTop = node.scrollHeight;
  }

  function writeErrorLog(node, text) {
    if (!node) return;
    node.classList.add("is-error");
    node.textContent = String(text);
    node.scrollTop = node.scrollHeight;
  }

  function appendLog(node, text) {
    if (!node) return;
    node.textContent += String(text);
    node.scrollTop = node.scrollHeight;
  }

  function setStatusAlert(message) {
    if (!ui.statusAlert) return;
    if (!message) {
      ui.statusAlert.hidden = true;
      ui.statusAlert.textContent = "";
      return;
    }
    ui.statusAlert.hidden = false;
    ui.statusAlert.textContent = message;
  }

  function readOptionalPositiveInt(input, label) {
    const raw = input.value.trim();
    if (!raw) return null;
    const number = Number(raw);
    if (!Number.isInteger(number) || number < 1) {
      throw new Error(`${label} 必须是大于 0 的整数`);
    }
    return number;
  }

  function providerLabel(provider) {
    return provider === "cloud" ? "云端 API" : "本地 Ollama";
  }

  // ---------- 网络 ----------

  async function extractResponseError(response) {
    let text = "";
    try {
      text = await response.text();
    } catch (error) {
      return `HTTP ${response.status}`;
    }
    if (text) {
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed.error === "string" && parsed.error) return parsed.error;
      } catch (error) {
        // 非 JSON 错误体，直接展示文本。
      }
      const trimmed = text.trim();
      if (trimmed) return trimmed;
    }
    return `HTTP ${response.status}`;
  }

  async function requestJson(path, options = {}) {
    const init = {
      method: options.method || "GET",
      headers: { Accept: "application/json" },
    };
    if (options.body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }

    const response = await fetch(path, init);
    if (!response.ok) throw new Error(await extractResponseError(response));

    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error("服务端返回了无法解析的 JSON");
    }
  }

  // ---------- DOM ----------

  const ui = {
    status: document.querySelector('[data-testid="status"]'),
    statusDbPath: $("status-db-path"),
    statusConversations: $("status-conversations"),
    statusMessages: $("status-messages"),
    statusEmbedded: $("status-embedded"),
    statusOllama: $("status-ollama"),
    statusAlert: $("status-alert"),

    queryInput: $("query-input"),
    btnSearch: $("btn-search"),
    searchLog: $("search-log"),
    searchSummary: $("search-summary"),
    results: $("results"),
    memories: $("memories"),
    facts: $("facts"),
    memoriesCount: $("memories-count"),
    factsCount: $("facts-count"),

    weightInputs: {
      fts: $("weight-fts"),
      pinyin: $("weight-pinyin"),
      vec: $("weight-vec"),
    },
    weightOutputs: {
      fts: $("weight-fts-value"),
      pinyin: $("weight-pinyin-value"),
      vec: $("weight-vec-value"),
    },

    importPaths: $("import-paths"),
    importLog: $("import-log"),
    importStatus: $("import-status"),
    importFiles: $("import-files"),
    importConversations: $("import-conversations"),
    importNewMessages: $("import-new-messages"),
    btnImport: $("btn-import"),
    btnIndex: $("btn-index"),

    distillProvider: $("distill-provider"),
    distillBaseUrl: $("distill-baseurl"),
    distillModel: $("distill-model"),
    distillModelLabel: $("distill-model-label"),
    distillApiKey: $("distill-apikey"),
    distillMode: $("distill-mode"),
    distillLimit: $("distill-limit"),
    distillMaxChars: $("distill-maxchars"),
    distillLog: $("distill-log"),
    btnDistill: $("btn-distill"),
    cloudOnlyFields: $$("[data-cloud-only]"),

    modelInput: $("model-input"),
    btnPullModel: $("btn-pull-model"),
    presetButtons: $$(".preset[data-model]"),
    models: $("models"),
    modelsSummary: $("models-summary"),
    modelLog: $("log"),

    configFts: $("config-fts"),
    configPinyin: $("config-pinyin"),
    configVec: $("config-vec"),
    configBaseUrl: $("config-baseurl"),
    configModel: $("config-model"),
    configApiKey: $("config-apikey"),
    configLog: $("config-log"),
    btnSaveConfig: $("btn-save-config"),

    settingsDbPath: $("settings-db-path"),
    settingsEmbedProvider: $("settings-embed-provider"),
    settingsEmbedModel: $("settings-embed-model"),
    settingsEmbedDim: $("settings-embed-dim"),
  };

  const configWeightInputs = {
    fts: ui.configFts,
    pinyin: ui.configPinyin,
    vec: ui.configVec,
  };

  const app = {
    data: null,
    installedModels: [],
    ollamaAvailable: null,
    llmHasKey: false,
    busy: {
      search: false,
      import: false,
      index: false,
      distill: false,
      save: false,
    },
    pulling: false,
  };

  // ---------- 权重 ----------

  function applyWeights(weights) {
    for (const key of WEIGHT_KEYS) {
      const value = normalizeWeight(weights && weights[key]);
      const searchInput = ui.weightInputs[key];
      const searchOutput = ui.weightOutputs[key];
      const configInput = configWeightInputs[key];

      if (searchInput) searchInput.value = value.toFixed(1);
      if (searchOutput) searchOutput.textContent = value.toFixed(1);
      if (configInput) configInput.value = String(value);
    }
  }

  function readSearchWeights() {
    const weights = {};
    for (const key of WEIGHT_KEYS) {
      weights[key] = normalizeWeight(ui.weightInputs[key] ? ui.weightInputs[key].value : 1);
    }
    return weights;
  }

  // ---------- 状态栏与模型列表 ----------

  function setOllamaStatus(available, models) {
    const count = Array.isArray(models) ? models.length : 0;
    if (available) {
      ui.statusOllama.textContent = `可用 · ${formatCount(count)} 个模型`;
      ui.statusOllama.classList.remove("is-offline");
      ui.statusOllama.title = "Ollama 可用";
    } else {
      ui.statusOllama.textContent = "不可用";
      ui.statusOllama.classList.add("is-offline");
      ui.statusOllama.title = "Ollama 不可用";
    }
  }

  function renderModels(models, available) {
    const list = Array.isArray(models) ? models : [];
    app.installedModels = list;
    app.ollamaAvailable = available;

    if (available === false) {
      ui.modelsSummary.textContent = list.length
        ? `${formatCount(list.length)} 个已安装 · 服务不可用`
        : "Ollama 不可用";
    } else if (available === true) {
      ui.modelsSummary.textContent = `${formatCount(list.length)} 个已安装`;
    } else {
      ui.modelsSummary.textContent = `${formatCount(list.length)} 个已安装`;
    }

    if (!list.length) {
      const message = available === false ? "Ollama 不可用，暂无模型" : "暂无已安装模型";
      ui.models.replaceChildren(el("li", "empty empty--item", message));
      return;
    }

    const fragment = document.createDocumentFragment();
    list.forEach((model, index) => {
      const name = typeof model === "string"
        ? model
        : model && typeof model === "object"
          ? String(model.name || "未命名模型")
          : "未命名模型";
      const size = typeof model === "object" && model !== null ? model.size : null;

      const item = el("li", "model-item");
      item.append(
        el("span", "model-index", pad2(index + 1)),
        el("span", "model-name", name),
        el("span", "model-size", formatBytes(size)),
      );
      fragment.append(item);
    });
    ui.models.replaceChildren(fragment);
  }

  function fillSettingsReadonly(data) {
    const db = data.db && typeof data.db === "object" ? data.db : {};
    const providers = data.providers && typeof data.providers === "object" ? data.providers : {};
    const embed = providers.embed && typeof providers.embed === "object" ? providers.embed : {};

    const dbPath = db.path ? String(db.path) : "未配置";
    ui.settingsDbPath.textContent = dbPath;
    ui.settingsDbPath.title = dbPath;

    ui.settingsEmbedProvider.textContent = embed.provider ? String(embed.provider) : "—";
    ui.settingsEmbedModel.textContent = embed.model ? String(embed.model) : "—";
    ui.settingsEmbedDim.textContent = embed.dim !== null && embed.dim !== undefined && embed.dim !== ""
      ? String(embed.dim)
      : "—";
  }

  function syncKeyHints() {
    const hint = app.llmHasKey ? "已保存，留空不修改" : "未配置 API Key";
    if (ui.distillApiKey) ui.distillApiKey.placeholder = hint;
    if (ui.configApiKey) ui.configApiKey.placeholder = hint;
  }

  function applyState(data) {
    if (!data || typeof data !== "object") throw new Error("状态响应格式不正确");
    app.data = data;
    setStatusAlert("");

    const db = data.db && typeof data.db === "object" ? data.db : {};
    const providers = data.providers && typeof data.providers === "object" ? data.providers : {};
    const llm = providers.llm && typeof providers.llm === "object" ? providers.llm : {};
    const ollama = data.ollama && typeof data.ollama === "object" ? data.ollama : {};
    const available = Boolean(ollama.available);
    const models = Array.isArray(ollama.models) ? ollama.models : [];

    const dbPath = db.path ? String(db.path) : "未配置";
    ui.statusDbPath.textContent = dbPath;
    ui.statusDbPath.title = dbPath;
    ui.statusConversations.textContent = formatCount(db.conversations);
    ui.statusMessages.textContent = formatCount(db.messages);
    ui.statusEmbedded.textContent = formatCount(db.embedded);

    setOllamaStatus(available, models);
    renderModels(models, available);
    fillSettingsReadonly(data);

    if (data.weights && typeof data.weights === "object") {
      applyWeights(data.weights);
    } else {
      paintWeightValues();
    }

    const baseUrl = llm.baseUrl ? String(llm.baseUrl) : "";
    const model = llm.model ? String(llm.model) : "";
    if (baseUrl) {
      ui.distillBaseUrl.value = baseUrl;
      ui.configBaseUrl.value = baseUrl;
    }
    if (model) {
      ui.distillModel.value = model;
      ui.configModel.value = model;
    }

    app.llmHasKey = Boolean(llm.hasKey);
    syncKeyHints();
  }

  function showStateError(error) {
    const message = getErrorMessage(error);
    console.error("加载 /api/state 失败", error);
    setStatusAlert(`状态加载失败：${message}`);
    ui.statusDbPath.textContent = "不可用";
    ui.statusDbPath.title = message;
    ui.statusConversations.textContent = "—";
    ui.statusMessages.textContent = "—";
    ui.statusEmbedded.textContent = "—";
    ui.statusOllama.textContent = "未知";
    ui.statusOllama.classList.remove("is-offline");
    ui.statusOllama.title = "Ollama 状态未知";
    ui.modelsSummary.textContent = "无法加载";
    ui.models.replaceChildren(el("li", "empty empty--item", "无法读取模型列表"));
  }

  async function loadState() {
    try {
      const data = await requestJson("/api/state");
      applyState(data);
    } catch (error) {
      showStateError(error);
    }
  }

  // ---------- 01 检索 ----------

  function renderResults(messages, elapsedMs) {
    const list = Array.isArray(messages) ? messages : [];
    if (!list.length) {
      ui.results.replaceChildren(el("p", "empty", "无结果"));
    } else {
      const fragment = document.createDocumentFragment();
      list.forEach((message) => {
        const item = el("article", "result-item");
        const meta = el("div", "result-meta");
        const title = message && typeof message === "object" ? message.title : "";
        const source = message && typeof message === "object" ? message.source : "";
        const content = message && typeof message === "object" ? message.content : "";

        meta.append(
          el("span", "result-score", `score ${formatScore(message && message.score)}`),
          el("span", "via-tag", `via ${formatVia(message && message.via)}`),
          el("span", "result-meta-text", `来源 ${source ? String(source) : "未知"}`),
          el("span", "result-meta-text", formatTime(message && message.timestamp)),
        );

        item.append(
          meta,
          el("h4", "result-title", title ? String(title) : "未命名会话"),
          el("p", "result-excerpt", summarize(content)),
        );
        fragment.append(item);
      });
      ui.results.replaceChildren(fragment);
    }

    const elapsed = Number(elapsedMs);
    const timing = Number.isFinite(elapsed) ? ` · ${formatCount(Math.round(elapsed))} ms` : "";
    ui.searchSummary.textContent = `${formatCount(list.length)} 条命中${timing}`;
  }

  function renderMemories(memories) {
    const list = Array.isArray(memories) ? memories : [];
    ui.memoriesCount.textContent = `${formatCount(list.length)} 条`;
    if (!list.length) {
      ui.memories.replaceChildren(el("p", "empty empty--small", "无匹配记忆"));
      return;
    }

    const fragment = document.createDocumentFragment();
    list.forEach((memory) => {
      const item = el("article", "sub-item");
      const meta = el("div", "sub-meta");
      meta.append(
        el("span", null, memory && memory.layer ? String(memory.layer) : "未分层"),
        el("span", null, `importance ${formatScore(memory && memory.importance)}`),
        el("span", null, `score ${formatScore(memory && memory.score)}`),
      );
      item.append(
        meta,
        el("p", "sub-content", memory && memory.content ? String(memory.content) : "（空记忆）"),
      );
      fragment.append(item);
    });
    ui.memories.replaceChildren(fragment);
  }

  function renderFacts(facts) {
    const list = Array.isArray(facts) ? facts : [];
    ui.factsCount.textContent = `${formatCount(list.length)} 条`;
    if (!list.length) {
      ui.facts.replaceChildren(el("p", "empty empty--small", "无匹配事实"));
      return;
    }

    const fragment = document.createDocumentFragment();
    list.forEach((fact) => {
      const entity = fact && fact.entity ? String(fact.entity) : "未知实体";
      const entityType = fact && fact.entityType ? String(fact.entityType) : "未知类型";
      const item = el("article", "sub-item");
      const entityLine = el("p", "fact-entity", entity);
      entityLine.append(el("span", null, entityType));
      const meta = el("div", "sub-meta");
      meta.append(el("span", null, `confidence ${formatScore(fact && fact.confidence)}`));

      item.append(
        entityLine,
        meta,
        el("p", "sub-content", fact && fact.content ? String(fact.content) : "（空事实）"),
      );
      fragment.append(item);
    });
    ui.facts.replaceChildren(fragment);
  }

  function resetSearchOutputs(loadingText) {
    ui.results.replaceChildren(el("p", "empty", loadingText));
    ui.memories.replaceChildren(el("p", "empty empty--small", loadingText));
    ui.facts.replaceChildren(el("p", "empty empty--small", loadingText));
    ui.searchSummary.textContent = "—";
    ui.memoriesCount.textContent = "—";
    ui.factsCount.textContent = "—";
  }

  function renderSearchError() {
    ui.results.replaceChildren(el("p", "empty empty--error", "检索失败"));
    ui.memories.replaceChildren(el("p", "empty empty--small", "—"));
    ui.facts.replaceChildren(el("p", "empty empty--small", "—"));
    ui.searchSummary.textContent = "检索失败";
    ui.memoriesCount.textContent = "—";
    ui.factsCount.textContent = "—";
  }

  async function runSearch() {
    if (app.busy.search) return;

    const query = ui.queryInput.value.trim();
    if (!query) {
      ui.searchLog.textContent = "请输入查询关键词";
      ui.queryInput.focus();
      return;
    }

    app.busy.search = true;
    setButtonBusy(ui.btnSearch, true, "检索中…");
    ui.searchLog.textContent = "";
    resetSearchOutputs("检索中…");

    try {
      const data = await requestJson("/api/search", {
        method: "POST",
        body: {
          query,
          limit: 20,
          includeMemory: true,
          weights: readSearchWeights(),
        },
      });
      const result = data && typeof data === "object" ? data : {};
      renderResults(result.messages, result.elapsedMs);
      renderMemories(result.memories);
      renderFacts(result.facts);
    } catch (error) {
      console.error("检索失败", error);
      ui.searchLog.textContent = `检索失败：${getErrorMessage(error)}`;
      renderSearchError();
    } finally {
      app.busy.search = false;
      setButtonBusy(ui.btnSearch, false);
    }
  }

  // ---------- 02 导入与索引 ----------

  function setImportStats(result) {
    const data = result && typeof result === "object" ? result : {};
    ui.importFiles.textContent = formatCount(data.files);
    ui.importConversations.textContent = formatCount(data.conversations);
    ui.importNewMessages.textContent = formatCount(data.newMessages);
  }

  function readImportPaths() {
    return ui.importPaths.value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  async function runImport() {
    if (app.busy.import || app.busy.index) return;

    const paths = readImportPaths();
    if (!paths.length) {
      writeErrorLog(ui.importLog, "请输入至少一个文件或目录路径。");
      ui.importPaths.focus();
      return;
    }

    app.busy.import = true;
    setButtonBusy(ui.btnImport, true, "导入中…");
    ui.btnIndex.disabled = true;
    ui.importStatus.textContent = "导入中…";
    writeLog(ui.importLog, "正在导入，请稍候…");

    try {
      const result = await requestJson("/api/import", {
        method: "POST",
        body: { paths },
      });
      setImportStats(result);
      ui.importStatus.textContent = "导入完成";
      writeLog(ui.importLog, `导入完成：已提交 ${formatCount(paths.length)} 个路径。`);
    } catch (error) {
      console.error("导入失败", error);
      ui.importStatus.textContent = "导入失败";
      writeErrorLog(ui.importLog, `导入失败：${getErrorMessage(error)}`);
    } finally {
      app.busy.import = false;
      setButtonBusy(ui.btnImport, false);
      ui.btnIndex.disabled = false;
    }
  }

  async function runIndex() {
    if (app.busy.import || app.busy.index) return;

    app.busy.index = true;
    setButtonBusy(ui.btnIndex, true, "补齐中…");
    ui.btnImport.disabled = true;
    writeLog(ui.importLog, "正在补齐向量…");

    try {
      const result = await requestJson("/api/index", {
        method: "POST",
        body: {},
      });
      const embedded = result && typeof result === "object" ? result.embedded : null;
      writeLog(ui.importLog, `补齐向量完成：已嵌入 ${formatCount(embedded)} 条消息。`);
    } catch (error) {
      console.error("补齐向量失败", error);
      writeErrorLog(ui.importLog, `补齐向量失败：${getErrorMessage(error)}`);
    } finally {
      app.busy.index = false;
      setButtonBusy(ui.btnIndex, false);
      ui.btnImport.disabled = false;
    }
  }

  // ---------- 03 蒸馏 ----------

  function syncDistillMode() {
    const provider = ui.distillProvider.value === "cloud" ? "cloud" : "ollama";
    for (const field of ui.cloudOnlyFields) {
      field.hidden = provider !== "cloud";
    }
    ui.distillModelLabel.textContent = provider === "cloud" ? "模型 / MODEL" : "本地模型 / OLLAMA MODEL";
    ui.distillMode.textContent = providerLabel(provider);
    ui.distillModel.placeholder = provider === "cloud" ? "例如 qwen-plus" : "qwen2.5:3b";
  }

  function buildDistillPayload() {
    const provider = ui.distillProvider.value === "cloud" ? "cloud" : "ollama";
    const payload = { provider };

    const model = ui.distillModel.value.trim();
    if (model) payload.model = model;

    const limit = readOptionalPositiveInt(ui.distillLimit, "Limit");
    if (limit !== null) payload.limit = limit;

    const maxChars = readOptionalPositiveInt(ui.distillMaxChars, "Max chars");
    if (maxChars !== null) payload.maxChars = maxChars;

    if (provider === "cloud") {
      const baseUrl = ui.distillBaseUrl.value.trim();
      if (baseUrl) payload.baseUrl = baseUrl;

      const apiKey = ui.distillApiKey.value.trim();
      if (apiKey) payload.apiKey = apiKey;
    }

    return payload;
  }

  function renderDistillResult(result) {
    const data = result && typeof result === "object" ? result : {};
    const errors = Array.isArray(data.errors) ? data.errors : [];
    const lines = [
      "蒸馏完成",
      "",
      `会话          ${formatCount(data.conversations)}`,
      `实体          ${formatCount(data.entities)}`,
      `事实          ${formatCount(data.facts)}`,
      `记忆          ${formatCount(data.memories)}`,
      `嵌入消息      ${formatCount(data.embeddedMessages)}`,
    ];

    if (errors.length) {
      lines.push("", `错误 / ERRORS（${formatCount(errors.length)}）`);
      errors.forEach((message) => lines.push(`- ${String(message)}`));
    }
    writeLog(ui.distillLog, lines.join("\n"));
  }

  async function runDistill() {
    if (app.busy.distill) return;

    let payload;
    try {
      payload = buildDistillPayload();
    } catch (error) {
      writeErrorLog(ui.distillLog, `参数错误：${getErrorMessage(error)}`);
      return;
    }

    app.busy.distill = true;
    setButtonBusy(ui.btnDistill, true, "蒸馏中…");
    writeLog(
      ui.distillLog,
      `${providerLabel(payload.provider)}${payload.model ? ` · ${payload.model}` : ""}\n\n运行中…`,
    );

    try {
      const result = await requestJson("/api/distill", {
        method: "POST",
        body: payload,
      });
      renderDistillResult(result);
    } catch (error) {
      console.error("蒸馏失败", error);
      writeErrorLog(ui.distillLog, `蒸馏失败\n\n${getErrorMessage(error)}`);
    } finally {
      app.busy.distill = false;
      setButtonBusy(ui.btnDistill, false);
    }
  }

  // ---------- 04 模型 ----------

  async function readNdjson(response, onLine) {
    if (!response.body || typeof response.body.getReader !== "function") {
      const text = await response.text();
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) onLine(line);
      }
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);
        if (line.trim()) onLine(line);
        newlineIndex = buffer.indexOf("\n");
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) onLine(buffer);
  }

  async function refreshModels() {
    const data = await requestJson("/api/models");
    const result = data && typeof data === "object" ? data : {};
    const installed = Array.isArray(result.installed) ? result.installed : [];
    const available = Boolean(result.available);

    renderModels(installed, available);
    setOllamaStatus(available, installed);
    if (app.data && typeof app.data === "object") {
      app.data.ollama = { ...(app.data.ollama || {}), available, models: installed };
    }
    return { installed, available };
  }

  function setModelControlsDisabled(disabled) {
    ui.modelInput.disabled = disabled;
    for (const button of ui.presetButtons) {
      button.disabled = disabled;
    }
  }

  async function runPull(modelFromPreset) {
    if (app.pulling) return;

    const model = String(modelFromPreset || ui.modelInput.value || "").trim();
    if (!model) {
      writeErrorLog(ui.modelLog, "请输入要安装的模型名称。");
      ui.modelInput.focus();
      return;
    }

    ui.modelInput.value = model;
    app.pulling = true;
    setButtonBusy(ui.btnPullModel, true, "安装中…");
    setModelControlsDisabled(true);
    writeLog(ui.modelLog, `> ollama pull ${model}\n\n`);

    let sawDone = false;
    let sawError = false;

    try {
      const response = await fetch("/api/models/pull", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/x-ndjson",
        },
        body: JSON.stringify({ model }),
      });

      if (!response.ok) throw new Error(await extractResponseError(response));

      await readNdjson(response, (rawLine) => {
        const line = rawLine.trim();
        if (!line) return;

        let event;
        try {
          event = JSON.parse(line);
        } catch (error) {
          appendLog(ui.modelLog, `${line}\n`);
          return;
        }

        if (!event || typeof event !== "object") return;

        if (event.status === "line") {
          appendLog(ui.modelLog, `${event.line ?? ""}\n`);
        } else if (event.status === "done") {
          sawDone = true;
          appendLog(ui.modelLog, "完成\n");
        } else if (event.status === "error") {
          sawError = true;
          ui.modelLog.classList.add("is-error");
          appendLog(ui.modelLog, `\n错误：${event.error ? String(event.error) : "未知错误"}\n`);
        } else {
          appendLog(ui.modelLog, `${line}\n`);
        }
      });

      if (sawDone && !sawError) {
        appendLog(ui.modelLog, "\n安装完成，正在刷新模型列表…\n");
        try {
          const refreshed = await refreshModels();
          appendLog(ui.modelLog, `已安装 ${formatCount(refreshed.installed.length)} 个模型。\n`);
        } catch (error) {
          console.error("刷新模型列表失败", error);
          appendLog(ui.modelLog, `模型列表刷新失败：${getErrorMessage(error)}\n`);
        }
      } else if (sawError) {
        appendLog(ui.modelLog, "\n安装失败。\n");
      } else {
        appendLog(ui.modelLog, "\n流已结束，未收到完成事件。\n");
      }
    } catch (error) {
      console.error("安装模型失败", error);
      ui.modelLog.classList.add("is-error");
      appendLog(ui.modelLog, `\n错误：${getErrorMessage(error)}\n`);
    } finally {
      app.pulling = false;
      setButtonBusy(ui.btnPullModel, false);
      setModelControlsDisabled(false);
    }
  }

  // ---------- 05 设置 ----------

  function readConfigWeights() {
    const weights = {};
    for (const key of WEIGHT_KEYS) {
      const input = configWeightInputs[key];
      const raw = input ? input.value.trim() : "";
      const number = Number(raw);
      if (!raw || !Number.isFinite(number) || number < 0 || number > 2) {
        throw new Error(`检索权重 ${key.toUpperCase()} 必须是 0–2 之间的数字`);
      }
      weights[key] = number;
    }
    return weights;
  }

  function buildLlmConfig() {
    const llm = {};
    const baseUrl = ui.configBaseUrl.value.trim();
    const model = ui.configModel.value.trim();
    const apiKey = ui.configApiKey.value.trim();

    if (baseUrl) llm.baseUrl = baseUrl;
    if (model) llm.model = model;
    if (apiKey) llm.apiKey = apiKey;
    return llm;
  }

  async function saveConfig() {
    if (app.busy.save) return;

    let weights;
    let llm;
    try {
      weights = readConfigWeights();
      llm = buildLlmConfig();
    } catch (error) {
      writeErrorLog(ui.configLog, `保存失败：${getErrorMessage(error)}`);
      return;
    }

    app.busy.save = true;
    setButtonBusy(ui.btnSaveConfig, true, "保存中…");
    writeLog(ui.configLog, "正在保存…");

    try {
      await requestJson("/api/config", {
        method: "PUT",
        body: { weights, llm },
      });

      applyWeights(weights);

      if (llm.apiKey) {
        app.llmHasKey = true;
        ui.configApiKey.value = "";
        if (ui.distillApiKey) ui.distillApiKey.value = "";
      }
      syncKeyHints();

      if (app.data && typeof app.data === "object") {
        app.data.weights = weights;
        const providers = app.data.providers && typeof app.data.providers === "object"
          ? app.data.providers
          : {};
        const currentLlm = providers.llm && typeof providers.llm === "object" ? providers.llm : {};
        providers.llm = {
          baseUrl: llm.baseUrl !== undefined ? llm.baseUrl : currentLlm.baseUrl || "",
          model: llm.model !== undefined ? llm.model : currentLlm.model || "",
          hasKey: Boolean(llm.apiKey) || Boolean(currentLlm.hasKey),
        };
        app.data.providers = providers;
      }

      if (llm.baseUrl) ui.distillBaseUrl.value = llm.baseUrl;
      if (llm.model) ui.distillModel.value = llm.model;

      writeLog(
        ui.configLog,
        `已保存。权重 FTS ${weights.fts.toFixed(1)} / PINYIN ${weights.pinyin.toFixed(1)} / VEC ${weights.vec.toFixed(1)}`,
      );
    } catch (error) {
      console.error("保存设置失败", error);
      writeErrorLog(ui.configLog, `保存失败：${getErrorMessage(error)}`);
    } finally {
      app.busy.save = false;
      setButtonBusy(ui.btnSaveConfig, false);
    }
  }

  // ---------- 事件绑定 ----------

  function bindEvents() {
    ui.btnSearch.addEventListener("click", () => {
      void runSearch();
    });

    ui.queryInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      void runSearch();
    });

    for (const key of WEIGHT_KEYS) {
      const input = ui.weightInputs[key];
      if (input) input.addEventListener("input", scheduleWeightPaint);
    }

    ui.btnImport.addEventListener("click", () => {
      void runImport();
    });

    ui.btnIndex.addEventListener("click", () => {
      void runIndex();
    });

    ui.importPaths.addEventListener("keydown", (event) => {
      if (!(event.metaKey || event.ctrlKey) || event.key !== "Enter") return;
      event.preventDefault();
      void runImport();
    });

    ui.distillProvider.addEventListener("change", syncDistillMode);

    ui.btnDistill.addEventListener("click", () => {
      void runDistill();
    });

    ui.btnPullModel.addEventListener("click", () => {
      void runPull();
    });

    ui.modelInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      void runPull();
    });

    for (const button of ui.presetButtons) {
      button.addEventListener("click", () => {
        const model = button.dataset.model;
        if (!model) return;
        ui.modelInput.value = model;
        void runPull(model);
      });
    }

    ui.btnSaveConfig.addEventListener("click", () => {
      void saveConfig();
    });
  }

  function init() {
    bindEvents();
    paintWeightValues();
    syncDistillMode();
    syncKeyHints();
    void loadState();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
