// Filename: main.ts

// Deno.serve is the modern, fast way to create an HTTP server in Deno.
Deno.serve(async (req: Request) => {
  const requestUrl = new URL(req.url);
  const targetUrlString = requestUrl.searchParams.get("url");

  if (!targetUrlString) {
    return new Response("ERROR: 'url' query parameter is fucking missing, genius.", {
      status: 400,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  let targetUrl;
  try {
    targetUrl = new URL(targetUrlString);
  } catch (_) {
    return new Response(
      "ERROR: 'url' query parameter is a fucking invalid URL. Try harder.",
      {
        status: 400,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      },
    );
  }

  // --- Security: Prevent SSRF-like attacks to common local/internal IPs ---
  // This is a basic check. A truly robust solution might need more.
  const restrictedHostnames = [
    "localhost",
    "127.0.0.1",
    "[::1]", // IPv6 loopback
  ];
  const restrictedIpPrefixes = [
    "10.",
    "192.168.",
    "172.16.", "172.17.", "172.18.", "172.19.",
    "172.20.", "172.21.", "172.22.", "172.23.",
    "172.24.", "172.25.", "172.26.", "172.27.",
    "172.28.", "172.29.", "172.30.", "172.31.",
    "169.254.", // Link-local
    "fc00::",    // IPv6 Unique Local Addresses
    "fe80::",    // IPv6 Link-local
  ];

  if (restrictedHostnames.includes(targetUrl.hostname) ||
      restrictedIpPrefixes.some(prefix => targetUrl.hostname.startsWith(prefix))) {
    return new Response(
      "ERROR: Proxying to local or private network addresses is fucking forbidden.",
      {
        status: 403, // Forbidden
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      },
    );
  }
  // --- End Security ---


  // Prepare headers for the outgoing request.
  // Copy most headers from the incoming request.
  const outgoingHeaders = new Headers(req.headers);

  // Host header should be set by fetch based on the targetUrl, so remove the client's Host.
  outgoingHeaders.delete("host");
  // Deno Deploy might add its own via header, or you might want a specific one.
  // outgoingHeaders.set("Via", "Deno-Fucking-Fast-Proxy/1.0"); 
  // Add X-Forwarded-For if you care (adds a tiny bit of processing)
  const clientIp = req.headers.get("x-forwarded-for")?.split(',')[0].trim() || 
                   req.headers.get("x-real-ip") ||
                   (Deno.env.get("DENO_DEPLOYMENT_ID") ? req.headers.get("fly-client-ip") : "unknown"); // Fly specific, adapt if needed or remove
  
  if (clientIp && clientIp !== "unknown") {
    outgoingHeaders.append("X-Forwarded-For", clientIp);
  }
  // Remove Deno Deploy specific headers before sending to target
  outgoingHeaders.delete("fly-forwarded-proto");
  outgoingHeaders.delete("fly-region");
  // ... any other platform specific headers you don't want to leak

  try {
    const response = await fetch(targetUrl.toString(), {
      method: req.method,
      headers: outgoingHeaders,
      body: (req.method !== "GET" && req.method !== "HEAD") ? req.body : null,
      redirect: "manual", // IMPORTANT: Let the client handle redirects. Proxy shouldn't follow.
    });

    // Prepare headers for the response to the client.
    // Copy headers from the target's response.
    const responseHeaders = new Headers(response.headers);

    // Standard Hop-by-hop headers that should NOT be copied.
    const hopByHopHeaders = [
      "connection", "keep-alive", "proxy-authenticate",
      "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade",
      // "content-encoding" is tricky. If the proxy decompresses, it should be removed.
      // If it passes through compressed, it should be kept. `fetch` usually handles this.
      // "content-length" will be recalculated by the runtime if body is streamed/transformed.
      // For direct streaming, it might be okay.
    ];
    hopByHopHeaders.forEach(h => responseHeaders.delete(h));

    // Add CORS headers to make your proxy usable from any fucking webpage
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    responseHeaders.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, HEAD, PATCH");
    responseHeaders.set("Access-Control-Allow-Headers", req.headers.get("Access-Control-Request-Headers") || "*"); // Reflect requested headers or allow all
    responseHeaders.set("Access-Control-Expose-Headers", "*"); // Expose all headers

    // Handle OPTIONS preflight requests for CORS
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204, // No Content
        headers: responseHeaders,
      });
    }
    
    // Stream the response body directly. This is KEY for performance and low memory.
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });

  } catch (e) {
    console.error(`FUCKING PROXY ERROR for ${targetUrlString}:`, e);
    let message = "ERROR: Upstream fetch fucking failed.";
    if (e instanceof TypeError && e.message.includes("invalid URL scheme")) {
        message = "ERROR: Invalid URL scheme. Only http and https are fucking supported."
    } else if (e instanceof TypeError && e.message.includes("Failed to fetch")) {
        // This can be DNS resolution failure, connection refused, etc.
        message = "ERROR: Failed to connect to the target server. Is it fucking up?"
    }
    return new Response(message + `\nError detail: ${e.message}`, {
      status: 502, // Bad Gateway
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
});

console.log("FUCKING FASTEST PROXY SERVER IS UP AND RUNNING, BITCHES!");
console.log("Access it like: http://localhost:8000/?url=https://example.com");
