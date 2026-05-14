#!/usr/bin/env bun
import { mkdir, copyFile, readFile, writeFile, rm } from "fs/promises";
import path from "path";

const root = process.cwd();
const out = path.join(root, "build", "electron");
const avatarOut = path.join(out, "avatar");

await rm(out, { recursive: true, force: true });
await mkdir(avatarOut, { recursive: true });

await Bun.build({
  entrypoints: ["src/electron/main.ts"],
  outdir: out,
  target: "node",
  format: "cjs",
  external: ["electron"],
  naming: "main.cjs",
});

await Bun.build({
  entrypoints: ["src/electron/backend.ts"],
  outdir: out,
  target: "bun",
  format: "esm",
  external: ["sharp", "node-screenshots", "mock-aws-s3", "aws-sdk", "nock"],
  naming: "backend.js",
});

await Bun.build({
  entrypoints: ["src/electron/preload.ts"],
  outdir: out,
  target: "node",
  format: "cjs",
  external: ["electron"],
  naming: "preload.cjs",
});

await Bun.build({
  entrypoints: ["src/avatar/index.ts"],
  outdir: avatarOut,
  target: "browser",
  format: "esm",
  naming: "index.js",
});

await Bun.build({
  entrypoints: ["src/avatar/services/transcriptionWorker.ts"],
  outdir: avatarOut,
  target: "browser",
  format: "esm",
  naming: "transcriptionWorker.js",
});

let html = await readFile(path.join(root, "src", "avatar", "index.html"), "utf8");
html = html
  .replaceAll("views://avatar/index.css", "./index.css")
  .replaceAll("views://avatar/agent-activity.css", "./agent-activity.css")
  .replaceAll("views://avatar/index.js", "./index.js");
await writeFile(path.join(avatarOut, "index.html"), html);
await copyFile(path.join(root, "src", "avatar", "index.css"), path.join(avatarOut, "index.css"));
await copyFile(path.join(root, "src", "avatar", "agent-activity.css"), path.join(avatarOut, "agent-activity.css"));

console.log(`✅ Electron build written to ${out}`);
