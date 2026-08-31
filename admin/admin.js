const $ = (selector) => document.querySelector(selector);
const output = (selector, value) => { $(selector).textContent = JSON.stringify(value, null, 2); };
const toast = (message) => {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("visible");
  window.setTimeout(() => node.classList.remove("visible"), 2600);
};

const api = async (path, options = {}) => {
  const response = await fetch(path, {
    credentials: "include",
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message ?? `请求失败 (${response.status})`);
  return body;
};

const requestId = () => `admin-${crypto.randomUUID()}`;
const confirmPhrase = (phrase) => {
  const entered = window.prompt(`二次确认：请输入 ${phrase}`);
  if (entered !== phrase) throw new Error("确认短语不匹配，操作已取消");
  return { confirmed: true, confirmationText: entered };
};

const run = async (operation) => {
  try { await operation(); } catch (error) { toast(error instanceof Error ? error.message : "未知错误"); }
};

$("#refresh-config").addEventListener("click", () => run(async () => {
  output("#config-output", await api("/v1/admin/config-version"));
}));

$("#player-search").addEventListener("submit", (event) => run(async () => {
  event.preventDefault();
  const query = $("#player-query").value.trim();
  output("#player-output", await api(`/v1/admin/players?query=${encodeURIComponent(query)}`));
}));

$("#migration-preview").addEventListener("submit", (event) => run(async () => {
  event.preventDefault();
  const migrationId = $("#migration-id").value.trim();
  const body = {
    migrationId,
    playerId: $("#migration-player-id").value.trim(),
    save: JSON.parse($("#migration-json").value),
    requestId: requestId(),
    confirmation: confirmPhrase(`PREVIEW ${migrationId}`),
  };
  const preview = await api("/v1/admin/migrations/preview", { method: "POST", body: JSON.stringify(body) });
  output("#migration-output", preview);
  $("#apply-migration").disabled = !preview.valid;
  $("#rollback-migration").disabled = true;
}));

$("#apply-migration").addEventListener("click", () => run(async () => {
  const migrationId = $("#migration-id").value.trim();
  const player = await api("/v1/admin/migrations/apply", {
    method: "POST",
    body: JSON.stringify({ migrationId, requestId: requestId(), confirmation: confirmPhrase(`APPLY ${migrationId}`) }),
  });
  output("#migration-output", player);
  $("#rollback-migration").disabled = false;
  toast("迁移已应用并写入审计");
}));

$("#rollback-migration").addEventListener("click", () => run(async () => {
  const migrationId = $("#migration-id").value.trim();
  const player = await api("/v1/admin/migrations/rollback", {
    method: "POST",
    body: JSON.stringify({ migrationId, requestId: requestId(), confirmation: confirmPhrase(`ROLLBACK ${migrationId}`) }),
  });
  output("#migration-output", player);
  $("#rollback-migration").disabled = true;
  toast("迁移已安全回滚");
}));

$("#replay-form").addEventListener("submit", (event) => run(async () => {
  event.preventDefault();
  const sessionId = $("#replay-session-id").value.trim();
  output("#replay-output", await api(`/v1/admin/pvp/replay?sessionId=${encodeURIComponent(sessionId)}`));
}));

$("#refresh-audit").addEventListener("click", () => run(async () => {
  output("#audit-output", await api("/v1/admin/audit?limit=100"));
}));
