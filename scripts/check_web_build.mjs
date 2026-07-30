import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const sourceRoot = join(projectRoot, "web");
const buildRoot = join(projectRoot, "build", "web");
const requiredNotices = [
  "assets/Inter-LICENSE.txt",
  "assets/logic-solver-LICENSE.txt",
  "assets/lucide-LICENSE.txt",
];
const requiredDocuments = ["docs/ULTRA_EVALUATION.pdf"];
const references = [
  /(?:from\s+|new Worker\()\s*["'](\.\/[^"'?]+)/g,
  /(?:src|href)=["']([^"'?#]+\.(?:js|css|png|webp|ttf))/g,
  /url\(["']?([^"'?#)]+)/g,
];

/** Assert that every local runtime dependency exists in the staged Pages build. */
function checkReferences(sourcePath, buildPath) {
  const content = readFileSync(sourcePath, "utf8");
  for (const pattern of references) {
    for (const match of content.matchAll(pattern)) {
      const target = join(dirname(buildPath), match[1]);
      assert.ok(existsSync(target), `${basename(sourcePath)} references missing ${match[1]}`);
    }
  }
}

for (const filename of readdirSync(sourceRoot)) {
  if (!filename.endsWith(".js")) continue;
  checkReferences(join(sourceRoot, filename), join(buildRoot, filename));
}
checkReferences(join(sourceRoot, "index.html"), join(buildRoot, "index.html"));
checkReferences(join(sourceRoot, "styles.css"), join(buildRoot, "styles.css"));
for (const filename of requiredNotices) {
  assert.ok(existsSync(join(buildRoot, filename)), `Build is missing required notice ${filename}`);
}
for (const filename of requiredDocuments) {
  assert.ok(existsSync(join(buildRoot, filename)), `Build is missing required document ${filename}`);
}

console.log("Web deployment artifact is complete.");
