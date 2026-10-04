import { extname } from "node:path";
import { convert } from "./src/convert.js";

const publicDir = new URL(".", import.meta.url);
const port = Number(Bun.env.PORT || 3000);
const publicFiles = new Set(["index.html", "app.js", "styles.css"]);

Bun.serve({
  port,
  maxRequestBodySize: 512 * 1024 * 1024,
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/api/convert") {
      return convertRequest(request);
    }

    return serveStatic(url.pathname);
  }
});

console.log(`File Format Converter running at http://localhost:${port}`);

async function convertRequest(request) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return jsonResponse({ error: "Missing uploaded file." }, 400);
    }
    const input = Buffer.from(await file.arrayBuffer());
    const outputs = convert(input, file.name, String(form.get("source") || ""), String(form.get("target") || ""));
    return jsonResponse({
      outputs: outputs.map(output => ({ name: output.name, type: output.type, data: output.data.toString("base64") }))
    });
  } catch (error) {
    return jsonResponse({ error: error.message || "Conversion failed." }, 422);
  }
}

async function serveStatic(pathname) {
  const cleanPath = pathname === "/" ? "index.html" : pathname.slice(1);
  if (!publicFiles.has(cleanPath)) return new Response("Not found", { status: 404 });
  const file = Bun.file(new URL(cleanPath, publicDir));
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  return new Response(file, {
    headers: { "content-type": mimeFor(extname(cleanPath).slice(1)) }
  });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function mimeFor(format) {
  return {
    html: "text/html; charset=utf-8",
    css: "text/css; charset=utf-8",
    js: "text/javascript; charset=utf-8"
  }[format] || "application/octet-stream";
}
