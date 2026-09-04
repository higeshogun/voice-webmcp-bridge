import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { minify } from "terser";

const source = await readFile(resolve("bookmarklet/webmcp-injector.js"), "utf8");
const result = await minify(source, { compress: true, mangle: true, format: { comments: false } });
if (!result.code) throw new Error("Terser did not produce bookmarklet code.");
await writeFile(resolve("bookmarklet/bookmarklet.txt"), `javascript:${encodeURIComponent(result.code)}`);
console.log("Created bookmarklet/bookmarklet.txt");
