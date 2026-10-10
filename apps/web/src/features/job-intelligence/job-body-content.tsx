import { resolveBodyContentFormat } from "./body-content-format";
import type { BodyContentFormat } from "./body-content-format";
import { normalizeJobHtml, sanitizeJobHtml } from "./sanitize-job-html";
import type { JobSource } from "./types";

interface JobBodyContentProps {
  readonly bronSlug?: JobSource | null;
  readonly className?: string;
  readonly content: string;
  /** Override auto-resolved format (tests / callers with known wire types). */
  readonly format?: BodyContentFormat;
}

const bodyClassName = (className?: string): string =>
  ["text-xs leading-relaxed break-words", className].filter(Boolean).join(" ");

/**
 * Shared Opdracht / description renderer with per-bron sanitize policy.
 * HTML → allowlist sanitize + render; plain → escaped text; markdown → plain
 * until a markdown pipeline is needed (no bron uses it in the audit yet).
 *
 * CTP-483: normalize entity-encoded markup before format detection / sanitize
 * so `&lt;p&gt;` does not render as visible tags via innerHTML entity decode.
 */
export const JobBodyContent = ({
  bronSlug = null,
  className,
  content,
  format,
}: JobBodyContentProps) => {
  const normalized = normalizeJobHtml(content);
  const resolved =
    format ?? resolveBodyContentFormat({ bronSlug, content: normalized });

  if (!normalized.trim()) {
    return <p className={bodyClassName(className)}>Geen beschrijving.</p>;
  }

  if (resolved === "html") {
    const safe = sanitizeJobHtml(normalized);
    return (
      <div
        className={`${bodyClassName(className)} [&_a]:text-primary [&_a]:underline [&_li]:my-0.5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5`}
        data-body-format="html"
        // Sanitized via sanitizeJobHtml allowlist (CTP-481 / CTP-483).
        dangerouslySetInnerHTML={{ __html: safe }}
      />
    );
  }

  // plain + markdown (markdown rendered as escaped text until a pipeline lands)
  return (
    <p className={bodyClassName(className)} data-body-format={resolved}>
      {normalized}
    </p>
  );
};
