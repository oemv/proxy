// --- Module Loading & Pre-warming (CRITICAL FIX) ---
// We dynamically import to ensure the code is loaded.
const { HTMLRewriter } = await import("https://deno.land/x/lol_html@0.1.0/mod.ts");

// Then, we create a "dummy" instance and immediately free it.
// This forces the underlying WebAssembly to fully initialize and compile
// BEFORE the server starts, definitively solving the race condition.
new HTMLRewriter().free();

// --- Configuration ---
const PROXY_URL_PARAM = "url";
const BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const REQUEST_HEADERS_TO_STRIP = new Set(["host", "user-agent", "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor"]);
const RESPONSE_HEADERS_TO_STRIP = new Set(["connection", "content-encoding", "content-length", "transfer-encoding", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers", "upgrade", "content-security-policy", "content-security-policy-report-only", "strict-transport-security", "x-frame-options"]);
const RESTRICTED_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const RESTRICTED_IP_PREFIXES = ["10.", "192.168.", "172.16.", "172.17.", "172.18.", "172.19.", "172.20.", "172.21.", "172.22.", "172.23.", "172.24.", "172.25.", "172.26.", "172.27.", "172.28.", "172.29.", "172.30.", "172.31.", "169.254.", "fc00::", "fe80::"];

// --- JS Sandbox Script ---
const JS_SANDBOX_SCRIPT = `
const originalFetch=window.fetch;const originalXHR=window.XMLHttpRequest;const originalWebSocket=window.WebSocket;const originalLocation=window.location;const PROXY_PARAM="${PROXY_URL_PARAM}";function getProxiedUrl(a){const b=new URL(a,document.baseURI).href,c=new URL(window.location.href);return c.searchParams.set(PROXY_PARAM,b),c.href}window.fetch=(a,b)=>{const c=a instanceof Request?a.url:a;return originalFetch(getProxiedUrl(c),b)},window.XMLHttpRequest.prototype.open=function(a,b,c,d,e){return originalXHR.prototype.open.call(this,a,getProxiedUrl(b),c,d,e)},window.WebSocket=function(a,b){try{const c=new URL(a,document.baseURI),d="https:"===c.protocol||"wss:"===c.protocol,e=new URL(window.location.href);return e.protocol=d?"wss:":"ws:",e.searchParams.set(PROXY_PARAM,c.href),new originalWebSocket(e.href,b)}catch(a){return console.error("WebSocket proxying failed:",a),Promise.reject(a)}},Object.defineProperty(window,"location",{get:()=>({...originalLocation,assign:a=>originalLocation.assign(getProxiedUrl(a)),replace:a=>originalLocation.replace(getProxiedUrl(a)),reload:()=>originalLocation.reload(),toString:()=>originalLocation.toString(),href:originalLocation.href}),set:a=>{originalLocation.href=getProxiedUrl(a)}}),document.addEventListener("submit",a=>{const b=a.target;b&&"FORM"===b.tagName&&b.action&&(b.action=getProxiedUrl(b.action))}),document.addEventListener("click",a=>{let b=a.target;for(;"A"!==b.tagName&&"AREA"!==b.tagName&&b;)b=b.parentNode;b&&b.href&&!b.href.includes("?"+PROXY_PARAM+"=")&&(b.href=getProxiedUrl(b.href))});const originalWindowOpen=window.open;window.open=function(a,b,c){return a?originalWindowOpen(getProxiedUrl(a),b,c):originalWindowOpen(a,b,c)};
`;

// --- Rewrite Logic ---
function getProxyUrl(requestUrl: URL, target: string): string { const newUrl = new URL(requestUrl.href); newUrl.searchParams.set(PROXY_URL_PARAM, target); return newUrl.href; }
function rewriteUrl(url: string, base: URL, requestUrl: URL): string { try { return getProxyUrl(requestUrl, new URL(url, base).href); } catch { return getProxyUrl(requestUrl, base.href); } }
class AttributeRewriter { constructor(private attribute: string, private base: URL, private reqUrl: URL) {} element(element: Element) { const value = element.getAttribute(this.attribute); if (value) { element.setAttribute(this.attribute, rewriteUrl(value, this.base, this.reqUrl)); if (this.attribute.toLowerCase() === 'integrity') element.removeAttribute('integrity'); } } }
class SrcsetRewriter { constructor(private base: URL, private reqUrl: URL) {} element(element: Element) { const value = element.getAttribute("srcset"); if (value) { const rewritten = value.split(",").map(part => { const [url, ...rest] = part.trim().split(/\s+/); return [rewriteUrl(url, this.base, this.reqUrl), ...rest].join(" "); }).join(", "); element.setAttribute("srcset", rewritten); } } }
function rewriteHtmlStream(body: ReadableStream<Uint8Array>, targetUrl: URL, requestUrl: URL): ReadableStream<Uint8Array> { const rewriter = new HTMLRewriter().on("head", { element: el => { el.prepend(`<base href="${targetUrl.href}">`, { html: true }); el.prepend(`<script>${JS_SANDBOX_SCRIPT}</script>`, { html: true }); } }).on("[href]", new AttributeRewriter("href", targetUrl, requestUrl)).on("[src]", new AttributeRewriter("src", targetUrl, requestUrl)).on("[action]", new AttributeRewriter("action", targetUrl, requestUrl)).on("[poster]", new AttributeRewriter("poster", targetUrl, requestUrl)).on("script", new AttributeRewriter("integrity", targetUrl, requestUrl)).on("link", new AttributeRewriter("integrity", targetUrl, requestUrl)).on("form", { element: el => el.removeAttribute('target') }).on("[srcset]", new SrcsetRewriter(targetUrl, requestUrl)); return rewriter.transform(body); }
function rewriteCssStream(body: ReadableStream<Uint8Array>, targetUrl: URL, requestUrl: URL): ReadableStream<Uint8Array> { const decoder = new TextDecoder(); const encoder = new TextEncoder(); const urlRegex = /url\((['"]?)(.*?)(['"]?)\)/gi; let buffer = ''; return new TransformStream({ transform(chunk, controller) { buffer += decoder.decode(chunk, { stream: true }); const rewritten = buffer.replaceAll(urlRegex, (_match, p1, p2, p3) => { if (p2.startsWith("data:")) return `url(${p1}${p2}${p3})`; return `url(${p1}${rewriteUrl(p2, targetUrl, requestUrl)}${p3})`; }); controller.enqueue(encoder.encode(rewritten)); buffer = ''; }, flush(controller) { if (buffer.length > 0) { const rewritten = buffer.replaceAll(urlRegex, (_match, p1, p2, p3) => { if (p2.startsWith("data:")) return `url(${p1}${p2}${p3})`; return `url(${p1}${rewriteUrl(p2, targetUrl, requestUrl)}${p3})`; }); controller.enqueue(encoder.encode(rewritten)); } } }); }

// --- Proxy Logic ---
async function proxyRequest(req: Request, targetUrl: URL): Promise<Response> {
  const outgoingHeaders = new Headers(req.headers);
  REQUEST_HEADERS_TO_STRIP.forEach(h => outgoingHeaders.delete(h));
  outgoingHeaders.set("User-Agent", BROWSER_USER_AGENT);
  outgoingHeaders.set("Host", targetUrl.host);
  outgoingHeaders.set("Origin", targetUrl.origin);
  outgoingHeaders.set("Referer", targetUrl.href);
  const upstreamResponse = await fetch(targetUrl, { method: req.method, headers: outgoingHeaders, body: (req.method !== "GET" && req.method !== "HEAD") ? req.body : null, redirect: "manual" });
  const responseHeaders = new Headers(upstreamResponse.headers);
  RESPONSE_HEADERS_TO_STRIP.forEach(h => responseHeaders.delete(h));
  responseHeaders.set("Access-Control-Allow-Origin", "*");
  responseHeaders.set("Access-Control-Expose-Headers", "*");
  const setCookieHeader = responseHeaders.get("set-cookie");
  if (setCookieHeader) { const newCookie = setCookieHeader.split(/, (?=[^;]+=[^;]+;)/).map(c => c.replace(/domain=.*?;/i, "").replace(/; path=\/.*?;/i, "; path=/")).join(", "); responseHeaders.set("set-cookie", newCookie); }
  const status = upstreamResponse.status;
  if (status >= 301 && status <= 308) { const location = responseHeaders.get("location"); if (location) { const redirectedUrl = rewriteUrl(location, targetUrl, new URL(req.url)); responseHeaders.set("location", redirectedUrl); } }
  const contentType = responseHeaders.get("content-type") || "";
  let body = upstreamResponse.body;
  if (body) {
    if (contentType.includes("text/html")) { body = rewriteHtmlStream(body, targetUrl, new URL(req.url)); }
    else if (contentType.includes("text/css")) { body = rewriteCssStream(body, targetUrl, new URL(req.url)); }
  }
  return new Response(body, { status: upstreamResponse.status, statusText: upstreamResponse.statusText, headers: responseHeaders });
}

// --- Main Server Handler ---
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") { return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "*", "Access-Control-Allow-Headers": "*" } }); }
  const requestUrl = new URL(req.url);
  const targetUrlString = requestUrl.searchParams.get(PROXY_URL_PARAM);
  if (!targetUrlString) { return new Response("ERROR: 'url' query parameter is missing.", { status: 400 }); }
  let targetUrl: URL;
  try { targetUrl = new URL(targetUrlString); } catch (_) { return new Response("ERROR: Invalid 'url' query parameter.", { status: 400 }); }
  const { protocol, hostname } = targetUrl;
  if (protocol !== "http:" && protocol !== "https:") { return new Response("ERROR: Only http and https schemes are supported.", { status: 400 }); }
  if (RESTRICTED_HOSTNAMES.has(hostname) || RESTRICTED_IP_PREFIXES.some(p => hostname.startsWith(p))) { return new Response("ERROR: Access to this address is forbidden.", { status: 403 }); }
  try { return await proxyRequest(req, targetUrl); } catch (e) { console.error(`Proxy error for ${targetUrlString}:`, e); let userMessage = `ERROR: Upstream fetch failed. Reason: ${e.message}`; return new Response(userMessage, { status: 502 }); }
});
