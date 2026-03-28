/**
 * API Gateway (HTTP API) + Lambda エントリ。
 */
import { handleApiRequest } from "./app-core.mjs";

export async function handler(event) {
  if (event.requestContext?.http?.method === "OPTIONS") {
    return handleApiRequest({ method: "OPTIONS", path: "/", headers: event.headers });
  }

  const method = event.requestContext?.http?.method ?? event.httpMethod;
  const path = event.rawPath ?? event.path ?? "/";
  const queryStringParameters = event.queryStringParameters;
  const body = event.body ?? null;
  const headers = event.headers;

  return handleApiRequest({
    method,
    path,
    queryStringParameters: queryStringParameters || undefined,
    body,
    headers,
  });
}
