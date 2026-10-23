// Markdown rendering for chat parts (plan §5.3). react-markdown is safe by default —
// raw HTML is dropped unless dangerouslyAllowHtml-style options are on, and URLs go
// through defaultUrlTransform — so the §6.1 sanitizer port stays an M3/M5 concern for
// tool results, not model text.
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function MarkdownContent({ text }: { text: string }) {
  return (
    <div className="md">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          // The side panel has no tab strip — a plain link would navigate the panel away.
          a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
