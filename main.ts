// Filename: main.ts

// --- Configuration ---

// These headers are removed from the client's request before sending to the target server.
const REQUEST_HEADERS_TO_STRIP = new Set([
  "host",
  "referer",
  "origin",
]);

// These headers are removed from the target server's response before sending to the client.
// This is a standard set of "hop-by-hop" headers that should not be proxied.
const RESPONSE_HEADERS_TO_STRIP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailers", "transfer-encoding", "upgrade",
  // Content-Encoding and Content-Length are handled by the runtime, stripping them is safer.
  "content-encoding", "content-length",
  // Security-related headers that we want the browser to re-evaluate for our proxy's context.
  "content-security-policy", "content-security-policy-report-only", "strict-transport-security",
]);

// Security: A set of hostnames that the proxy is forbidden to connect to.
const RESTRICTED_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]", // IPv6 loopback
]);

// Security: A list of IP prefixes that the proxy is forbidden to connect to.
const RESTRICTED_IP_PREFIXES = [
  "10.", "192.168.", "172.16.", "172.17.", "172.18.", "172.19.",
  "172.20.", "172.21.", "172.22.", "172.23.", "172.24.", "172.25.",
  "172.26.", "172.27.", "172.28.", "172.29.", "172.30.", "172.31.",
  "169.254.", // Link-local
  "fc00::",    // IPv6 Unique Local Addresses
  "fe80::",    // IPv6 Link-local
];

const PROXY_URL_PARAM = "url";

// --- Core Logic ---

/**
 * Creates a TransformStream that injects a <base> tag into an HTML document stream.
 * This is the magic that makes relative paths (like /style.css) work correctly.
 * It's highly efficient as it doesn't buffer the whole document.
 * @param targetUrl The destination URL, used to set the base href.
 */
function createHtmlRewriter(targetUrl: URL): TransformStream<Uint8Array, Uint8Array> {
  const baseTag = `<base href="${targetUrl.href}">`;
  const headTagEnd = /<\/head>/i;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let foundHead = false;
  let buffer = '';

  return new TransformStream({
    transform(chunk, controller) {
      if (foundHead) {
        controller.enqueue(chunk);
        return;
      }

      buffer += decoder.decode(chunk, { stream: true });
      const match = buffer.match(headTagEnd);

      if (match && typeof match.index === 'number') {
        const index = match.index;
        const modified = buffer.slice(0, index) + baseTag + buffer.slice(index);
        controller.enqueue(encoder.encode(modified));
        foundHead = true;
        buffer = ''; // Clear buffer
      }
    },
    flush(controller) {
      // If </head> was never found (e.g., malformed HTML), or it was the last thing in the stream.
      // We enqueue whatever is left in the buffer.
      if (buffer.length > 0) {
        controller.enqueue(encoder.encode(buffer));
      }
    },
  });
}


/**
 * The main server handler.
 */
Deno.serve({ port: 8000 }, async (req: Request) => {
  // Handle CORS preflight requests immediately.
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, HEAD, PATCH",
        "Access-Control-Allow-Headers": req.headers.get("Access-Control-Request-Headers") || "*",
        "Access-Control-Expose-Headers": "*", // Expose all headers to the client
      },
    });
  }

  const requestUrl = new URL(req.url);
  const targetUrlString = requestUrl.searchParams.get(PROXY_URL_PARAM);

  if (!targetUrlString) {
    return new Response("ERROR: 'url' query parameter is missing.", { status: 400 });
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(targetUrlString);
  } catch (_) {
    return new Response("ERROR: Invalid 'url' query parameter.", { status: 400 });
  }

  const { protocol, hostname } = targetUrl;

  // Protocol security check
  if (protocol !== "http:" && protocol !== "https:") {
    return new Response("ERROR: Only http and https schemes are supported.", { status: 400 });
  }

  // SSRF/Internal network protection
  if (
    RESTRICTED_HOSTNAMES.has(hostname) ||
    RESTRICTED_IP_PREFIXES.some(prefix => hostname.startsWith(prefix))
  ) {
    return new Response("ERROR: Access to this address is forbidden.", { status: 403 });
  }

  const outgoingHeaders = new Headers(req.headers);
  REQUEST_HEADERS_TO_STRIP.forEach(h => outgoingHeaders.delete(h));

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(targetUrl, {
      method: req.method,
      headers: outgoingHeaders,
      body: (req.method !== "GET" && req.method !== "HEAD") ? req.body : null,
      redirect: "manual", // CRITICAL: We handle redirects ourselves.
    });
  } catch (e) {
    console.error(`Upstream fetch error for ${targetUrlString}:`, e.message);
    return new Response("ERROR: Failed to connect to the target server.", { status: 502 });
  }

  const responseHeaders = new Headers(upstreamResponse.headers);
  RESPONSE_HEADERS_TO_STRIP.forEach(h => responseHeaders.delete(h));
  responseHeaders.set("Access-Control-Allow-Origin", "*");
  responseHeaders.set("Access-Control-Expose-Headers", "*");

  const status = upstreamResponse.status;

  // Handle redirects: rewrite the 'Location' header to point back to our proxy.
  if (status >= 301 && status <= 308) {
    const location = responseHeaders.get("location");
    if (location) {
      // Resolve the new location relative to the original target URL
      const absoluteRedirectUrl = new URL(location, targetUrl.href).href;
      // Construct the new proxy URL
      requestUrl.searchParams.set(PROXY_URL_PARAM, absoluteRedirectUrl);
      responseHeaders.set("location", requestUrl.href);
    }
  }

  const contentType = responseHeaders.get("content-type") || "";
  let body = upstreamResponse.body;

  // If the content is HTML, pipe it through our rewriter to inject the <base> tag.
  if (contentType.includes("text/html") && body) {
    body = body.pipeThrough(createHtmlRewriter(targetUrl));
  }

  return new Response(body, {
    status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
});
