"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Check, CircleHelp, Copy, ExternalLink, Search } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { contextualGuide, guideAnchor, guideSections, guideTopic, guideTopics, searchGuide } from "@/lib/user-guide";

type Location = { topic: string; section: string };
export function HelpButton({
  topic,
  section,
  compact = false,
  label = "Instructions for use",
}: {
  topic?: string;
  section?: string;
  compact?: boolean;
  label?: string;
}) {
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);
  const [location, setLocation] = React.useState<Location>({ topic: "quickstart", section: "" });
  const trigger = React.useRef<HTMLButtonElement>(null);
  if (pathname.startsWith("/help")) return null;
  // Keep the dialog in the trigger's React tree so nested forms retain their
  // dismiss/focus boundaries while reading help.
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Button
        ref={trigger}
        type="button"
        variant="ghost"
        size={compact ? "icon-sm" : "sm"}
        className="guide-help-button shrink-0 text-muted-foreground"
        aria-label={label}
        title={label}
        onClick={() => {
          setLocation({
            topic: guideTopic(topic ?? contextualGuide(pathname, window.location.search)).id,
            section: guideAnchor(section ?? ""),
          });
          setOpen(true);
        }}
      >
        <CircleHelp className="size-3.5" />
        {!compact && <span>{label}</span>}
      </Button>
      <SheetContent
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          trigger.current?.focus();
        }}
        className="guide-sheet data-[side=right]:w-full data-[side=right]:sm:max-w-xl flex flex-col gap-0 p-0"
      >
        <SheetHeader className="border-b pr-12">
          <SheetTitle className="flex items-center gap-2">
            <CircleHelp className="size-4" />

            Instructions for use
          </SheetTitle>
          <SheetDescription className="sr-only">Operation steps and parameter description of the current function</SheetDescription>
        </SheetHeader>
        <GuideReader
          compact
          location={location}
          onNavigate={(topic, section = "") => setLocation({ topic, section })}
        />
        <div className="guide-sheet-footer">
          <Link
            href={
              "/help/?topic=" +
              location.topic +
              (location.section ? "&section=" + encodeURIComponent(location.section) : "")
            }
            target="_blank"
            rel="noreferrer"
          >

            View full description
            <ExternalLink className="size-3.5" />
          </Link>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function CodeBlock({ children }: { children?: React.ReactNode }) {
  const [copied, setCopied] = React.useState(false);
  const ref = React.useRef<HTMLPreElement>(null);
  return (
    <div className="guide-code">
      <pre ref={ref}>{children}</pre>
      <button
        type="button"
        aria-label="Copy Example"
        onClick={async () => {
          try {
            const text = ref.current?.textContent ?? "";
            if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
            else {
              const field = document.createElement("textarea"),
                focused = document.activeElement as HTMLElement | null;
              field.value = text;
              field.style.cssText = "position:fixed;opacity:0;pointer-events:none";
              ref.current?.parentElement?.append(field);
              field.focus();
              field.select();
              const success = document.execCommand("copy");
              field.remove();
              focused?.focus();
              if (!success) throw new Error("copy");
            }
            setCopied(true);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? <Check /> : <Copy />}
      </button>
    </div>
  );
}

export function GuideArticle({
  topic,
  section,
  onNavigate,
}: {
  topic: string;
  section: string;
  onNavigate: (topic: string, section?: string) => void;
}) {
  const article = guideTopic(topic),
    ref = React.useRef<HTMLElement>(null);
  React.useEffect(() => {
    const container = ref.current;
    if (!container) return;
    const target = section ? [...container.querySelectorAll<HTMLElement>("h2,h3")].find((h) => h.id === section) : null;
    if (target) target.scrollIntoView({ block: "start", behavior: "instant" });
    else container.closest(".guide-scroll")?.scrollTo({ top: 0 });
  }, [topic, section]);
  return (
    <article ref={ref} className="guide-article" aria-label={article.title + "Instructions for use"}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h2: ({ children }) => <h2 id={guideAnchor(String(children))}>{children}</h2>,
          h3: ({ children }) => <h3 id={guideAnchor(String(children))}>{children}</h3>,
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          table: ({ children }) => (
            <div className="guide-table">
              <table>{children}</table>
            </div>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(event) => {
                if (href?.startsWith("/help/")) {
                  event.preventDefault();
                  const url = new URL(href, window.location.origin);
                  onNavigate(url.searchParams.get("topic") ?? "quickstart", url.searchParams.get("section") ?? "");
                } else if (href?.startsWith("#")) {
                  event.preventDefault();
                  onNavigate(topic, decodeURIComponent(href.slice(1)));
                }
              }}
              target={href?.startsWith("http") ? "_blank" : undefined}
              rel={href?.startsWith("http") ? "noreferrer" : undefined}
            >
              {children}
            </a>
          ),
        }}
      >
        {article.content}
      </ReactMarkdown>
    </article>
  );
}

export function GuideReader({
  location,
  onNavigate,
  compact = false,
}: {
  location: Location;
  onNavigate: (topic: string, section?: string) => void;
  compact?: boolean;
}) {
  const [query, setQuery] = React.useState("");
  const article = guideTopic(location.topic),
    sections = guideSections(article);
  const results = React.useMemo(() => searchGuide(query), [query]);
  const select = (topic: string, section = "") => {
    setQuery("");
    onNavigate(topic, section);
  };
  return (
    <div className={"guide-reader" + (compact ? " guide-reader-compact" : "")}>
      <div className="guide-search">
        <Search className="size-4" />
        <Input
          aria-label="Search Instructions for Use"
          placeholder="Search function, parameter or question"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query && (
          <Button variant="ghost" size="sm" onClick={() => setQuery("")}>

            Clear
          </Button>
        )}
      </div>
      {query.trim() ? (
        <div className="guide-results guide-scroll" aria-live="polite">
          <p className="guide-result-count">{results.length ? results.length + " matches" : "No relevant instructions found"}</p>
          {results.map((result) => (
            <button
              type="button"
              className="guide-result"
              key={result.topic + ":" + result.section}
              onClick={() => select(result.topic, result.section)}
            >
              <span>{result.title}</span>
              <strong>{result.heading}</strong>
              <p>{result.excerpt}</p>
            </button>
          ))}
        </div>
      ) : (
        <>
          {compact ? (
            <div className="guide-compact-nav">
              <select aria-label="Select description chapter" value={article.id} onChange={(event) => select(event.target.value)}>
                {guideTopics.map((topic) => (
                  <option key={topic.id} value={topic.id}>
                    {topic.title}
                  </option>
                ))}
              </select>
              <select
                aria-label="Positioning description section"
                value={sections.some((s) => s.id === location.section) ? location.section : ""}
                onChange={(event) => select(article.id, event.target.value)}
              >
                <option value="">Beginning of chapter</option>
                {sections.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <nav className="guide-topics" aria-label="Description chapter">
              {[...new Set(guideTopics.map((t) => t.group))].map((group) => (
                <div key={group}>
                  <p>{group}</p>
                  {guideTopics
                    .filter((t) => t.group === group)
                    .map((t) => (
                      <button
                        type="button"
                        key={t.id}
                        aria-current={t.id === article.id ? "page" : undefined}
                        onClick={() => select(t.id)}
                      >
                        {t.title}
                      </button>
                    ))}
                </div>
              ))}
            </nav>
          )}
          <div className="guide-scroll">
            {!compact && sections.length > 0 && (
              <nav className="guide-outline" aria-label="Contents of this chapter">
                {sections.map((s) => (
                  <button
                    type="button"
                    key={s.id}
                    aria-current={location.section === s.id ? "location" : undefined}
                    onClick={() => select(article.id, s.id)}
                  >
                    {s.title}
                  </button>
                ))}
              </nav>
            )}
            <GuideArticle topic={article.id} section={location.section} onNavigate={select} />
          </div>
        </>
      )}
    </div>
  );
}
