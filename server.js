"use strict";
const express = require("express");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const path = require("path");

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/status", (req, res) => res.json({ ai: Boolean(process.env.OPENAI_API_KEY) }));

app.post("/api/extract/file", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "파일을 선택해 주세요." });
    const filename = String(req.file.originalname || "").toLowerCase();
    const mime = String(req.file.mimetype || "").toLowerCase();
    let text;
    if (filename.endsWith(".pdf") || mime === "application/pdf") {
      text = (await pdfParse(req.file.buffer)).text;
    } else if (filename.endsWith(".docx") || mime.includes("wordprocessingml")) {
      text = (await mammoth.extractRawText({ buffer: req.file.buffer })).value;
    } else if (/\.(txt|md)$/.test(filename) || mime.startsWith("text/")) {
      text = req.file.buffer.toString("utf8");
    } else {
      return res.status(400).json({ error: "PDF, DOCX, TXT, MD 파일을 사용해 주세요." });
    }
    if (!text?.trim()) return res.status(400).json({ error: "텍스트를 추출하지 못했습니다. 스캔 PDF라면 복사 가능한 원문을 사용해 주세요." });
    res.json({ text });
  } catch (error) { res.status(500).json({ error: `파일 읽기 실패: ${error.message}` }); }
});

require("./workbook_routes")(app);
app.use((error, req, res, next) => {
  if (error) return res.status(400).json({ error: error.message || "요청을 처리하지 못했습니다." });
  next();
});

app.listen(process.env.PORT || 3000, () => console.log("종로M 워크북 제작기 실행 중"));
