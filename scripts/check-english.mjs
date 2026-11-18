import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(new URL("../web/package.json", import.meta.url));
const ts = require("typescript");
const han = /\p{Script=Han}/u;
const issues = [];
let checked = 0;
function walk(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) { walk(file); continue; }
    if (/\.test\.|LICENSE|\.wasm$|wasm_exec/.test(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    if (/\.(?:tsx?|m?[jc]s)$/.test(file)) {
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      function visit(node) {
        if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node) ||
            [ts.SyntaxKind.TemplateHead, ts.SyntaxKind.TemplateMiddle, ts.SyntaxKind.TemplateTail].includes(node.kind)) && han.test(node.text)) {
          issues.push(`${path.relative(root, file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: untranslated runtime text`);
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
      checked++;
    } else if (file.endsWith(".json")) {
      const value = JSON.parse(text);
      if (han.test(JSON.stringify(value))) issues.push(`${path.relative(root, file)}: untranslated JSON content`);
      checked++;
    } else if (file.endsWith(".md")) {
      if (han.test(text)) issues.push(`${path.relative(root, file)}: untranslated documentation`);
      checked++;
    }
  }
}
for (const dir of ["web/src", "pihost/src", "pihost/builtin-skills", "extensions/skills", "docs/user-guide"]) walk(path.join(root, dir));
const defaults = JSON.parse(fs.readFileSync(path.join(root, "pihost/src/domains/agents/prompt-defaults.json"), "utf8"));
for (const [key, prompt] of Object.entries({ ...defaults.prompts, ...defaults.custom, assistant: defaults.assistant })) {
  if (!prompt.includes("WORMHOLE") || !/English/.test(prompt)) issues.push(`Agent ${key}: missing WORMHOLE identity or English output instruction`);
}
for (const name of ["logo.svg", "logo-light.svg", "mark.svg", "mark-light.svg", "wormhole-logo.jpg", "black-hole-universe.png"]) {
  if (!fs.existsSync(path.join(root, "web/public/brand", name))) issues.push(`Missing brand asset: ${name}`);
}
if (issues.length) { console.error(issues.join("\n")); process.exitCode = 1; }
else console.log(`English localization checks passed across ${checked} source and content files. Legacy Unicode recognition patterns and test evidence are intentionally preserved.`);
