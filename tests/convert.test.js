import { expect, test } from "bun:test";
import { convert } from "../src/convert.js";

const text = "Quarterly report\nRevenue grew 12% (net) \\ before tax.\n中文段落：歌曲数据库测试。\nLast line with café and “quotes”.";
const csv = "name,qty,note\nwidget,3,\"has, comma\"\ngadget,1250,\"two\nlines\"\n";

function run(input, name, source, target) {
  const outputs = convert(Buffer.isBuffer(input) ? input : Buffer.from(input), name, source, target);
  expect(outputs.length).toBeGreaterThan(0);
  return outputs[0].data;
}

test("txt -> pdf -> txt keeps the text, including CJK", () => {
  const pdf = run(text, "report.txt", "txt", "pdf");
  expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  const back = run(pdf, "report.pdf", "pdf", "txt").toString();
  expect(back).toContain("Revenue grew 12% (net) \\ before tax.");
  expect(back).toContain("中文段落：歌曲数据库测试。");
  expect(back).toContain("café and “quotes”.");
});

test("txt -> docx -> txt round trip", () => {
  const docx = run(text, "report.txt", "txt", "docx");
  expect(run(docx, "report.docx", "docx", "txt").toString().split("\n").filter(Boolean)).toEqual(text.split("\n"));
});

test("txt -> pptx -> txt keeps every line", () => {
  const pptx = run(text, "report.txt", "txt", "pptx");
  const back = run(pptx, "report.pptx", "pptx", "txt").toString();
  for (const line of text.split("\n")) expect(back).toContain(line);
});

test("csv -> xlsx -> csv/json round trip", () => {
  const xlsx = run(csv, "items.csv", "csv", "xlsx");
  expect(run(xlsx, "items.xlsx", "xlsx", "csv").toString().replace(/^﻿/, "").replaceAll("\r\n", "\n")).toBe(csv);
  const rows = JSON.parse(run(xlsx, "items.xlsx", "xlsx", "json").toString());
  expect(rows).toEqual([{ name: "widget", qty: "3", note: "has, comma" }, { name: "gadget", qty: "1250", note: "two\nlines" }]);
});

test("pdf tables survive into xlsx, docx, and pptx", () => {
  const pdf = run(csv, "items.csv", "csv", "pdf");
  const sheet = run(run(pdf, "items.pdf", "pdf", "xlsx"), "items.xlsx", "xlsx", "csv").toString();
  expect(sheet).toContain("widget,3,");
  expect(sheet).toContain("gadget,1250,");
  expect(run(run(pdf, "items.pdf", "pdf", "docx"), "items.docx", "docx", "txt").toString()).toContain("widget\t3\t");
  expect(run(run(pdf, "items.pdf", "pdf", "pptx"), "items.pptx", "pptx", "txt").toString()).toContain("gadget");
});

test("the file content decides the input format, not the extension", () => {
  const docx = run(text, "report.txt", "txt", "docx");
  expect(run(docx, "mislabelled.pdf", "pdf", "txt").toString().split("\n").filter(Boolean)).toEqual(text.split("\n"));
});

test("unsupported input gives a clear error", () => {
  expect(() => convert(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0]), "old.doc", "doc", "pdf")).toThrow(/Save the file as \.docx/);
  expect(() => convert(Buffer.from("%PDF-1.4\n%%EOF"), "empty.pdf", "pdf", "txt")).toThrow();
  expect(() => convert(Buffer.from("x"), "a.txt", "txt", "xlsx")).toThrow(/not supported/);
});
