const HOP_BY_HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate",
  "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade",
  "content-encoding", "content-length",
]);

const RESTRICTED_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
]);

const RESTRICTED_IP_PREFIXES = [
  "10.", "192.168.", "172.16.", "172.17.", "172.18.", "172.19.",
  "172.20.", "172.21.", "172.22.", "172.23.", "172.24.", "172.25.",
  "172.26.", "172.27.", "172.28.", "172.29.", "172.30.", "172.31.",
  "169.254.", "fc00::", "fe80::",
];

const PROXY_URL_PARAM = "url";

function createHtmlRewriter(targetUrl: URL): TransformStream<Uint8Array, Uint8Array> {
  const baseTag = `<base href="${targetUrl.href}">`;
  const headTag = '</head>';
  let processed = false;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';

  return new TransformStream({
    transform(chunk, controller) {
      if (processed) {
        controller.enqueue(chunk);
        return;
      }

      buffer += decoder.decode(chunk, { stream: true });
      const headIndex = buffer.toLowerCase().indexOf(headTag);

      if (headIndex !== -1) {
        const modified = buffer.slice(0, headIndex) + baseTag + buffer.slice(headIndex);
        controller.enqueue(encoder.encode(modified));
        processed = true;
        buffer = '';
      } else {
        const potentialSplitPoint = buffer.length - (headTag.length - 1);
        if (potentialSplitPoint > 0) {
          controller.enqueue(encoder.encode(buffer.slice(0, potentialSplitPoint)));
          buffer = buffer.slice(potentialSplitPoint);
        }
      }
    },
    flush(controller) {
      if (buffer.length > 0) {
        controller.enqueue(encoder.encode(buffer));
      }
    },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, HEAD, PATCH",
        "Access-Control-Allow-Headers": req.headers.get("Access-Control-Request-Headers") || "*",
        "Access-Control-Expose-Headers": "*",
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
  if (protocol !== "http:" && protocol !== "https:") {
    return new Response("ERROR: Only http and https schemes are supported.", { status: 400 });
  }

  if (
    RESTRICTED_HOSTNAMES.has(hostname) ||
    RESTRICTED_IP_PREFIXES.some(prefix => hostname.startsWith(prefix))
  ) {
    return new Response("ERROR: Access to this address is forbidden.", { status: 403 });
  }

  const outgoingHeaders = new Headers(req.headers);
  outgoingHeaders.delete("host");
  outgoingHeaders.delete("referer");

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(targetUrl.toString(), {
      method: req.method,
      headers: outgoingHeaders,
      body: (req.method !== "GET" && req.method !== "HEAD") ? req.body : null,
      redirect: "manual",
    });
  } catch (e) {
    console.error(`Upstream fetch error for ${targetUrlString}:`, e.message);
    return new Response("ERROR: Failed to connect to the target server.", { status: 502 });
  }

  const responseHeaders = new Headers(upstreamResponse.headers);
  HOP_BY_HOP_HEADERS.forEach(h => responseHeaders.delete(h));
  responseHeaders.set("Access-Control-Allow-Origin", "*");
  responseHeaders.set("Access-Control-Expose-Headers", "*");
  
  const status = upstreamResponse.status;
  if (status >= 301 && status <= 308) {
    const location = responseHeaders.get("location");
    if (location) {
      const absoluteRedirectUrl = new URL(location, targetUrl.href).href;
      requestUrl.searchParams.set(PROXY_URL_PARAM, absoluteRedirectUrl);
      responseHeaders.set("location", requestUrl.href);
    }
  }

  const contentType = responseHeaders.get("content-type") || "";
  let body = upstreamResponse.body;
  
  if (contentType.includes("text/html") && body) {
    body = body.pipeThrough(createHtmlRewriter(targetUrl));
  }
  
  return new Response(body, {
    status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
});
