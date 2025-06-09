// --- Configuration ---

const PROXY_URL_PARAM = "url";

// This is the critical addition. We will pretend to be a standard Chrome browser.
const BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const REQUEST_HEADERS_TO_STRIP = new Set([
  "host", "user-agent", "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor",
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

// --- Rewrite Logic ---

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
    return getProxyUrl(requestUrl, base.href);
  }
}

const JS_SANDBOX_SCRIPT = `/* JS Sandbox (omitted for brevity) */`; // No changes here

// ... [The JS_SANDBOX_SCRIPT and HTML/CSS rewriting functions remain exactly the same as the previous version] ...
// I will omit them here to keep the code block focused, but you should have them in your file.

// --- Proxy Logic (UPDATED) ---

async function proxyRequest(req: Request, targetUrl: URL): Promise<Response> {
  const outgoingHeaders = new Headers(req.headers);
  REQUEST_HEADERS_TO_STRIP.forEach(h => outgoingHeaders.delete(h));

  // --- THIS IS THE FIX ---
  outgoingHeaders.set("User-Agent", BROWSER_USER_AGENT);
  // --- END OF FIX ---

  outgoingHeaders.set("Host", targetUrl.host);
  outgoingHeaders.set("Origin", targetUrl.origin);
  outgoingHeaders.set("Referer", targetUrl.href);

  const upstreamResponse = await fetch(targetUrl, {
    method: req.method,
    headers: outgoingHeaders,
    body: (req.method !== "GET" && req.method !== "HEAD") ? req.body : null,
    redirect: "manual",
  });
  
  // The rest of the proxyRequest function remains the same...
  const responseHeaders = new Headers(upstreamResponse.headers);
  RESPONSE_HEADERS_TO_STRIP.forEach(h => responseHeaders.delete(h));
  responseHeaders.set("Access-Control-Allow-Origin", "*");
  responseHeaders.set("Access-Control-Expose-Headers", "*");
  
  const status = upstreamResponse.status;
  if (status >= 301 && status <= 308) {
    const location = responseHeaders.get("location");
    if (location) {
      const redirectedUrl = rewriteUrl(location, targetUrl, new URL(req.url));
      responseHeaders.set("location", redirectedUrl);
    }
  }

  const contentType = responseHeaders.get("content-type") || "";
  let body = upstreamResponse.body;
  if (body) {
    if (contentType.includes("text/html")) {
      // Assuming you have rewriteHtmlStream function from previous version
      body = rewriteHtmlStream(body, targetUrl, new URL(req.url));
    } else if (contentType.includes("text/css")) {
      // Assuming you have rewriteCssStream function from previous version
      body = rewriteCssStream(body, targetUrl, new URL(req.url));
    }
  }
  
  return new Response(body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}

// --- Main Server Handler (UPDATED FOR BETTER LOGGING) ---

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") { return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "*", "Access-Control-Allow-Headers": "*" } }); }

  const requestUrl = new URL(req.url);
  const targetUrlString = requestUrl.searchParams.get(PROXY_URL_PARAM);

  if (!targetUrlString) { return new Response("ERROR: 'url' query parameter is missing.", { status: 400 }); }

  let targetUrl: URL;
  try {
    targetUrl = new URL(targetUrlString);
  } catch (_) {
    return new Response("ERROR: Invalid 'url' query parameter.", { status: 400 });
  }

  const { protocol, hostname } = targetUrl;

  if (protocol !== "http:" && protocol !== "https:") { return new Response("ERROR: Only http and https schemes are supported.", { status: 400 }); }
  if (RESTRICTED_HOSTNAMES.has(hostname) || RESTRICTED_IP_PREFIXES.some(p => hostname.startsWith(p))) { return new Response("ERROR: Access to this address is forbidden.", { status: 403 }); }

  try {
    return await proxyRequest(req, targetUrl);
  } catch (e) {
    // --- THIS IS THE IMPROVED LOGGING ---
    // This will print the *actual* error to your Deno Deploy logs.
    console.error(`Upstream fetch failed for ${targetUrlString}:`, e.message, e.cause);
    // --- END OF IMPROVED LOGGING ---
    
    // Send a more informative error to the user if possible
    let userMessage = "ERROR: Upstream fetch failed.";
    if (e instanceof TypeError && e.message.includes('fetch')) {
      userMessage += " This often means the target server is down, blocked the request, or a DNS issue occurred.";
    }
    return new Response(userMessage, { status: 502 });
  }
});


// Helper functions for rewriting (should be in your file)
function rewriteHtmlStream(body: ReadableStream<Uint8Array>, targetUrl: URL, requestUrl: URL): ReadableStream<Uint8Array> {
  const rewriter = new HTMLRewriter()
    .on("head", { element: el => el.prepend(`<base href="${targetUrl.href}">`, { html: true }) })
    //.on("head", { element: el => el.prepend(`<script>${JS_SANDBOX_SCRIPT}</script>`, { html: true }) }) // Sandbox script can be added back if needed
    .on("[href]", new AttributeRewriter("href", targetUrl, requestUrl))
    .on("[src]", new AttributeRewriter("src", targetUrl, requestUrl))
    .on("[action]", new AttributeRewriter("action", targetUrl, requestUrl));
  return rewriter.transform(body);
}

function rewriteCssStream(body: ReadableStream<Uint8Array>, targetUrl: URL, requestUrl: URL): ReadableStream<Uint8Array> {
  // Implementation of CSS rewriter...
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
      controller.enqueue(encoder.encode(rewritten));
      buffer = '';
    },
    flush(controller) {
      if (buffer.length > 0) {
        controller.enqueue(encoder.encode(buffer));
      }
    }
  });
}

class AttributeRewriter {
  constructor(private attribute: string, private base: URL, private reqUrl: URL) {}
  element(element: Element) {
    const value = element.getAttribute(this.attribute);
    if (value) {
      element.setAttribute(this.attribute, rewriteUrl(value, this.base, this.reqUrl));
    }
  }
}
