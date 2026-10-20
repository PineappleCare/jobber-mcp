import { WebError } from "./contracts.js";
const paths = new Set([
  "/v1/status",
  "/v1/preview-payment",
  "/v1/preview-pin",
  "/v1/execute",
  "/v1/operation",
  "/v1/verify",
]);
export async function webCall<T = any>(
  path: string,
  body: unknown,
): Promise<T> {
  if (!paths.has(path)) throw new WebError("unsupported_operation");
  const url = new URL(process.env.JOBBER_WEB_URL!);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/"
  )
    throw new WebError("invalid_browser_service_config");
  try {
    const res = await fetch(new URL(path, url), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.JOBBER_WEB_SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(90000),
    });
    const text = await res.text();
    if (text.length > 1024 * 1024)
      throw new WebError("browser_response_too_large");
    const data = JSON.parse(text);
    if (!res.ok)
      throw new WebError(
        /^[a-z_]+$/.test(data.error)
          ? data.error
          : "browser_service_unavailable",
      );
    return data;
  } catch (e) {
    if (e instanceof WebError) throw e;
    throw new WebError(
      path === "/v1/execute"
        ? "submission_uncertain_query_operation"
        : "browser_service_unavailable",
    );
  }
}
