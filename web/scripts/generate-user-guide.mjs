import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function generateUserGuide() {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const source = path.join(root, "docs/user-guide");
  const index = JSON.parse(fs.readFileSync(path.join(source, "index.json"), "utf8"));
  const seen = new Set();
  const articles = index.map((topic) => {
    if (!/^[a-z][a-z-]*$/.test(topic.id) || seen.has(topic.id)) throw new Error("Invalid guide topic: " + topic.id);
    seen.add(topic.id);
    const content = fs.readFileSync(path.join(source, topic.id + ".md"), "utf8").replace(/\r\n/g, "\n").trim();
    if (!content.startsWith("# " + topic.title + "\n")) throw new Error("Guide title mismatch: " + topic.id);
    return { ...topic, content };
  });
  const target = path.join(root, "web/src/content/user-guide.json");
  const output = JSON.stringify(articles, null, 2) + "\n";
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!fs.existsSync(target) || fs.readFileSync(target, "utf8") !== output) fs.writeFileSync(target, output);
}
