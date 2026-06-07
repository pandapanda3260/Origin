export function describeVideoModelStatusFailure(error) {
  var payload = error && error.payload && typeof error.payload === "object" ? error.payload : null;
  if (payload && payload.ok === false) {
    return {
      label: "视频模型未配置",
      meta: payload.hint || payload.error || "当前后端没有可用视频模型",
      status: "missing",
      cache: true,
      reason: "config_missing"
    };
  }

  var status = Number(error && error.status ? error.status : 0);
  var name = error && error.name ? String(error.name) : "";
  var message = error && error.message ? String(error.message) : "";
  var lower = (name + " " + message).toLowerCase();

  if (status === 401 || status === 403) {
    return {
      label: "登录状态失效",
      meta: "请刷新页面或重新登录后再试",
      status: "missing",
      cache: false,
      reason: "auth"
    };
  }

  if (name === "TimeoutError" || name === "AbortError" || lower.indexOf("timeout") >= 0 || message.indexOf("超时") >= 0) {
    return {
      label: "读取超时",
      meta: "后端响应较慢，请稍后重试",
      status: "missing",
      cache: true,
      reason: "timeout"
    };
  }

  if (status >= 500) {
    return {
      label: "后端暂时不可用",
      meta: "服务正在重启或繁忙，请稍后重试",
      status: "missing",
      cache: true,
      reason: "server"
    };
  }

  if (!status && (name === "TypeError" || lower.indexOf("failed to fetch") >= 0 || lower.indexOf("network") >= 0)) {
    return {
      label: "后端连接异常",
      meta: "无法连接本地后端，请确认服务仍在运行",
      status: "missing",
      cache: true,
      reason: "network"
    };
  }

  return {
    label: "当前视频模型",
    meta: "读取模型配置失败，请稍后重试",
    status: "missing",
    cache: true,
    reason: "unknown"
  };
}
