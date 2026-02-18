import type { ScrapedElement } from "@shared/schema";

export function orderedElementsToMarkdown(elements: ScrapedElement[]): string {
  const parts: string[] = [];

  for (const el of elements) {
    switch (el.type) {
      case "heading": {
        const level = Math.min(Math.max(el.level || 1, 1), 6);
        const prefix = "#".repeat(level);
        if (el.content) {
          parts.push(`${prefix} ${el.content.trim()}`);
        }
        break;
      }

      case "paragraph": {
        if (el.content) {
          parts.push(el.content.trim());
        }
        break;
      }

      case "list": {
        const items = el.items || el.children || [];
        const ordered = el.listType === "ordered";
        const listLines = items.map((item: any, i: number) => {
          const text = typeof item === "string" ? item : String(item);
          return ordered ? `${i + 1}. ${text.trim()}` : `- ${text.trim()}`;
        });
        if (listLines.length > 0) {
          parts.push(listLines.join("\n"));
        }
        break;
      }

      case "blockquote":
      case "quote": {
        if (el.content) {
          const lines = el.content.trim().split("\n");
          parts.push(lines.map((l) => `> ${l}`).join("\n"));
        }
        break;
      }

      case "media": {
        const tag = el.tag?.toLowerCase();
        const src = el.src || "";
        const alt = el.alt || "";
        if (tag === "video" || tag === "iframe") {
          const title = alt || "Video";
          parts.push(`[Video: ${title}](${src})`);
        } else {
          parts.push(`![${alt}](${src})`);
        }
        break;
      }

      case "table": {
        const headers = el.headers || [];
        const rows = el.rows || [];
        if (headers.length > 0) {
          parts.push(`| ${headers.join(" | ")} |`);
          parts.push(`| ${headers.map(() => "---").join(" | ")} |`);
          for (const row of rows) {
            parts.push(`| ${row.join(" | ")} |`);
          }
        } else if (rows.length > 0) {
          const colCount = rows[0].length;
          parts.push(`| ${rows[0].join(" | ")} |`);
          parts.push(`| ${Array(colCount).fill("---").join(" | ")} |`);
          for (let i = 1; i < rows.length; i++) {
            parts.push(`| ${rows[i].join(" | ")} |`);
          }
        }
        break;
      }

      case "code": {
        const lang = el.language || "";
        const code = el.content || "";
        parts.push(`\`\`\`${lang}\n${code}\n\`\`\``);
        break;
      }

      case "card": {
        if (el.content) {
          const heading = el.content.trim();
          parts.push(`### ${heading}`);
        }
        if (el.image) {
          const imgAlt = el.imageAlt || el.alt || "";
          parts.push(`![${imgAlt}](${el.image})`);
        }
        if (el.children && el.children.length > 0) {
          for (const child of el.children) {
            if (typeof child === "string") {
              parts.push(child.trim());
            }
          }
        }
        break;
      }

      default:
        if (el.content) {
          parts.push(el.content.trim());
        }
        break;
    }
  }

  return parts.join("\n\n") + "\n";
}

export function markdownToText(markdown: string): string {
  return markdown
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`{3}[\s\S]*?`{3}/g, "")
    .replace(/`(.+?)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/^>\s+/gm, "")
    .replace(/^\|.*\|$/gm, "")
    .replace(/^\s*[-|:]+\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
