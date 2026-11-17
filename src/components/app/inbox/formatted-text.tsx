import { Fragment } from "react";

import { parseRichText, type BlockNode, type InlineNode } from "@/lib/inbox/rich-text";
import { cn } from "@/lib/utils";

/**
 * A bare tracking URL can run to 300 characters and, shown in full, buries
 * the sentence it belongs to. Past this length show host + path only and keep
 * the whole thing in `title` (the href itself is never touched).
 */
const MAX_LINK_TEXT = 60;

function linkLabel(value: string, href: string): string {
  if (value !== href || value.length <= MAX_LINK_TEXT) return value;
  try {
    const u = new URL(href);
    const path = u.pathname === "/" ? "" : u.pathname;
    const tail = u.search || u.hash ? "…" : "";
    const base = u.hostname.replace(/^www\./, "") + path + tail;
    return base.length > MAX_LINK_TEXT ? base.slice(0, MAX_LINK_TEXT - 1) + "…" : base;
  } catch {
    return value.slice(0, MAX_LINK_TEXT - 1) + "…";
  }
}

function renderInline(nodes: InlineNode[], keyPrefix: string) {
  return nodes.map((node, i) => {
    const key = `${keyPrefix}-${i}`;
    switch (node.type) {
      case "text":
        return <Fragment key={key}>{node.value}</Fragment>;
      case "bold":
        return (
          <strong key={key} className="font-semibold">
            {renderInline(node.children, key)}
          </strong>
        );
      case "italic":
        return (
          <em key={key} className="italic">
            {renderInline(node.children, key)}
          </em>
        );
      case "strike":
        return (
          <span key={key} className="line-through">
            {renderInline(node.children, key)}
          </span>
        );
      case "mono":
        return (
          <code
            key={key}
            className="rounded-control bg-foreground/10 px-1 py-px font-mono text-[0.92em]"
          >
            {node.value}
          </code>
        );
      case "link": {
        const label = linkLabel(node.value, node.href);
        return (
          <a
            key={key}
            href={node.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            title={label === node.value ? undefined : node.href}
            className="underline underline-offset-2 hover:opacity-80 [overflow-wrap:anywhere]"
            onClick={(e) => e.stopPropagation()}
          >
            {label}
          </a>
        );
      }
    }
  });
}

function renderBlock(block: BlockNode, key: string) {
  switch (block.type) {
    case "code":
      return (
        <pre
          key={key}
          className="my-1 overflow-x-auto rounded-control bg-foreground/10 px-2 py-1.5 font-mono text-[0.85em] leading-relaxed"
        >
          {block.value}
        </pre>
      );
    case "quote":
      return (
        <div key={key} className="my-0.5 border-l-2 border-current/40 pl-2 opacity-90">
          {renderInline(block.children, key)}
        </div>
      );
    case "bullet":
      return (
        <div key={key} className="flex gap-1.5">
          <span aria-hidden className="select-none opacity-70">
            •
          </span>
          <span className="min-w-0 flex-1">{renderInline(block.children, key)}</span>
        </div>
      );
    case "ordered":
      return (
        <div key={key} className="flex gap-1.5">
          <span aria-hidden className="select-none tabular-nums opacity-70">
            {block.marker}
          </span>
          <span className="min-w-0 flex-1">{renderInline(block.children, key)}</span>
        </div>
      );
    case "paragraph":
      // An empty line still has to take up its blank row.
      return (
        <div key={key} className="min-h-[1em] whitespace-pre-wrap">
          {renderInline(block.children, key)}
        </div>
      );
  }
}

/**
 * Renders a message body with WhatsApp-style formatting — `*bold*`,
 * `_italic_`, `~strike~`, `` `mono` ``, ``` blocks, `>` quotes, lists and
 * autolinked URLs. The text itself is never altered; this only styles it.
 */
export function FormattedText({
  text,
  className,
}: {
  text: string | null | undefined;
  className?: string;
}) {
  if (!text) return null;
  const blocks = parseRichText(text);
  return (
    <div className={cn("break-words [overflow-wrap:anywhere]", className)}>
      {blocks.map((block, i) => renderBlock(block, `b${i}`))}
    </div>
  );
}
