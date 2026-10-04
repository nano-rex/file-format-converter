// Turns positioned PDF text runs into reading-order lines, then into
// headings, paragraphs, and tables.

import { isCjk } from "./util.js";

const bulletPattern = /^(?:[•◦▪■●○‣·–—*-]|\(?\d{1,3}[.)]|\(?[a-zA-Z][.)])\s/;

export function layoutPdf(parsed, title) {
  const pages = parsed.pages.map(page => ({ width: page.width, height: page.height, lines: buildLines(page) }));
  const bodySize = dominantSize(pages);

  let characters = 0;
  const outPages = pages.map(page => {
    const lines = orderColumns(page.lines);
    const items = [];
    for (const line of page.lines) {
      for (const cell of line.cells) {
        characters += cell.text.length;
        items.push({ x: cell.x0, y: line.y, width: cell.x1 - cell.x0, size: cell.size, text: cell.text, bold: cell.bold });
      }
    }
    return { width: page.width, height: page.height, blocks: buildBlocks(lines, bodySize), items };
  });

  if (!characters) {
    throw new Error(parsed.unmappedGlyphs > 0
      ? "This PDF's fonts carry no Unicode mapping, so its text cannot be extracted without OCR."
      : "This PDF contains no text layer (it is probably a scan). OCR is not supported.");
  }
  return { title, source: "pdf", pages: outPages };
}

function buildLines(page) {
  const horizontal = [];
  const rotated = [];
  for (const run of page.runs) {
    const text = run.text.trim();
    if (!text) continue;
    const item = { text, x0: run.sx, x1: Math.max(run.ex, run.sx), y: run.sy, size: run.size, bold: run.bold };
    if (Math.abs(run.uy) < 0.1 && run.ux > 0) horizontal.push(item);
    else rotated.push(item);
  }
  horizontal.sort((a, b) => a.y - b.y || a.x0 - b.x0);

  const groups = [];
  for (const run of horizontal) {
    let best = null;
    let bestDistance = Infinity;
    for (let index = groups.length - 1; index >= 0 && index >= groups.length - 6; index -= 1) {
      const group = groups[index];
      const distance = Math.abs(group.y - run.y);
      if (distance <= 0.4 * Math.max(group.size, run.size) && distance < bestDistance) {
        best = group;
        bestDistance = distance;
      }
    }
    if (best) {
      best.runs.push(run);
      if (run.size > best.size) {
        best.size = run.size;
        best.y = run.y;
      }
    } else {
      groups.push({ y: run.y, size: run.size, runs: [run] });
    }
  }
  groups.sort((a, b) => a.y - b.y);

  // Split each line into segments at wide gaps. Gaps above 1.2 em always
  // separate table cells; narrower ones only count when a neighbouring line
  // has whitespace at the same place, which prose word spacing does not.
  for (const group of groups) {
    group.runs.sort((a, b) => a.x0 - b.x0);
    const segments = [];
    let segment = null;
    let previous = null;
    for (const run of group.runs) {
      if (previous && run.text === previous.text && Math.abs(run.x0 - previous.x0) < 0.5 * run.size) continue;
      const gap = segment ? run.x0 - segment.x1 : 0;
      const size = segment ? Math.max(segment.size, run.size) : run.size;
      if (segment && gap <= 0.55 * size) {
        const tight = gap <= 0.17 * Math.min(segment.size, run.size);
        segment.text += (tight || segment.text.endsWith(" ") ? "" : " ") + run.text;
        segment.x1 = Math.max(segment.x1, run.x1);
        segment.size = size;
        segment.bold = segment.bold && run.bold;
      } else {
        segment = { text: run.text, x0: run.x0, x1: run.x1, size: run.size, bold: run.bold, soft: Boolean(segment) && gap <= 1.2 * size };
        segments.push(segment);
      }
      previous = run;
    }
    group.segments = segments;
  }

  const clearAt = (group, start, end, tolerance) => {
    let left = false;
    let right = false;
    for (const segment of group.segments) {
      if (segment.x1 <= start + tolerance) left = true;
      else if (segment.x0 >= end - tolerance) right = true;
      else return false;
    }
    return left && right;
  };

  const lines = [];
  groups.forEach((group, index) => {
    const cells = [];
    for (const segment of group.segments) {
      const last = cells[cells.length - 1];
      let boundary = true;
      if (last && segment.soft) {
        const reach = 2.5 * group.size;
        boundary = [groups[index - 1], groups[index + 1]].some(other => (
          other && Math.abs(other.y - group.y) < reach && clearAt(other, last.x1, segment.x0, 0.15 * group.size)
        ));
      }
      if (last && !boundary) {
        last.text += ` ${segment.text}`;
        last.x1 = Math.max(last.x1, segment.x1);
        last.size = Math.max(last.size, segment.size);
        last.bold = last.bold && segment.bold;
      } else {
        cells.push({ text: segment.text, x0: segment.x0, x1: segment.x1, size: segment.size, bold: segment.bold });
      }
    }
    if (cells.length) lines.push(makeLine(cells, group.y));
  });
  for (const run of rotated) {
    const line = makeLine([{ text: run.text, x0: run.x0, x1: run.x1, size: run.size, bold: run.bold }], run.y);
    line.rotated = true;
    lines.push(line);
  }
  return lines;
}

function makeLine(cells, y) {
  return {
    y,
    cells,
    x0: cells[0].x0,
    x1: cells[cells.length - 1].x1,
    size: Math.max(...cells.map(cell => cell.size)),
    bold: cells.every(cell => cell.bold),
    text: cells.map(cell => cell.text).join("\t")
  };
}

function dominantSize(pages) {
  const weights = new Map();
  for (const page of pages) {
    for (const line of page.lines) {
      for (const cell of line.cells) {
        const key = Math.round(cell.size * 2) / 2;
        weights.set(key, (weights.get(key) || 0) + cell.text.length);
      }
    }
  }
  let best = 11;
  let bestWeight = -1;
  for (const [size, weight] of weights) {
    if (weight > bestWeight) {
      best = size;
      bestWeight = weight;
    }
  }
  return best;
}

// Detects two-column prose and reads the left column before the right one.
// Each line also gets the right edge of its column, used to spot short lines.
function orderColumns(lines) {
  const normal = lines.filter(line => !line.rotated);
  const pairs = normal.filter(line => line.cells.length === 2);
  let gutter = null;
  if (pairs.length >= 8 && pairs.length >= 0.5 * normal.length) {
    const middles = pairs.map(line => (line.cells[0].x1 + line.cells[1].x0) / 2).sort((a, b) => a - b);
    const middle = middles[Math.floor(middles.length / 2)];
    const matching = pairs.filter(line => line.cells[0].x1 < middle && line.cells[1].x0 > middle);
    const average = matching.reduce((total, line) => total + line.text.length, 0) / Math.max(1, matching.length * 2);
    if (matching.length >= 8 && matching.length >= 0.5 * normal.length && average >= 25) gutter = middle;
  }

  if (gutter === null) {
    const edge = Math.max(0, ...normal.filter(line => line.cells.length === 1).map(line => line.x1));
    const left = Math.min(Infinity, ...normal.map(line => line.x0));
    for (const line of lines) setEdge(line, edge, left);
    return lines;
  }

  const out = [];
  let left = [];
  let right = [];
  const flush = () => {
    out.push(...left, ...right);
    left = [];
    right = [];
  };
  const half = (cell, y) => makeLine([cell], y);
  for (const line of normal) {
    if (line.cells.length === 2 && line.cells[0].x1 < gutter && line.cells[1].x0 > gutter) {
      left.push(half(line.cells[0], line.y));
      right.push(half(line.cells[1], line.y));
    } else if (line.cells.length === 1 && line.x1 < gutter) {
      left.push(line);
    } else if (line.cells.length === 1 && line.x0 > gutter) {
      right.push(line);
    } else {
      flush();
      out.push(line);
    }
  }
  flush();

  const leftEdge = Math.max(0, ...out.filter(line => line.cells.length === 1 && line.x1 < gutter).map(line => line.x1));
  const rightEdge = Math.max(0, ...out.filter(line => line.cells.length === 1 && line.x0 > gutter).map(line => line.x1));
  const leftStart = Math.min(Infinity, ...out.map(line => line.x0));
  for (const line of out) {
    if (line.x1 < gutter) setEdge(line, leftEdge, leftStart);
    else if (line.x0 > gutter) setEdge(line, rightEdge, gutter);
    else setEdge(line, rightEdge, leftStart);
  }
  const rotatedLines = lines.filter(line => line.rotated);
  for (const line of rotatedLines) setEdge(line, line.x1, line.x0);
  return [...out, ...rotatedLines];
}

function setEdge(line, edge, start) {
  const span = Math.max(0, edge - start);
  line.short = line.x1 < edge - Math.max(3 * line.size, 0.1 * span);
}

function buildBlocks(lines, bodySize) {
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];

    if (line.cells.length >= 2) {
      let end = index + 1;
      while (end < lines.length) {
        const next = lines[end];
        const before = lines[end - 1];
        if (next.rotated) break;
        if (next.cells.length >= 2) {
          end += 1;
          continue;
        }
        const after = lines[end + 1];
        const pitch = next.y - before.y;
        if (after && after.cells.length >= 2 && pitch > 0 && pitch < 2.2 * Math.max(next.size, before.size) && after.y > next.y) {
          end += 1;
          continue;
        }
        break;
      }
      const group = lines.slice(index, end);
      const table = group.filter(item => item.cells.length >= 2).length >= 2 ? tableFrom(group) : null;
      if (table) {
        blocks.push(table);
      } else {
        for (const item of group) blocks.push(paragraphFrom([item], bodySize));
      }
      index = end;
      continue;
    }

    const group = [line];
    let end = index + 1;
    while (end < lines.length && lines[end].cells.length === 1 && continues(group, lines[end])) {
      group.push(lines[end]);
      end += 1;
    }
    blocks.push(paragraphFrom(group, bodySize));
    index = end;
  }
  return blocks;
}

function continues(group, line) {
  const previous = group[group.length - 1];
  if (previous.rotated || line.rotated) return false;
  const pitch = line.y - previous.y;
  if (pitch <= 0 || pitch > 1.7 * Math.max(previous.size, line.size)) return false;
  if (Math.abs(line.size - previous.size) > 0.08 * previous.size) return false;
  if (line.bold !== previous.bold) return false;
  if (previous.short) return false;
  if (bulletPattern.test(line.text)) return false;
  const indent = line.x0 - previous.x0;
  if (indent > 0.8 * line.size && !(group.length === 1 && bulletPattern.test(previous.text))) return false;
  if (indent < -0.8 * line.size && group.length > 1) return false;
  return true;
}

function paragraphFrom(group, bodySize) {
  const lines = group.map(line => line.text);
  let text = "";
  for (const line of lines) {
    if (!text) {
      text = line;
    } else if (text.endsWith("­")) {
      text = text.slice(0, -1) + line;
    } else if (text.endsWith("-") && /[a-z]/.test(line[0] || "")) {
      text += line;
    } else if (isCjk(text[text.length - 1]) && isCjk(line[0] || " ")) {
      text += line;
    } else {
      text += ` ${line}`;
    }
  }
  const size = Math.max(...group.map(line => line.size));
  const bold = group.every(line => line.bold);
  const block = { type: "paragraph", text, lines, bold, size };
  if (group.length === 1 && group[0].cells.length >= 2) block.cells = group[0].cells.map(cell => cell.text);

  const ratio = size / bodySize;
  if (ratio >= 1.15 && text.length <= 200 && group.length <= 3 && !block.cells) {
    block.type = "heading";
    block.level = ratio >= 1.7 ? 1 : ratio >= 1.35 ? 2 : 3;
  }
  return block;
}

function tableFrom(group) {
  const intervals = [];
  let size = 0;
  for (const line of group) {
    if (line.cells.length < 2) continue;
    size = Math.max(size, line.size);
    for (const cell of line.cells) intervals.push([cell.x0, cell.x1]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  const columns = [];
  for (const [start, end] of intervals) {
    const last = columns[columns.length - 1];
    if (last && start <= last[1] + 0.2 * size) last[1] = Math.max(last[1], end);
    else columns.push([start, end]);
  }
  if (columns.length < 2) return null;

  const rows = group.map(line => {
    const row = new Array(columns.length).fill("");
    for (const cell of line.cells) {
      const center = line.cells.length >= 2 ? (cell.x0 + cell.x1) / 2 : cell.x0;
      let target = 0;
      let distance = Infinity;
      columns.forEach(([start, end], column) => {
        const gap = center < start ? start - center : center > end ? center - end : 0;
        if (gap < distance) {
          distance = gap;
          target = column;
        }
      });
      row[target] = row[target] ? `${row[target]} ${cell.text}` : cell.text;
    }
    return row;
  });
  return { type: "table", rows, bold: group[0].bold };
}
