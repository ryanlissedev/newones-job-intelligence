import { describe, expect, it } from "bun:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SignInFormView } from "./sign-in-form-view";

describe("SignInFormView server render", () => {
  const markup = renderToStaticMarkup(
    createElement(SignInFormView, { onSubmit: () => Promise.resolve() })
  );

  it("is the sign-in form itself, not a spinner waiting on the session", () => {
    expect(markup).toMatch(/<h1[^>]*>Welcome Back<\/h1>/u);
    expect(markup).toContain("<form");
    expect(markup).toContain('type="email"');
    expect(markup).toContain('type="password"');
    expect(markup).toContain('type="submit"');
    expect(markup).not.toContain("animate-spin");
  });

  it("posts if submitted before hydration, so credentials never reach the URL", () => {
    expect(markup).toMatch(/<form[^>]*method="post"/u);
  });
});
