import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the karaoke application", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>声场 · 你的私人K歌房<\/title>/i);
  assert.match(html, /选歌台/);
  assert.match(html, /打开 MKV \/ MPG/);
  assert.match(html, /声音设备/);
  assert.match(html, /录下这首/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|Building your site/i);
});

test("keeps the complete local-first song workflow in source", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /multiple/);
  assert.match(page, /handleLibraryFiles/);
  assert.match(page, /loadKtvVideoFile/);
  assert.match(page, /FFFSType\.WORKERFS/);
  assert.match(page, /对调音轨/);
  assert.match(page, /getUserMedia/);
  assert.match(page, /MediaRecorder/);
  assert.match(page, /歌曲仅在本机处理/);
  assert.match(layout, /声场 · 你的私人K歌房/);
  assert.match(packageJson, /"license": "MIT"/);
});
