"use client";

import { Component, createContext, memo, useContext, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import "katex/dist/katex.min.css";
import { Mermaid } from "./Mermaid";
import { normaliseMaths } from "@/lib/markdown";

/**
 * Renders a model's reply: GitHub-flavoured Markdown (tables, task lists, footnotes as sources),
 * LaTeX maths in every common delimiter, highlighted code with Copy, Mermaid diagrams and images.
 *
 * Raw HTML in a reply is shown as text, never run: react-markdown escapes it and drops unsafe
 * link schemes. If anything in a reply can't be rendered, the plain text is shown instead.
 */
const Streaming = createContext(false);

type HastNode = { type: string; value?: string; children?: HastNode[]; properties?: { className?: unknown } };
const textOf = (n?: HastNode): string => (n?.type === "text" ? (n.value ?? "") : (n?.children ?? []).map(textOf).join(""));

function CodeBlock({ node, children }: { node?: HastNode; children?: ReactNode }) {
  const streaming = useContext(Streaming);
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(false);
  const code = node?.children?.find((c) => (c as { tagName?: string }).tagName === "code");
  const classes = code?.properties?.className;
  const lang = (Array.isArray(classes) ? classes : [])
    .map(String)
    .find((c) => c.startsWith("language-"))
    ?.slice(9);
  const raw = textOf(code).replace(/\n$/, "");

  if (lang === "mermaid" && !streaming) return <Mermaid source={raw} />;

  return (
    <div className="md-code">
      <div className="md-code-bar">
        <span>{lang || "code"}</span>
        <span className="flex items-center gap-4">
          <button type="button" onClick={() => setWrap(!wrap)} aria-pressed={wrap}>
            {wrap ? "No wrap" : "Wrap"}
          </button>
          <button
            type="button"
            onClick={async () => {
              await navigator.clipboard.writeText(raw);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </span>
      </div>
      <pre className={wrap ? "whitespace-pre-wrap break-words" : ""}>{children}</pre>
    </div>
  );
}

const components: Components = {
  pre: ({ node, children }) => <CodeBlock node={node as HastNode}>{children}</CodeBlock>,
  table: ({ children }) => (
    <div className="md-table">
      <table>{children}</table>
    </div>
  ),
  // Links to the web open in a new tab; footnote links jump within the reply.
  a: ({ node: _node, href, children, ...rest }) =>
    href?.startsWith("#") ? (
      <a href={href} {...rest}>
        {children}
      </a>
    ) : (
      <a
        href={href}
        {...rest}
        target="_blank"
        rel="noopener noreferrer nofollow"
        // Web search citations are written as numbered links, [1](https://…), and shown small.
        className={typeof children === "string" && /^\d{1,2}$/.test(children) ? "cite" : undefined}
      >
        {children}
      </a>
    ),
  img: ({ src, alt }) =>
    // Images from replies load straight from their source, without telling it where they're shown.
    // eslint-disable-next-line @next/next/no-img-element
    typeof src === "string" && src ? <img src={src} alt={alt ?? ""} loading="lazy" referrerPolicy="no-referrer" /> : null,
};

class Fallback extends Component<{ text: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidUpdate(prev: { text: string }) {
    if (prev.text !== this.props.text && this.state.failed) this.setState({ failed: false });
  }
  render() {
    return this.state.failed ? <div className="whitespace-pre-wrap">{this.props.text}</div> : this.props.children;
  }
}

export const Markdown = memo(function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <Fallback text={text}>
      <Streaming.Provider value={streaming}>
        <div className="md">
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[[rehypeKatex, { errorColor: "currentColor", strict: false }], [rehypeHighlight, { detect: false }]]}
            remarkRehypeOptions={{ footnoteLabel: "Sources", footnoteLabelTagName: "h3", footnoteLabelProperties: {} }}
            components={components}
          >
            {normaliseMaths(text)}
          </ReactMarkdown>
        </div>
      </Streaming.Provider>
    </Fallback>
  );
});
