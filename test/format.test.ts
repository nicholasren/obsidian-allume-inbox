import { test } from "node:test";
import assert from "node:assert/strict";
import { attachmentName, insertUnderHeading, noteTitle, renderListItem, renderNote, sanitizeFileName } from "../src/format";
import { contentFromResult, extractCards, parseMarkdownTable } from "../src/cards";
import { fileModeArgs, slotFor } from "../src/allume";
import { redact } from "../src/redact";

test("heading missing: appended at the end with a blank line", () => {
  const out = insertUnderHeading("My freehand note\nmore text\n", "## Captured", "- a");
  assert.equal(out, "My freehand note\nmore text\n\n## Captured\n- a\n");
});

test("empty note gets heading and item", () => {
  assert.equal(insertUnderHeading("", "## Captured", "- a"), "## Captured\n- a\n");
});

test("existing heading at the end: item appended to its section", () => {
  const out = insertUnderHeading("x\n\n## Captured\n- a\n\n", "## Captured", "- b");
  assert.equal(out, "x\n\n## Captured\n- a\n- b\n");
});

test("existing heading followed by another section: item stays in its section", () => {
  const out = insertUnderHeading("## Captured\n- a\n\n## Later\ntext\n", "## Captured", "- b");
  assert.equal(out, "## Captured\n- a\n- b\n\n## Later\ntext\n");
});

test("deeper headings inside the section don't end it", () => {
  const out = insertUnderHeading("## Captured\n### sub\n- a\n## Next\n", "## Captured", "- b");
  assert.equal(out, "## Captured\n### sub\n- a\n- b\n\n## Next\n");
});

test("headings inside code fences are ignored", () => {
  const src = "```\n## Captured\n```\nbody\n";
  const out = insertUnderHeading(src, "## Captured", "- b");
  assert.equal(out, "```\n## Captured\n```\nbody\n\n## Captured\n- b\n");
});

test("list item: multi-line text is indented under the bullet, marker on line one", () => {
  const out = renderListItem({ id: "x1", content: { title: "Shopping", text: "milk\neggs\n\nbread" }, marker: true });
  assert.equal(out, "- Shopping %%allume:x1%%\n  milk\n  eggs\n\n  bread");
});

test("list item: link with title", () => {
  const out = renderListItem({ id: "u", content: { url: "https://a.b/c", title: "A [B]" }, marker: false });
  assert.equal(out, "- [A B](https://a.b/c)");
});

test("list item: image embeds, pdf links", () => {
  assert.equal(
    renderListItem({ id: "i", content: {}, attachment: "allume-x.png", marker: false }),
    "- ![[allume-x.png]]",
  );
  assert.equal(renderListItem({ id: "p", content: {}, attachment: "s.pdf", marker: false }), "- [[s.pdf]]");
});

test("list item: empty card is still captured, never dropped", () => {
  assert.match(renderListItem({ id: "e", content: {}, marker: true }), /nothing exportable.*%%allume:e%%/);
});

test("note mode: frontmatter and title", () => {
  const input = { id: "n1", content: { url: "https://x.y", title: "Read: this/that" }, marker: false };
  assert.equal(noteTitle(input, "2026-11-14 1032"), "2026-11-14 1032 Read this that");
  assert.equal(
    renderNote(input, "2026-11-14T10:32"),
    '---\nsource: allume\nallume_id: "n1"\ncaptured: 2026-11-14T10:32\nurl: "https://x.y"\n---\n[Read: this/that](https://x.y)\n',
  );
});

test("attachment names: date, short id, original name, extension from mime or bytes", () => {
  assert.equal(attachmentName({ fileName: "spec.pdf" }, "c-pdf-1", "2026-11-14"), "allume-2026-11-14-c-pdf-1-spec.pdf");
  assert.equal(attachmentName({ mimeType: "image/heic" }, "ABCDEF1234", "2026-11-14"), "allume-2026-11-14-ABCDEF12.heic");
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  assert.equal(attachmentName({ blob: png }, "z", "2026-11-14"), "allume-2026-11-14-z.png");
  assert.equal(sanitizeFileName('a/b:c*d?"e'), "a b c d e");
});

test("cards from JSON, structured and markdown payloads, oldest first", () => {
  const json = extractCards({ cards: [{ id: "b", type: "note", created_at: "2026-01-02" }, { id: "a", type: "URL", created_at: "2026-01-01" }] });
  assert.deepEqual(json.map((c) => [c.id, c.kind]), [["a", "url"], ["b", "text"]]);
  const md = extractCards("| ID | Type | Title |\n|---|---|---|\n| x | pdf | Spec |\n| y | board | B |");
  assert.deepEqual(md.map((c) => [c.id, c.kind, c.title]), [["x", "file", "Spec"], ["y", "board", "B"]]);
  assert.equal(parseMarkdownTable("no table").length, 0);
});

test("content: a text card that is only a URL becomes a link", () => {
  const c = contentFromResult({ content: [{ type: "text", text: JSON.stringify({ body: " https://x.y/z " }) }] });
  assert.equal(c.url, "https://x.y/z");
  assert.equal(c.text, undefined);
});

test("content: image blocks and file:// paths", () => {
  const c = contentFromResult({ content: [{ type: "image", data: "iVBORw0KGgoAAAANSUhEUg==", mimeType: "image/png" }] });
  assert.equal(c.mimeType, "image/png");
  assert.ok(c.blob && c.blob.length > 8);
  const p = contentFromResult({ content: [{ type: "text", text: "file:///Users/x/My%20File.pdf" }] }, undefined, true);
  assert.equal(p.filePath, "/Users/x/My File.pdf");
});

test("argument names come from each tool's schema", () => {
  const tool = { name: "t", inputSchema: { properties: { ids: { type: "array" }, destination_board_id: { type: "string" } } } };
  assert.deepEqual(slotFor(tool, ["board_id", "destination_board_id"]), { name: "destination_board_id", isArray: false });
  assert.deepEqual(slotFor(tool, ["card_id", "ids"], ["destination_board_id"]), { name: "ids", isArray: true });
  assert.deepEqual(slotFor(undefined, ["card_id"]), { name: "card_id", isArray: false });
  assert.deepEqual(fileModeArgs({ name: "c", inputSchema: { properties: { mode: { enum: ["body", "raw"] } } } }), { mode: "raw" });
  assert.deepEqual(fileModeArgs({ name: "c", inputSchema: { properties: { raw: { type: "boolean" } } } }), { raw: true });
});

test("content: a summary never names a local file, only a file-mode answer does", () => {
  const plain = contentFromResult({ content: [{ type: "text", text: "/Users/x/.ssh/id_ed25519" }] });
  assert.equal(plain.filePath, undefined);
  assert.equal(plain.text, "/Users/x/.ssh/id_ed25519");
  const json = contentFromResult({ content: [{ type: "text", text: JSON.stringify({ body: "hi", path: "/etc/hosts" }) }] });
  assert.equal(json.filePath, undefined);
});

test("note mode: a url can't break out of the frontmatter", () => {
  const content = contentFromResult({ content: [{ type: "text", text: JSON.stringify({ url: "https://a.b\npublish: true" }) }] });
  const note = renderNote({ id: "u", content, marker: false }, "2026-11-14T10:32");
  const frontmatter = note.split("\n---\n")[0];
  assert.ok(!frontmatter.includes("publish"), frontmatter);
});

test("captured text can't run as Templater or Dataview code", () => {
  const text = "<%* app.vault.trash() %>\n```dataviewjs\ndv.span(1)\n```\n`$= dv.current()`";
  for (const out of [
    renderNote({ id: "t", content: { text, title: "<% tp.date.now() %>" }, marker: false }, "2026-11-14T10:32"),
    renderListItem({ id: "t", content: { text }, marker: false }),
  ]) {
    assert.ok(!out.includes("<%"), out);
    assert.ok(!/```dataviewjs/.test(out), out);
    assert.ok(!out.includes("`$="), out);
  }
});

test("redact: keeps ids, types and dates; hides text, titles and paths, also inside JSON text blocks", () => {
  const result = {
    content: [{ type: "text", text: JSON.stringify({ cards: [{ id: "c1", kind: "note", title: "Bank PIN", body: "1234", createdAt: "2026-11-14", path: "/Users/me/x" }] }) }],
  };
  const out = JSON.stringify(redact(result));
  for (const kept of ["c1", "note", "2026-11-14", "cards"]) assert.ok(out.includes(kept), kept);
  for (const hidden of ["Bank PIN", "1234", "/Users/me"]) assert.ok(!out.includes(hidden), hidden);
});
