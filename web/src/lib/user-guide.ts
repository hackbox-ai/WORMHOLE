import articles from "@/content/user-guide.json";

export type GuideTopic = (typeof articles)[number];
export const guideTopics: GuideTopic[] = articles;
export function guideTopic(id: string) {
  return guideTopics.find((topic) => topic.id === id) ?? guideTopics[0];
}
export function guideAnchor(text: string) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "");
}
export function guideSections(topic: GuideTopic) {
  return [...topic.content.matchAll(/^## (.+)$/gm)].map((match) => ({ title: match[1], id: guideAnchor(match[1]) }));
}
export function contextualGuide(pathname: string, search = "") {
  if (pathname.startsWith("/function/tasks/detail")) {
    const tab = new URLSearchParams(search).get("tab");
    const tabs: Record<string, string> = {
      browser: "browser",
      modeling: "modeling",
      findings: "findings",
      retests: "findings",
      graph: "findings",
      report: "findings",
      assets: "assets",
      coverage: "assets",
      intercept: "intercept",
    };
    return tabs[tab ?? ""] ?? "tasks";
  }
  return (
    [...guideTopics]
      .sort((a, b) => Math.max(0, ...b.paths.map((p) => p.length)) - Math.max(0, ...a.paths.map((p) => p.length)))
      .find((topic) => topic.paths.some((p) => pathname === p || pathname.startsWith(p + "/")))?.id ?? "quickstart"
  );
}
export function searchGuide(query: string) {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return guideTopics
    .flatMap((topic) => {
      const sections = topic.content.split(/^## /m);
      return sections.flatMap((body, index) => {
        const line = index ? body.split("\n")[0] : topic.title;
        const text = (topic.title + " " + topic.keywords.join(" ") + " " + body).toLocaleLowerCase();
        if (!terms.every((term) => text.includes(term))) return [];
        const plain = body.replace(/^#+ /gm, "").replace(/[*`]/g, "").replace(/\s+/g, " ").trim();
        const position = Math.max(0, plain.toLocaleLowerCase().indexOf(terms[0]) - 30);
        return [
          {
            topic: topic.id,
            title: topic.title,
            section: index ? guideAnchor(line) : "",
            heading: line,
            excerpt: plain.slice(position, position + 110),
          },
        ];
      });
    })
    .slice(0, 40);
}
