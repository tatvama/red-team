// @vitest-environment node
import { describe, expect, it } from "vitest";
import { decodeEntities, htmlToText } from "./html-text";

describe("htmlToText", () => {
  it("extracts the title and readable structure", () => {
    const html = `<!doctype html>
      <html><head><title>  Docs &amp; Guides </title><meta charset="utf-8"><style>body{color:red}</style></head>
      <body>
        <nav><a href="/home">Home</a></nav>
        <h1>Getting   started</h1>
        <p>Install the <b>package</b>
           and run it.<br>Second line.</p>
        <ul><li>One</li><li>Two <a href="https://example.com/two?a=1&amp;b=2">link</a></li></ul>
        <script>alert("x")</script><noscript>Enable JS</noscript>
        <svg><text>chart</text></svg>
        <!-- hidden comment -->
        <h2>Next</h2><div>Done &mdash; 5 &lt; 6 &#169; &#x1F600;</div>
      </body></html>`;
    const { title, text } = htmlToText(html);
    expect(title).toBe("Docs & Guides");
    expect(text).toBe(
      [
        "Home",
        "",
        "# Getting started",
        "",
        "Install the package and run it.",
        "Second line.",
        "",
        "- One",
        "- Two link (https://example.com/two?a=1&b=2)",
        "",
        "## Next",
        "",
        "Done — 5 < 6 © 😀",
      ].join("\n"),
    );
  });

  it("drops relative and non-http links but keeps their text", () => {
    const { text } = htmlToText('<p><a href="/a">rel</a> <a href="javascript:alert(1)">js</a> <a href="mailto:x@y.z">mail</a></p>');
    expect(text).toBe("rel js mail");
  });

  it("does not repeat a link whose text is the URL, and shows bare URLs for empty links", () => {
    const { text } = htmlToText('<a href="https://a.example/">https://a.example/</a> <a href="https://b.example/"><img src="x.png"></a>');
    expect(text).toBe("https://a.example/ https://b.example/");
  });

  it("keeps preformatted code blocks intact", () => {
    const { text } = htmlToText("<p>Example:</p><pre><code>if (a &lt; b) {\n  run();\n}</code></pre><p>After</p>");
    expect(text).toBe("Example:\n\n```\nif (a < b) {\n  run();\n}\n```\n\nAfter");
  });

  it("does not turn escaped markup into tags or treat bare < as a tag", () => {
    const { text } = htmlToText("<p>&lt;script&gt;alert(1)&lt;/script&gt; and a < b</p>");
    expect(text).toBe("<script>alert(1)</script> and a < b");
  });

  it("handles documents without a title", () => {
    expect(htmlToText("<div>Hi</div>")).toEqual({ title: "", text: "Hi" });
  });
});

describe("decodeEntities", () => {
  it("decodes named and numeric entities and leaves unknown ones alone", () => {
    expect(decodeEntities("&quot;a&quot; &apos;b&#39; &nbsp;&hellip; &#0; &#xD800; &bogus;")).toBe(
      "\"a\" 'b'  … � � &bogus;",
    );
  });
});
