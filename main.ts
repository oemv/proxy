// --- Configuration ---

const PROXY_URL_PARAM = "url";

const REQUEST_HEADERS_TO_STRIP = new Set([
  "host", "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor",
]);

const RESPONSE_HEADERS_TO_STRIP = new Set([
  "connection", "content-encoding", "content-length", "transfer-encoding",
  "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers",
  "upgrade", "content-security-policy", "content-security-policy-report-only",
  "strict-transport-security", "x-frame-options",
]);

const RESTRICTED_HOSTNAMES = new Set([
  "localhost", "127.0.0.1", "[::1]",
]);

const RESTRICTED_IP_PREFIXES = [
  "10.", "192.168.", "172.16.", "172.17.", "172.18.", "172.19.", "172.20.",
  "172.21.", "172.22.", "172.23.", "172.24.", "172.25.", "172.26.", "172.27.",
  "172.28.", "172.29.", "172.30.", "172.31.", "169.254.", "fc00::", "fe80::",
];

// --- Rewrite Logic (from rewrite.ts) ---

import { HTMLRewriter } from "https://deno.land/x/lol_html@0.1.0/mod.ts";

function getProxyUrl(requestUrl: URL, target: string): string {
  const newUrl = new URL(requestUrl.href);
  newUrl.searchParams.set(PROXY_URL_PARAM, target);
  return newUrl.href;
}

function rewriteUrl(url: string, base: URL, requestUrl: URL): string {
  try {
    return getProxyUrl(requestUrl, new URL(url, base).href);
  } catch {
    return getProxyUrl(requestUrl, base.href); // Fallback to base if URL construction fails
  }
}

const JS_SANDBOX_SCRIPT = `
  const originalFetch = window.fetch;
  const originalXHR = window.XMLHttpRequest;
  const originalWebSocket = window.WebSocket;
  const originalLocation = window.location;
  const PROXY_PARAM = "${PROXY_URL_PARAM}";

  function getProxiedUrl(url) {
    const absoluteUrl = new URL(url, document.baseURI).href;
    const proxyUrl = new URL(window.location.href);
    proxyUrl.searchParams.set(PROXY_PARAM, absoluteUrl);
    return proxyUrl.href;
  }

  // Intercept fetch requests
  window.fetch = (resource, options) => {
    const proxiedResource = resource instanceof Request ? resource.url : resource;
    return originalFetch(getProxiedUrl(proxiedResource), options);
  };

  // Intercept XMLHttpRequest
  window.XMLHttpRequest.prototype.open = function(method, url, async, user, password) {
    return originalXHR.prototype.open.call(this, method, getProxiedUrl(url), async, user, password);
  };
  
  // Intercept WebSocket connections
  window.WebSocket = function(url, protocols) {
    try {
      const wsUrl = new URL(url, document.baseURI);
      const isSecure = wsUrl.protocol === 'https:' || wsUrl.protocol === 'wss:'; // Corrected protocol check
      const proxyWsUrl = new URL(window.location.href);
      proxyWsUrl.protocol = isSecure ? 'wss:' : 'ws:';
      proxyWsUrl.searchParams.set(PROXY_PARAM, wsUrl.href);
      return new originalWebSocket(proxyWsUrl.href, protocols); // Pass proxy URL to WebSocket constructor
    } catch (e) {
      console.error("WebSocket proxying failed:", e);
      throw e;
    }
  };

  // Intercept location object properties
  Object.defineProperty(window, 'location', {
    get: () => ({
      ...originalLocation,
      assign: (url) => originalLocation.assign(getProxiedUrl(url)),
      replace: (url) => originalLocation.replace(getProxiedUrl(url)),
      reload: () => originalLocation.reload(), // Reloads the current proxied page
      toString: () => originalLocation.toString(), // Returns the proxied URL
      href: originalLocation.href, // Returns the proxied URL
      // Add other properties you want to intercept if needed
    }),
    set: (url) => originalLocation.assign(getProxiedUrl(url))
  });

  // Intercept form submissions
  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (form && form.tagName === 'FORM' && form.action) {
      form.action = getProxiedUrl(form.action);
    }
  });

  // Intercept anchor clicks to rewrite them on the fly if not already rewritten
  document.addEventListener('click', (event) => {
    let target = event.target;
    while (target && target.tagName !== 'A' && target.tagName !== 'AREA') {
      target = target.parentNode;
    }
    if (target && target.href && !target.href.includes('?' + PROXY_PARAM + '=')) {
      try {
        const absoluteHref = new URL(target.href, document.baseURI).href;
        target.href = getProxiedUrl(absoluteHref);
      } catch (e) {
        console.warn("Failed to rewrite clicked link:", target.href, e);
      }
    }
  });

  // Prevent popups from escaping
  const originalWindowOpen = window.open;
  window.open = function(url, name, features) {
    if (url) {
      return originalWindowOpen(getProxiedUrl(url), name, features);
    }
    return originalWindowOpen(url, name, features);
  };
`;

class AttributeRewriter {
  constructor(private attribute: string, private base: URL, private reqUrl: URL) {}
  element(element: Element) {
    const value = element.getAttribute(this.attribute);
    if (value) {
      element.setAttribute(this.attribute, rewriteUrl(value, this.base, this.reqUrl));
      if (this.attribute.toLowerCase() === 'integrity') element.removeAttribute('integrity');
    }
  }
}

class SrcsetRewriter {
  constructor(private base: URL, private reqUrl: URL) {}
  element(element: Element) {
    const value = element.getAttribute("srcset");
    if (value) {
      const rewritten = value
        .split(",")
        .map(part => {
          const [url, ...rest] = part.trim().split(/\s+/);
          return [rewriteUrl(url, this.base, this.reqUrl), ...rest].join(" ");
        })
        .join(", ");
      element.setAttribute("srcset", rewritten);
    }
  }
}

function rewriteHtmlStream(body: ReadableStream<Uint8Array>, targetUrl: URL, requestUrl: URL): ReadableStream<Uint8Array> {
  const rewriter = new HTMLRewriter()
    .on("head", { element: el => el.prepend(`<base href="${targetUrl.href}">`, { html: true }) })
    .on("head", { element: el => el.prepend(`<script>${JS_SANDBOX_SCRIPT}</script>`, { html: true }) })
    .on("[href]", new AttributeRewriter("href", targetUrl, requestUrl))
    .on("[src]", new AttributeRewriter("src", targetUrl, requestUrl))
    .on("[action]", new AttributeRewriter("action", targetUrl, requestUrl))
    .on("[poster]", new AttributeRewriter("poster", targetUrl, requestUrl))
    .on("script", new AttributeRewriter("integrity", targetUrl, requestUrl))
    .on("link", new AttributeRewriter("integrity", targetUrl, requestUrl))
    .on("form", { element: el => el.removeAttribute('target') }) // Prevent _blank forms from escaping
    .on("[srcset]", new SrcsetRewriter(targetUrl, requestUrl));
  return rewriter.transform(body);
}

function rewriteCssStream(body: ReadableStream<Uint8Array>, targetUrl: URL, requestUrl: URL): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const urlRegex = /url\((['"]?)(.*?)(['"]?)\)/gi;

  let buffer = '';
  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const rewritten = buffer.replaceAll(urlRegex, (_match, p1, p2, p3) => {
        if (p2.startsWith("data:")) return `url(${p1}${p2}${p3})`;
        return `url(${p1}${rewriteUrl(p2, targetUrl, requestUrl)}${p3})`;
      });
      // Simple buffering: flush rewritten content, keep unparsed tail
      // For more robust CSS parsing, a full CSS parser would be needed,
      // but this regex is often sufficient for basic URL rewrites.
      controller.enqueue(encoder.encode(rewritten));
      buffer = ''; // Clear buffer assuming everything was processed
    },
    flush(controller) {
      if (buffer.length > 0) {
        const rewritten = buffer.replaceAll(urlRegex, (_match, p1, p2, p3) => {
          if (p2.startsWith("data:")) return `url(${p1}${p2}${p3})`;
          return `url(${p1}${rewriteUrl(p2, targetUrl, requestUrl)}${p3})`;
        });
        controller.enqueue(encoder.encode(rewritten));
      }
    }
  });
}

// --- Proxy Logic (from proxy.ts) ---

async function proxyRequest(req: Request, targetUrl: URL): Promise<Response> {
  const outgoingHeaders = new Headers(req.headers);
  REQUEST_HEADERS_TO_STRIP.forEach(h => outgoingHeaders.delete(h));
  outgoingHeaders.set("Host", targetUrl.host);
  outgoingHeaders.set("Origin", targetUrl.origin);
  outgoingHeaders.set("Referer", targetUrl.href); // Send original referer

  const upstreamResponse = await fetch(targetUrl, {
    method: req.method,
    headers: outgoingHeaders,
    body: (req.method !== "GET" && req.method !== "HEAD") ? req.body : null,
    redirect: "manual", // Crucial: We handle redirects
  });

  const responseHeaders = new Headers(upstreamResponse.headers);
  RESPONSE_HEADERS_TO_STRIP.forEach(h => responseHeaders.delete(h));
  responseHeaders.set("Access-Control-Allow-Origin", "*");
  responseHeaders.set("Access-Control-Expose-Headers", "*");
  
  // Rewrite Set-Cookie to remove domain and path if necessary
  const setCookieHeader = responseHeaders.get("set-cookie");
  if (setCookieHeader) {
    const newCookie = setCookieHeader
      .split(/, (?=[^;]+=[^;]+;)/) // Split by comma not in parentheses, respecting complex cookies
      .map(c => c.replace(/domain=.*?;/i, "").replace(/; path=\/.*?;/i, "; path=/")) // Remove domain, standardize path
      .join(", ");
    responseHeaders.set("set-cookie", newCookie);
  }

  const status = upstreamResponse.status;
  if (status >= 301 && status <= 308) { // Handle all redirect statuses
    const location = responseHeaders.get("location");
    if (location) {
      // Rewrite the Location header to point back to our proxy
      const redirectedUrl = rewriteUrl(location, targetUrl, new URL(req.url));
      responseHeaders.set("location", redirectedUrl);
    }
  }

  const contentType = responseHeaders.get("content-type") || "";
  let body = upstreamResponse.body;
  if (body) {
    if (contentType.includes("text/html")) {
      body = rewriteHtmlStream(body, targetUrl, new URL(req.url));
    } else if (contentType.includes("text/css")) {
      body = rewriteCssStream(body, targetUrl, new URL(req.url));
    }
    // No rewriting needed for other content types (images, js, fonts, etc.)
    // as their URLs are already rewritten in HTML/CSS or handled by JS sandbox.
  }
  
  return new Response(body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}

// --- Main Server Handler (from main.ts) ---

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "*",
        "Access-Control-Allow-Headers": "*",
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
    RESTRICTED_IP_PREFIXES.some(p => hostname.startsWith(p))
  ) {
    return new Response("ERROR: Access to this address is forbidden.", { status: 403 });
  }

  try {
    return await proxyRequest(req, targetUrl);
  } catch (e) {
    console.error(`Proxy error for ${targetUrlString}:`, e);
    return new Response("ERROR: Upstream fetch failed.", { status: 502 });
  }
});
