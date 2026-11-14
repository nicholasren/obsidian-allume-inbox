import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AllumeMcp } from "../src/allume";
import { runSync } from "../src/sync";
import { FAKE, memLedger, opts, tempVault } from "./helpers";

async function connect(env: Record<string, string> = {}) {
  Object.assign(process.env, { FAKE_READONLY: "", FAKE_STYLE: "json", FAKE_FILEMODE: "", FAKE_SEARCH: "", FAKE_INBOX: "", ...env });
  return AllumeMcp.connect(FAKE, 10_000);
}

test("daily mode: everything lands under ## Captured, files in assets, no duplicates on re-run", async () => {
  const api = await connect();
  const v = tempVault();
  const ledger = memLedger();
  try {
    const r1 = await runSync(api, v.io, ledger, opts());
    assert.deepEqual(r1.errors, []);
    assert.equal(r1.added.length, 5); // the sub-board is skipped
    const note = v.file("Journals/2026-11-14.md");
    assert.equal(
      note,
      [
        "## Captured",
        "- Idea: capture to Obsidian via MCP %%allume:c-note-1%%",
        "- [Allume CLI](https://allume.com/cli-setup) %%allume:c-url-1%%",
        "- ![[allume-2026-11-14-c-img-1-whiteboard.png]] %%allume:c-img-1%%",
        "- [[allume-2026-11-14-c-pdf-1-spec.pdf]] %%allume:c-pdf-1%%",
        "  Spec",
        "- Shopping %%allume:c-note-2%%",
        "  milk",
        "  eggs",
        "",
        "  bread",
        "",
      ].join("\n"),
    );
    const assets = readdirSync(join(v.root, "assets")).sort();
    assert.deepEqual(assets, ["allume-2026-11-14-c-img-1-whiteboard.png", "allume-2026-11-14-c-pdf-1-spec.pdf"]);
    assert.ok(readFileSync(join(v.root, "assets", assets[1]), "utf8").startsWith("%PDF"));

    const r2 = await runSync(api, v.io, ledger, opts());
    assert.equal(r2.added.length, 0);
    assert.equal(v.file("Journals/2026-11-14.md"), note);
  } finally {
    api.close();
  }
});

test("daily mode respects the user's own text and an existing section", async () => {
  const api = await connect();
  const v = tempVault();
  await v.io.ensureFolder("Journals");
  await v.io.process("Journals/2026-11-14.md", () => "Morning thoughts.\n\n## Captured\n- earlier thing\n\n## Evening\nlater\n");
  try {
    await runSync(api, v.io, memLedger(), opts());
    const note = v.file("Journals/2026-11-14.md");
    assert.ok(note.startsWith("Morning thoughts.\n\n## Captured\n- earlier thing\n- Idea: capture"));
    assert.ok(note.endsWith("  bread\n\n## Evening\nlater\n"));
  } finally {
    api.close();
  }
});

test("lost ledger: the marker in the note still prevents duplicates", async () => {
  const api = await connect();
  const v = tempVault();
  try {
    await runSync(api, v.io, memLedger(), opts());
    const before = v.file("Journals/2026-11-14.md");
    await runSync(api, v.io, memLedger(), opts());
    assert.equal(v.file("Journals/2026-11-14.md"), before);
  } finally {
    api.close();
  }
});

test("remove after sync: synced cards are soft-deleted in Allume, sub-boards left alone", async () => {
  const api = await connect();
  const v = tempVault();
  try {
    const r = await runSync(api, v.io, memLedger(), opts({ afterSync: "delete" }));
    assert.equal(r.added.length, 5);
    assert.equal(r.moved, 5);
    assert.deepEqual(r.warnings, []);
    assert.deepEqual((await api.boardCards("inbox")).map((c) => c.id), ["b-sub"]);
  } finally {
    api.close();
  }
});

test("a later sync cleans up cards that were imported while set to keep", async () => {
  const api = await connect();
  const v = tempVault();
  const ledger = memLedger();
  try {
    await runSync(api, v.io, ledger, opts());
    const before = v.file("Journals/2026-11-14.md");
    const r = await runSync(api, v.io, ledger, opts({ afterSync: "delete" }));
    assert.equal(r.added.length, 0);
    assert.equal(r.moved, 5);
    assert.equal(v.file("Journals/2026-11-14.md"), before);
  } finally {
    api.close();
  }
});

test("built-in Inbox: read with list_inbox, cards moved onto a board with inbox_move", async () => {
  const api = await connect({ FAKE_INBOX: "list" });
  const v = tempVault();
  try {
    const boards = await api.inboxBoards();
    assert.deepEqual(boards.map((b) => b.title), ["Personal · Inbox", "Work · Inbox"]);
    const ledger = memLedger();
    const r = await runSync(api, v.io, ledger, opts({ boardId: boards[0].id, afterSync: "move", syncedBoardId: "b-projects" }));
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.warnings, []);
    assert.equal(r.added.length, 5);
    assert.equal(r.moved, 5);
    assert.equal((await api.boardCards("b-projects")).length, 5);
    const r2 = await runSync(api, v.io, ledger, opts({ boardId: boards[0].id, afterSync: "move", syncedBoardId: "b-projects" }));
    assert.equal(r2.added.length + r2.moved, 0);
  } finally {
    api.close();
  }
});

test("moving off an ordinary board isn't possible in Allume: warn, keep the cards", async () => {
  const api = await connect();
  const v = tempVault();
  try {
    const r = await runSync(api, v.io, memLedger(), opts({ afterSync: "move", syncedBoardId: "synced" }));
    assert.equal(r.added.length, 5);
    assert.equal(r.moved, 0);
    assert.match(r.warnings[0], /only move cards out of its built-in Inbox/);
  } finally {
    api.close();
  }
});

test("read-only MCP: still syncs, warns that cards stay put", async () => {
  const api = await connect({ FAKE_READONLY: "1" });
  const v = tempVault();
  try {
    const r = await runSync(api, v.io, memLedger(), opts({ afterSync: "delete" }));
    assert.equal(r.added.length, 5);
    assert.equal(r.moved, 0);
    assert.match(r.warnings[0], /read-only/);
  } finally {
    api.close();
  }
});

test("note mode, markdown payloads, raw blobs instead of file paths", async () => {
  const api = await connect({ FAKE_STYLE: "markdown", FAKE_FILEMODE: "raw" });
  const v = tempVault();
  try {
    const r = await runSync(api, v.io, memLedger(), opts({ mode: "note" }));
    assert.deepEqual(r.errors, []);
    const notes = readdirSync(join(v.root, "Inbox")).sort();
    assert.deepEqual(notes, [
      "2026-11-14 0001 Idea Idea capture to Obsidian via MCP.md".replace("Idea Idea", "Idea"),
      "2026-11-14 0002 Allume CLI.md",
      "2026-11-14 0003 whiteboard.png.md",
      "2026-11-14 0004 Spec.md",
      "2026-11-14 0005 Shopping.md",
    ]);
    const link = readFileSync(join(v.root, "Inbox", "2026-11-14 0002 Allume CLI.md"), "utf8");
    assert.match(link, /allume_id: "c-url-1"/);
    assert.match(link, /\[Allume CLI\]\(https:\/\/allume.com\/cli-setup\)/);
    const pdf = readdirSync(join(v.root, "assets")).find((f) => f.endsWith(".pdf"));
    assert.ok(pdf && readFileSync(join(v.root, "assets", pdf), "utf8").startsWith("%PDF"));
  } finally {
    api.close();
  }
});

test("dry run writes nothing", async () => {
  const api = await connect({ FAKE_STYLE: "structured" });
  const v = tempVault();
  try {
    const r = await runSync(api, v.io, memLedger(), opts({ dryRun: true }));
    assert.equal(r.preview.length, 5);
    assert.equal(existsSync(join(v.root, "Journals")), false);
  } finally {
    api.close();
  }
});

test("a missing helper gives a clear error", async () => {
  await assert.rejects(AllumeMcp.connect("/nope/allume-cli", 2000), /helper not found/);
});

test("board names resolve to ids: by search, by walking workspaces, or as an id", async () => {
  const api = await connect();
  try {
    assert.deepEqual(await api.resolveBoard("Inbox"), { id: "inbox", title: "Inbox" });
    assert.deepEqual(await api.resolveBoard(" inbox "), { id: "inbox", title: "inbox" });
    await assert.rejects(api.resolveBoard("Nope"), /Couldn't find an Allume board named “Nope”/);
  } finally {
    api.close();
  }
  const api2 = await connect({ FAKE_SEARCH: "none" });
  try {
    assert.deepEqual(await api2.resolveBoard("INBOX"), { id: "inbox", title: "Inbox" });
  } finally {
    api2.close();
  }
});

test("an unknown board id gives a hint to use the board's name", async () => {
  const api = await connect();
  try {
    await assert.rejects(api.boardCards("Inbox"), (e: any) => /No board with id/.test(e.message) && /name/.test(e.hint));
  } finally {
    api.close();
  }
});

test("built-in inboxes come from list_workspaces, optionally one workspace", async () => {
  const api = await connect();
  try {
    assert.deepEqual(
      (await api.inboxBoards()).map((b) => [b.id, b.title]),
      [
        ["inbox", "Personal · Inbox"],
        ["w1-pinbox", "Personal · Personal inbox"],
        ["w2-inbox", "Work · Inbox"],
        ["w2-pinbox", "Work · Personal inbox"],
      ],
    );
    assert.deepEqual((await api.inboxBoards("work")).map((b) => b.id), ["w2-inbox", "w2-pinbox"]);
  } finally {
    api.close();
  }
});

test("real Allume shape: placement ids, document ids, card_content falls back to the document id", async () => {
  const api = await connect({ FAKE_STYLE: "allume" });
  const v = tempVault();
  try {
    const cards = await api.boardCards("inbox");
    assert.equal(cards[0].id, "p-b-sub");
    assert.equal(cards[0].docId, "b-sub");
    assert.equal(cards[0].kind, "board");
    const r = await runSync(api, v.io, memLedger(), opts({ afterSync: "keep" }));
    assert.deepEqual(r.errors, []);
    assert.equal(r.added.length, 5);
    assert.match(v.file("Journals/2026-11-14.md"), /- Idea: capture to Obsidian via MCP %%allume:p-c-note-1%%/);
    assert.ok(existsSync(join(v.root, "assets")));
  } finally {
    api.close();
  }
});

for (const mode of ["tool", "card", "root"]) {
  test(`inbox that board_content refuses is read another way (${mode})`, async () => {
    const api = await connect({ FAKE_INBOX: mode });
    const v = tempVault();
    try {
      const boards = await api.inboxBoards("personal");
      assert.equal(boards[0].id, "inbox");
      const r = await runSync(api, v.io, memLedger(), opts({ boardId: boards[0].id }));
      assert.deepEqual(r.errors, []);
      assert.equal(r.added.length, 5);
    } finally {
      api.close();
    }
  });
}
