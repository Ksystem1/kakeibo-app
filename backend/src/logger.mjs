function serializeError(err) {
  if (!err || typeof err !== "object") return undefined;
  return {
    name: err.name,
    message: err.message,
    code: err.code,
    errno: err.errno,
    syscall: err.syscall,
    stack: err.stack,
  };
}

export function logJson(level, event, payload = {}) {
  const rec = {
    ts: new Date().toISOString(),
    level,
    event,
    ...payload,
  };
  const line = JSON.stringify(rec);
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export function createLogger(scope = "app") {
  return {
    info(event, payload = {}) {
      logJson("info", `${scope}.${event}`, payload);
    },
    warn(event, payload = {}) {
      logJson("warn", `${scope}.${event}`, payload);
    },
    error(event, err, payload = {}) {
      logJson("error", `${scope}.${event}`, {
        ...payload,
        error: serializeError(err),
      });
    },
  };
}
