"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), vm = require("node:vm"), path = require("node:path");
const { parseSource, readingRanges, validateParagraph, maskSentence, grammarSentence, orderBlocks } = require("../workbook_core");

test("all source sentences remain in order and numbers are removed", () => {
  const source = parseSource("Test", "# Introduction\n1. Dr. Lee studied the painting.\n2. She saved it.\n\n# Rescue\n3. The team came later.");
  assert.deepEqual(source.paragraphs.map(p => p.sentences.map(s => s.en)), [
    ["Dr. Lee studied the painting.", "She saved it."], ["The team came later."],
  ]);
  assert.deepEqual(source.paragraphs.map(p => p.heading), ["Introduction", "Rescue"]);
});

test("reading pages have two or three sentences except a one-sentence paragraph", () => {
  for (let count = 1; count <= 90; count++) {
    const ranges = readingRanges(count);
    assert.deepEqual(ranges.flatMap(([a, b]) => Array.from({ length: b - a }, (_, j) => a + j)),
      Array.from({ length: count }, (_, j) => j));
    for (const [a, b] of ranges) assert.ok([2, 3].includes(b - a) || count === 1);
  }
});

test("sample draft covers every sentence with valid blanks and grammar", () => {
  const draft = require("./fixture.json");
  const par = draft.paragraphs[0];
  validateParagraph(par, par, 1);
  for (const row of par.sentences) {
    assert.equal((maskSentence(row).match(/________/g) || []).length, row.blanks.length);
    assert.ok(grammarSentence(row).includes(`(${row.grammar_correct} / ${row.grammar_wrong})`));
  }
  assert.equal(orderBlocks(draft.paragraphs).flatMap(x => x.sentences).length, par.sentences.length);
});

test("web job returns a complete draft before the parallel reading images finish", async () => {
  const originalFetch = global.fetch, originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "mock-key";
  const fixture = require("./fixture.json").paragraphs[0];
  const generated = {
    topic: fixture.topic, paragraph_title: fixture.paragraph_title,
    reading_captions: fixture.reading_captions,
    questions: fixture.questions, ox: fixture.ox,
    sentences: fixture.sentences.map(row => ({
      translation: row.ko, blanks: row.blanks,
      grammar_correct: row.grammar_correct, grammar_wrong: row.grammar_wrong,
      grammar_reason: row.grammar_reason, connection: row.connection,
    })),
  };
  const pngBytes = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(pngBytes);
  pngBytes.writeUInt32BE(2016, 16);
  pngBytes.writeUInt32BE(672, 20);
  const png = pngBytes.toString("base64");
  let imagesStarted = 0;
  global.fetch = async (url, options) => {
    if (url.endsWith("/responses")) return { ok: true, json: async () => ({ status: "completed", output: [{ content: [{ type: "output_text", text: JSON.stringify(generated) }] }] }) };
    assert.ok(url.endsWith("/images/edits"));
    const body = JSON.parse(options.body);
    assert.equal(body.size, "2016x672");
    assert.equal(body.images.length, 2);
    assert.ok(body.images.every(x => x.image_url.startsWith("data:image/jpeg;base64,")));
    assert.match(body.prompt, /THREE equal square cartoon panels/);
    assert.match(body.prompt, /same two signature mascot/);
    imagesStarted++;
    await new Promise(resolve => setTimeout(resolve, 70));
    return { ok: true, json: async () => ({ data: [{ b64_json: png }] }) };
  };
  const routes = { post: {}, get: {} };
  const app = { post(path, fn) { routes.post[path] = fn; }, get(path, fn) { routes.get[path] = fn; } };
  const response = () => ({ status(code) { this.code = code; return this; }, json(value) { this.value = value; return this; } });
  try {
    require("../workbook_routes")(app);
    const started = response();
    routes.post["/api/workbook/jobs"]({ body: { title: "Sample", english: fixture.sentences.map(x => x.en).join(" ") } }, started);
    assert.ok(started.value.id);
    const status = response(), id = started.value.id;
    for (let i = 0; i < 80; i++) {
      routes.get["/api/workbook/jobs/:id"]({ params: { id } }, status);
      if (status.value.draft && status.value.phase === "images") break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(status.value.draft.paragraphs[0].sentences.length, fixture.sentences.length);
    assert.deepEqual(status.value.draft.paragraphs[0].reading_captions, fixture.reading_captions);
    assert.equal(status.value.imagesTotal, 2);
    assert.equal(status.value.phase, "images");
    for (let i = 0; i < 80 && status.value.phase !== "complete"; i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
      routes.get["/api/workbook/jobs/:id"]({ params: { id } }, status);
    }
    assert.equal(status.value.phase, "complete");
    assert.equal(status.value.imagesDone, 2);
    assert.equal(imagesStarted, 2);
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
});

test("printed student pages cover all steps; image slots exist only in READING", () => {
  const draft = require("./fixture.json");
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../public/workbook.js"), "utf8"), context);
  context.draft = draft;
  const html = vm.runInContext("workbookDraft = draft; wbStudent(draft)", context);
  assert.equal((html.match(/class="wbReadingRow"/g) || []).length, draft.paragraphs[0].sentences.length);
  assert.equal((html.match(/class="wbIllustration hidden"/g) || []).length, 2);
  assert.equal((html.match(/class="wbTopicField"/g) || []).length, 2);
  assert.ok(html.includes("READING · Paragraph 1 (2/2)"));
  assert.ok(html.includes("주제 (Topic)"));
  assert.ok(html.includes("제목 (Title)"));
  assert.ok(html.includes("1-04"));
  assert.ok(html.includes(draft.paragraphs[0].reading_captions[0]));
  assert.equal((html.match(/class="wbSection">STEP/g) || []).length > 0, true);
  for (const name of ["STEP 1", "STEP 2", "STEP 3", "STEP 4", "STEP 5"]) assert.ok(html.includes(name));
  const reading = html.slice(0, html.indexOf("STEP 1"));
  assert.equal((reading.match(/class="wbIllustration hidden"/g) || []).length, 2);
  assert.equal((html.slice(html.indexOf("STEP 1")).match(/class="wbIllustration hidden"/g) || []).length, 0);
  const teacher = vm.runInContext("wbTeacher(draft)", context);
  assert.ok(teacher.includes("문장 연결"));
  assert.ok(teacher.includes("STEP 5"));
});

test("each paragraph ends with its own full-width topic and title lines", () => {
  const first = require("./fixture.json").paragraphs[0];
  const second = JSON.parse(JSON.stringify(first));
  second.sentences = second.sentences.slice(0, 3);
  second.reading_captions = ["두 번째 문단의 그림 설명이다."];
  const draft = { title: "Two paragraphs", paragraphs: [first, second] };
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../public/workbook.js"), "utf8"), context);
  context.draft = draft;
  const html = vm.runInContext("workbookDraft = draft; wbStudent(draft)", context);
  const reading = html.slice(0, html.indexOf("STEP 1"));
  assert.equal((reading.match(/class="wbReadingTopics"/g) || []).length, 2);
  assert.equal((reading.match(/class="wbTopicField"/g) || []).length, 4);
  assert.equal((reading.match(/class="wbImageBox"/g) || []).length, 3);
  assert.equal((reading.match(/class="wbReadingRow"/g) || []).length, 7);
  const css = fs.readFileSync(path.join(__dirname, "../public/style.css"), "utf8");
  assert.match(css, /\.wbReadingPage \.wbImageBox\{[^}]*aspect-ratio:3\/1/);
  assert.match(css, /\.wbReadingPage \.wbReadingTopics\{display:block/);
});
