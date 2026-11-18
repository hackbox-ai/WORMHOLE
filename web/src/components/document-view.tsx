"use client";

import { useId, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { components } from "@/components/markdown";

function outline(text: string) {
  let fence = "";
  return text.split("\n").flatMap((line, index) => {
    const block = line.trim().match(/^(`{3,}|~{3,})/);
    if (block) { if (!fence) fence = block[1][0]; else if (block[1][0] === fence) fence = ""; return []; }
    if (fence) return [];
    const heading = line.match(/^(#{1,3})\s+(.+?)\s*#*\s*$/);
    return heading ? [{ line: index + 1, depth: heading[1].length, text: heading[2].replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*_`]/g, "") }] : [];
  });
}

export function DocumentView({ text, label = "Report directory" }: { text: string; label?: string }) {
  const prefix = useId();
  const headings = useMemo(() => outline(text), [text]);
  const headingId = (line?: number) => `${prefix}-heading-${line}`;
  return <div className="workbench-document">
    {headings.length > 0 && <nav className="document-outline" aria-label={label}>
      <span className="text-xs text-muted-foreground">Table of Contents</span>
      {headings.map(heading => <button type="button" key={heading.line} data-depth={heading.depth} onClick={() => document.getElementById(headingId(heading.line))?.scrollIntoView({ behavior: "smooth", block: "start" })}>{heading.text}</button>)}
    </nav>}
    <article className="document-prose">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ ...components,
        h1: ({ node, ...props }) => <h1 id={headingId(node?.position?.start.line)} {...props} />,
        h2: ({ node, ...props }) => <h2 id={headingId(node?.position?.start.line)} {...props} />,
        h3: ({ node, ...props }) => <h3 id={headingId(node?.position?.start.line)} {...props} />,
      }}>{text}</ReactMarkdown>
    </article>
  </div>;
}
