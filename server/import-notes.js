#!/usr/bin/env node
// Converts Apple Notes HTML export into TipTap JSON and generates:
//   1. A SQL file that replaces a user's notes, then inserts imported notes
//   2. Copies images to server/uploads/
//
// Usage: node import-notes.js <user_id>
//   e.g. node import-notes.js 1

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'node-html-parser';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ICLOUD_DIR = path.join(__dirname, '..', 'iCloud', 'Notes');
const IMAGES_DIR = path.join(ICLOUD_DIR, 'images');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const OUTPUT_SQL = path.join(__dirname, 'import-notes.sql');

const imageMap = new Map();

// Strip bytes that are valid in WIN1252 but not in UTF-8 (0x80-0x9F range)
// and replace them with their proper Unicode equivalents
function sanitizeToUtf8(str) {
  const win1252Map = {
    '\x80': '\u20AC', '\x82': '\u201A', '\x83': '\u0192', '\x84': '\u201E',
    '\x85': '\u2026', '\x86': '\u2020', '\x87': '\u2021', '\x88': '\u02C6',
    '\x89': '\u2030', '\x8A': '\u0160', '\x8B': '\u2039', '\x8C': '\u0152',
    '\x8E': '\u017D', '\x91': '\u2018', '\x92': '\u2019', '\x93': '\u201C',
    '\x94': '\u201D', '\x95': '\u2022', '\x96': '\u2013', '\x97': '\u2014',
    '\x98': '\u02DC', '\x99': '\u2122', '\x9A': '\u0161', '\x9B': '\u203A',
    '\x9C': '\u0153', '\x9E': '\u017E', '\x9F': '\u0178',
  };
  return str.replace(/[\x80-\x9F]/g, ch => win1252Map[ch] || '');
}

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function copyImages() {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  if (!fs.existsSync(IMAGES_DIR)) return;

  const files = fs.readdirSync(IMAGES_DIR);
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    const baseName = path.basename(file, path.extname(file));
    const srcPath = path.join(IMAGES_DIR, file);

    if (ext === '.heic') {
      const destName = `imported-${baseName}.png`;
      const destPath = path.join(UPLOADS_DIR, destName);
      try {
        execSync(`sips -s format png "${srcPath}" --out "${destPath}"`, { stdio: 'pipe' });
        imageMap.set(file, destName);
      } catch {
        console.warn(`  Warning: Failed to convert HEIC: ${file}`);
      }
    } else if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) {
      const destName = `imported-${file}`;
      fs.copyFileSync(srcPath, path.join(UPLOADS_DIR, destName));
      imageMap.set(file, destName);
    }
  }
  console.log(`Copied ${imageMap.size} images to uploads/`);
}

function getImageUrl(src) {
  const filename = path.basename(src);
  const mapped = imageMap.get(filename);
  if (mapped) return `/api/uploads/${mapped}`;
  const heicName = filename.replace(/\.[^.]+$/, '') + '.HEIC';
  const heicMapped = imageMap.get(heicName);
  if (heicMapped) return `/api/uploads/${heicMapped}`;
  return src;
}

function getTextContent(node) {
  if (node.nodeType === 3) return decodeEntities(node.rawText);
  if (node.nodeType !== 1) return '';
  return node.childNodes.map(c => getTextContent(c)).join('');
}

function extractInline(node, marks = []) {
  const result = [];

  if (node.nodeType === 3) {
    let text = decodeEntities(node.rawText);
    if (/^\s*$/.test(text)) return result;
    text = text.replace(/\n/g, ' ');
    const item = { type: 'text', text };
    if (marks.length) item.marks = marks.map(m => ({ type: m }));
    result.push(item);
    return result;
  }

  if (node.nodeType !== 1) return result;
  const tag = (node.tagName || '').toUpperCase();

  if (tag === 'BR') {
    result.push({ type: 'hardBreak' });
    return result;
  }

  if (tag === 'IMG') {
    const src = node.getAttribute('src');
    if (src) result.push({ type: '__image__', src });
    return result;
  }

  const newMarks = [...marks];
  if ((tag === 'B' || tag === 'STRONG') && !newMarks.includes('bold')) newMarks.push('bold');
  if ((tag === 'I' || tag === 'EM') && !newMarks.includes('italic')) newMarks.push('italic');
  if (tag === 'U' && !newMarks.includes('underline')) newMarks.push('underline');
  if ((tag === 'S' || tag === 'STRIKE' || tag === 'DEL') && !newMarks.includes('strike')) newMarks.push('strike');
  if (tag === 'CODE' && !newMarks.includes('code')) newMarks.push('code');

  for (const child of node.childNodes) {
    result.push(...extractInline(child, newMarks));
  }

  return result;
}

function stripTrailingBreaks(content) {
  while (content.length && content[content.length - 1].type === 'hardBreak') content.pop();
  return content;
}

function processListItems(listNode) {
  const items = [];

  function findLi(node) {
    for (const child of node.childNodes) {
      if (child.nodeType !== 1) continue;
      const tag = (child.tagName || '').toUpperCase();
      if (tag === 'LI') {
        const inline = stripTrailingBreaks(extractInline(child).filter(i => i.type !== '__image__'));
        items.push({
          type: 'listItem',
          content: [inline.length ? { type: 'paragraph', content: inline } : { type: 'paragraph' }],
        });
      } else {
        findLi(child);
      }
    }
  }

  findLi(listNode);
  return items;
}

function htmlToTiptapJSON(htmlString) {
  htmlString = htmlString.replace(/<(b|i|u|strong|em|s)>\s*<li>/gi, '<li><$1>');

  const root = parse(htmlString);
  const body = root.querySelector('body');
  if (!body) return { type: 'doc', content: [{ type: 'paragraph' }] };

  const doc = [];
  let currentPara = [];

  function flush() {
    stripTrailingBreaks(currentPara);

    const segments = [];
    let current = [];
    for (const item of currentPara) {
      if (item.type === '__image__') {
        if (current.length) { segments.push({ kind: 'para', items: current }); current = []; }
        segments.push({ kind: 'img', src: item.src });
      } else {
        current.push(item);
      }
    }
    if (current.length) segments.push({ kind: 'para', items: current });

    for (const seg of segments) {
      if (seg.kind === 'img') {
        doc.push({ type: 'image', attrs: { src: getImageUrl(seg.src) } });
      } else {
        doc.push({ type: 'paragraph', content: seg.items });
      }
    }

    if (segments.length === 0) doc.push({ type: 'paragraph' });
    currentPara = [];
  }

  function walk(node) {
    if (node.nodeType === 3) {
      let text = decodeEntities(node.rawText);
      if (/^\s*$/.test(text)) return;
      text = text.replace(/\n/g, ' ');
      currentPara.push({ type: 'text', text });
      return;
    }
    if (node.nodeType !== 1) return;

    const tag = (node.tagName || '').toUpperCase();

    if (tag === 'BR') { flush(); return; }

    if (/^H[1-6]$/.test(tag)) {
      flush();
      const level = parseInt(tag[1]);
      const content = stripTrailingBreaks(extractInline(node).filter(i => i.type !== '__image__'));
      doc.push(content.length
        ? { type: 'heading', attrs: { level }, content }
        : { type: 'heading', attrs: { level } }
      );
      return;
    }

    if (tag === 'UL' || tag === 'OL') {
      flush();
      const items = processListItems(node);
      if (items.length) {
        doc.push({ type: tag === 'UL' ? 'bulletList' : 'orderedList', content: items });
      }
      return;
    }

    if (tag === 'BLOCKQUOTE') {
      flush();
      const content = stripTrailingBreaks(extractInline(node).filter(i => i.type !== '__image__'));
      doc.push({
        type: 'blockquote',
        content: [content.length ? { type: 'paragraph', content } : { type: 'paragraph' }],
      });
      return;
    }

    if (tag === 'HR') { flush(); doc.push({ type: 'horizontalRule' }); return; }

    if (tag === 'PRE') {
      flush();
      const text = getTextContent(node);
      doc.push({ type: 'codeBlock', content: text ? [{ type: 'text', text }] : [] });
      return;
    }

    if (tag === 'IMG') {
      flush();
      const src = node.getAttribute('src');
      if (src) doc.push({ type: 'image', attrs: { src: getImageUrl(src) } });
      return;
    }

    if (tag === 'TABLE') {
      flush();
      const rows = node.querySelectorAll('tr');
      for (const row of rows) {
        const cells = row.querySelectorAll('td, th');
        const text = cells.map(c => getTextContent(c).trim()).filter(Boolean).join(' | ');
        if (text) doc.push({ type: 'paragraph', content: [{ type: 'text', text }] });
      }
      return;
    }

    if (tag === 'VIDEO' || tag === 'AUDIO' || tag === 'OBJECT' || tag === 'EMBED') return;

    if (tag === 'DIV' || tag === 'P') {
      flush();
      for (const child of node.childNodes) walk(child);
      flush();
      return;
    }

    currentPara.push(...extractInline(node));
  }

  for (const child of body.childNodes) walk(child);
  if (currentPara.length) flush();

  while (doc.length > 1 && doc[0].type === 'paragraph' && !doc[0].content) doc.shift();
  while (doc.length > 1 && doc[doc.length - 1].type === 'paragraph' && !doc[doc.length - 1].content) doc.pop();

  if (doc.length === 0) doc.push({ type: 'paragraph' });

  return { type: 'doc', content: doc };
}

function escapeSql(str) {
  return str.replace(/'/g, "''");
}

function parseDateFromFilename(filename) {
  const match = filename.match(/-(\d{1,2})-(\d{1,2})-(\d{4})\.html$/);
  if (!match) return null;

  const day = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const year = parseInt(match[3], 10);

  const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return date;
}

function formatSqlTimestamp(date) {
  const y = String(date.getUTCFullYear());
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

function getNoteTimestamps(filePath, filename) {
  const fromName = parseDateFromFilename(filename);
  if (fromName) {
    const ts = formatSqlTimestamp(fromName);
    return {
      createdAt: ts,
      updatedAt: ts,
      sortDate: fromName,
      source: 'filename',
    };
  }

  const stats = fs.statSync(filePath);
  const createdAtDate = Number.isNaN(stats.birthtime.valueOf()) ? stats.mtime : stats.birthtime;
  const updatedAtDate = Number.isNaN(stats.mtime.valueOf()) ? createdAtDate : stats.mtime;

  return {
    createdAt: formatSqlTimestamp(createdAtDate),
    updatedAt: formatSqlTimestamp(updatedAtDate),
    sortDate: updatedAtDate,
    source: 'filesystem',
  };
}

function main() {
  const userId = parseInt(process.argv[2]);

  if (!userId) {
    console.log('Usage: node import-notes.js <user_id>');
    console.log('  Generates import-notes.sql and copies images to uploads/');
    process.exit(1);
  }

  console.log(`Preparing Apple Notes import for user ${userId}...\n`);

  // Step 1: Copy images
  console.log('Step 1: Copying images...');
  copyImages();

  // Step 2: Convert HTML files and generate SQL
  const htmlFiles = fs.readdirSync(ICLOUD_DIR).filter(f => f.endsWith('.html'));
  const noteFiles = htmlFiles
    .map(file => {
      const filePath = path.join(ICLOUD_DIR, file);
      return {
        file,
        filePath,
        timestamps: getNoteTimestamps(filePath, file),
      };
    })
    .sort((a, b) => a.timestamps.sortDate - b.timestamps.sortDate || a.file.localeCompare(b.file));

  const fromFilename = noteFiles.filter(n => n.timestamps.source === 'filename').length;
  const fromFilesystem = noteFiles.length - fromFilename;

  console.log(`\nStep 2: Converting ${noteFiles.length} notes...`);
  console.log(`  Timestamp source: filename=${fromFilename}, filesystem=${fromFilesystem}`);

  const sqlLines = [
    '-- Apple Notes import',
    `-- Generated for user_id = ${userId}`,
    `-- ${noteFiles.length} notes`,
    '',
    '\\c notes_app;',
    'SET client_encoding TO \'UTF8\';',
    'BEGIN;',
    `DELETE FROM notes WHERE user_id = ${userId};`,
    '',
  ];

  let converted = 0;
  let failed = 0;

  for (const noteFile of noteFiles) {
    const { file, filePath, timestamps } = noteFile;
    try {
      const rawHtml = fs.readFileSync(filePath, 'utf-8');
      const html = sanitizeToUtf8(rawHtml);
      const content = htmlToTiptapJSON(html);
      const jsonStr = escapeSql(JSON.stringify(content));
      sqlLines.push(
        `INSERT INTO notes (user_id, content, created_at, updated_at) VALUES (${userId}, '${jsonStr}', '${timestamps.createdAt}', '${timestamps.updatedAt}');`
      );
      converted++;
      if (converted % 200 === 0) console.log(`  ${converted}/${noteFiles.length}...`);
    } catch (err) {
      console.error(`  Failed: ${file} - ${err.message}`);
      failed++;
    }
  }

  sqlLines.push('COMMIT;', '');

  fs.writeFileSync(OUTPUT_SQL, sqlLines.join('\n') + '\n');

  console.log(`\nDone!`);
  console.log(`  Converted: ${converted} notes`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Images: ${imageMap.size} copied to server/uploads/`);
  console.log(`  SQL: ${path.relative(process.cwd(), OUTPUT_SQL)}`);
  console.log(`\nTo import into PostgreSQL, run:`);
  console.log(`  psql -U postgres -f import-notes.sql`);
}

main();
