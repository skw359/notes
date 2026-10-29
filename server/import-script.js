import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import process from 'process';
import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config();

const { Pool } = pg;

const DB_CONFIG = {
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'notes_app',
  password: process.env.DB_PASSWORD,
  port: parseInt(process.env.DB_PORT || '5432', 10),
};

const ADVISORY_LOCK_KEY_NAMESPACE = 987654;
const ALLOWED_IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.heic',
  '.heif',
  '.bmp',
  '.tif',
  '.tiff',
]);
const SOURCE_NOTES_DIRNAME = 'Notes';
const SOURCE_IMAGES_DIRNAME = 'images';
const SOURCE_ATTACHMENTS_DIRNAME = 'attachments';

function parseArgs(argv) {
  const args = {
    execute: false,
    verbose: false,
    failOnMissingMedia: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--user-id') {
      args.userId = parseInt(argv[i + 1], 10);
      i += 1;
      continue;
    }
    if (arg === '--source') {
      args.source = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--execute') {
      args.execute = true;
      continue;
    }
    if (arg === '--confirm-replace') {
      args.confirmReplace = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--backup-file') {
      args.backupFile = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--verbose') {
      args.verbose = true;
      continue;
    }
    if (arg === '--fail-on-missing-media') {
      args.failOnMissingMedia = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isInteger(args.userId) || args.userId <= 0) {
    throw new Error('Missing or invalid --user-id <positive integer>');
  }

  if (args.execute) {
    const expectedConfirmation = `REPLACE_USER_${args.userId}`;
    if (args.confirmReplace !== expectedConfirmation) {
      throw new Error(
        `Missing or invalid --confirm-replace. Expected: "${expectedConfirmation}"`
      );
    }
  }

  return args;
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function parseFrontmatter(rawContent) {
  if (!rawContent.startsWith('---\n')) {
    return { frontmatter: {}, body: rawContent };
  }

  const endIndex = rawContent.indexOf('\n---', 4);
  if (endIndex === -1) {
    return { frontmatter: {}, body: rawContent };
  }

  const frontmatterRaw = rawContent.slice(4, endIndex).trim();
  const body = rawContent.slice(endIndex + 4).replace(/^\n/, '');
  const frontmatter = {};

  for (const line of frontmatterRaw.split('\n')) {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (key) {
      frontmatter[key] = value;
    }
  }

  return { frontmatter, body };
}

function parseDateValue(input, fallbackDate) {
  if (typeof input === 'string' && input.trim()) {
    const parsed = new Date(input.trim());
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return fallbackDate;
}

function normalizeWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function sanitizeFilename(basename) {
  return basename.replace(/[^a-zA-Z0-9._-]/g, '-');
}

function cleanMarkdownTarget(rawTarget) {
  if (!rawTarget) return '';

  let target = rawTarget.trim();
  if (target.startsWith('<') && target.endsWith('>')) {
    target = target.slice(1, -1).trim();
  }

  const titleSuffixMatch = target.match(/^(.+?)\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*$/);
  if (titleSuffixMatch) {
    target = titleSuffixMatch[1].trim();
  }

  if (
    (target.startsWith('"') && target.endsWith('"')) ||
    (target.startsWith('\'') && target.endsWith('\''))
  ) {
    target = target.slice(1, -1);
  }

  return target.trim();
}

function isRemoteTarget(target) {
  return /^(?:https?:|mailto:|tel:|data:)/i.test(target);
}

function isUnsafeHref(href) {
  return /^(?:javascript|vbscript):/i.test(href.trim());
}

function isLocalMediaLike(target) {
  if (!target) return false;
  const normalized = target.replace(/\\/g, '/');
  return (
    normalized.startsWith(`${SOURCE_IMAGES_DIRNAME}/`) ||
    normalized.startsWith(`${SOURCE_ATTACHMENTS_DIRNAME}/`)
  );
}

async function collectMarkdownFiles(notesDir) {
  const entries = await fs.readdir(notesDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map((entry) => path.join(notesDir, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

function createTextNode(text, marks = []) {
  const node = { type: 'text', text };
  if (marks.length > 0) {
    node.marks = marks;
  }
  return node;
}

function appendTextNode(nodes, text, marks = []) {
  if (!text) return;
  const previous = nodes[nodes.length - 1];
  const sameMarks =
    previous &&
    previous.type === 'text' &&
    JSON.stringify(previous.marks || []) === JSON.stringify(marks);

  if (sameMarks) {
    previous.text += text;
  } else {
    nodes.push(createTextNode(text, marks));
  }
}

function addMarkToNodes(nodes, mark) {
  return nodes.map((node) => {
    if (!node || node.type !== 'text') {
      return node;
    }
    const marks = [...(node.marks || [])];
    if (!marks.some((existing) => JSON.stringify(existing) === JSON.stringify(mark))) {
      marks.push(mark);
    }
    return { ...node, marks };
  });
}

function resolveMappedTarget(rawTarget, referenceMap) {
  const cleaned = cleanMarkdownTarget(rawTarget);
  if (!cleaned) return '';

  const mapped =
    referenceMap.get(rawTarget) ||
    referenceMap.get(cleaned) ||
    referenceMap.get(decodeURIComponentSafe(cleaned));
  return mapped || cleaned;
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseInlineMarkdown(text, referenceMap, activeMarks = [], depth = 0) {
  if (!text) return [];
  if (depth > 25) {
    return [createTextNode(text, activeMarks)];
  }

  const nodes = [];
  let index = 0;

  while (index < text.length) {
    const specialIndexes = ['[', '`', '*', '_', '~']
      .map((char) => text.indexOf(char, index))
      .filter((position) => position !== -1);

    if (specialIndexes.length === 0) {
      appendTextNode(nodes, text.slice(index), activeMarks);
      break;
    }

    const nextSpecial = Math.min(...specialIndexes);
    if (nextSpecial > index) {
      appendTextNode(nodes, text.slice(index, nextSpecial), activeMarks);
      index = nextSpecial;
    }

    const char = text[index];

    if (char === '[') {
      const closeBracket = text.indexOf(']', index + 1);
      if (closeBracket !== -1 && text[closeBracket + 1] === '(') {
        const closeParen = text.indexOf(')', closeBracket + 2);
        if (closeParen !== -1) {
          const label = text.slice(index + 1, closeBracket);
          const rawTarget = text.slice(closeBracket + 2, closeParen);
          const href = resolveMappedTarget(rawTarget, referenceMap);

          if (!isUnsafeHref(href)) {
            const markedLabel = addMarkToNodes(
              parseInlineMarkdown(label, referenceMap, activeMarks, depth + 1),
              { type: 'link', attrs: { href } }
            );
            nodes.push(...markedLabel);
          } else {
            appendTextNode(nodes, label, activeMarks);
          }

          index = closeParen + 1;
          continue;
        }
      }
    }

    if (char === '`') {
      const close = text.indexOf('`', index + 1);
      if (close !== -1) {
        const inner = text.slice(index + 1, close);
        appendTextNode(nodes, inner, [...activeMarks, { type: 'code' }]);
        index = close + 1;
        continue;
      }
    }

    if (char === '*' && text[index + 1] === '*') {
      const close = text.indexOf('**', index + 2);
      if (close !== -1) {
        const inner = text.slice(index + 2, close);
        const innerNodes = addMarkToNodes(
          parseInlineMarkdown(inner, referenceMap, activeMarks, depth + 1),
          { type: 'bold' }
        );
        nodes.push(...innerNodes);
        index = close + 2;
        continue;
      }
    }

    if (char === '*' && text[index + 1] !== '*') {
      const close = text.indexOf('*', index + 1);
      if (close !== -1 && text[close + 1] !== '*') {
        const inner = text.slice(index + 1, close);
        const innerNodes = addMarkToNodes(
          parseInlineMarkdown(inner, referenceMap, activeMarks, depth + 1),
          { type: 'italic' }
        );
        nodes.push(...innerNodes);
        index = close + 1;
        continue;
      }
    }

    if (char === '_') {
      const close = text.indexOf('_', index + 1);
      if (close !== -1) {
        const inner = text.slice(index + 1, close);
        const innerNodes = addMarkToNodes(
          parseInlineMarkdown(inner, referenceMap, activeMarks, depth + 1),
          { type: 'italic' }
        );
        nodes.push(...innerNodes);
        index = close + 1;
        continue;
      }
    }

    if (char === '~' && text[index + 1] === '~') {
      const close = text.indexOf('~~', index + 2);
      if (close !== -1) {
        const inner = text.slice(index + 2, close);
        const innerNodes = addMarkToNodes(
          parseInlineMarkdown(inner, referenceMap, activeMarks, depth + 1),
          { type: 'strike' }
        );
        nodes.push(...innerNodes);
        index = close + 2;
        continue;
      }
    }

    appendTextNode(nodes, text[index], activeMarks);
    index += 1;
  }

  return nodes.filter((node) => node.type !== 'text' || node.text.length > 0);
}

function parseInlineWithHardBreaks(text, referenceMap) {
  const lines = text.split('\n');
  const nodes = [];

  lines.forEach((line, idx) => {
    nodes.push(...parseInlineMarkdown(line, referenceMap));
    if (idx < lines.length - 1) {
      nodes.push({ type: 'hardBreak' });
    }
  });

  return nodes;
}

function listItemFromText(text, referenceMap) {
  const content = parseInlineWithHardBreaks(text.trim(), referenceMap);
  if (content.length === 0) {
    return {
      type: 'listItem',
      content: [{ type: 'paragraph' }],
    };
  }
  return {
    type: 'listItem',
    content: [
      {
        type: 'paragraph',
        content,
      },
    ],
  };
}

function parseMarkdownToTiptap(markdownBody, referenceMap) {
  const lines = markdownBody.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;

  const isCodeFence = (line) => /^\s*```/.test(line);
  const isHeading = (line) => /^\s{0,3}#{1,6}\s+/.test(line);
  const isBulletItem = (line) => /^\s*[-*+]\s+/.test(line);
  const isOrderedItem = (line) => /^\s*\d+\.\s+/.test(line);
  const isBlockquote = (line) => /^\s*>\s?/.test(line);
  const isStandaloneImage = (line) => /^\s*!\[[^\]]*]\([^)]+\)\s*$/.test(line);
  const isSpecialStart = (line) =>
    isCodeFence(line) ||
    isHeading(line) ||
    isBulletItem(line) ||
    isOrderedItem(line) ||
    isBlockquote(line) ||
    isStandaloneImage(line);

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    if (isCodeFence(line)) {
      const codeLines = [];
      i += 1;
      while (i < lines.length && !isCodeFence(lines[i])) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length && isCodeFence(lines[i])) {
        i += 1;
      }
      blocks.push({
        type: 'codeBlock',
        content: [createTextNode(codeLines.join('\n'))],
      });
      continue;
    }

    if (isStandaloneImage(line)) {
      const match = line.trim().match(/^!\[[^\]]*]\(([^)]+)\)$/);
      const rawTarget = match ? match[1] : '';
      const resolvedTarget = resolveMappedTarget(rawTarget, referenceMap);
      const extension = path.extname(resolvedTarget.split('?')[0].toLowerCase());

      if (resolvedTarget && (ALLOWED_IMAGE_EXTENSIONS.has(extension) || resolvedTarget.startsWith('/api/uploads/'))) {
        blocks.push({
          type: 'image',
          attrs: {
            src: resolvedTarget,
          },
        });
      } else {
        const fallbackContent = parseInlineWithHardBreaks(line.trim(), referenceMap);
        blocks.push({
          type: 'paragraph',
          ...(fallbackContent.length > 0 ? { content: fallbackContent } : {}),
        });
      }
      i += 1;
      continue;
    }

    if (isHeading(line)) {
      const match = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
      const level = match[1].length;
      const headingText = match[2].trim();
      const headingContent = parseInlineWithHardBreaks(headingText, referenceMap);
      blocks.push({
        type: 'heading',
        attrs: { level },
        ...(headingContent.length > 0 ? { content: headingContent } : {}),
      });
      i += 1;
      continue;
    }

    if (isBlockquote(line)) {
      const quoteLines = [];
      while (i < lines.length && isBlockquote(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }

      const quoteText = quoteLines.join('\n').trim();
      const quoteContent = parseInlineWithHardBreaks(quoteText, referenceMap);
      blocks.push({
        type: 'blockquote',
        content: [
          {
            type: 'paragraph',
            ...(quoteContent.length > 0 ? { content: quoteContent } : {}),
          },
        ],
      });
      continue;
    }

    if (isBulletItem(line) || isOrderedItem(line)) {
      const ordered = isOrderedItem(line);
      const items = [];
      const matcher = ordered ? /^\s*\d+\.\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;

      while (i < lines.length) {
        const candidate = lines[i];
        if (candidate.trim() === '') break;
        if (ordered && !isOrderedItem(candidate)) break;
        if (!ordered && !isBulletItem(candidate)) break;

        const itemMatch = candidate.match(matcher);
        let text = itemMatch ? itemMatch[1] : candidate.trim();
        i += 1;

        while (
          i < lines.length &&
          lines[i].trim() !== '' &&
          !isSpecialStart(lines[i]) &&
          /^\s+/.test(lines[i])
        ) {
          text += `\n${lines[i].trim()}`;
          i += 1;
        }

        items.push(listItemFromText(text, referenceMap));
      }

      blocks.push({
        type: ordered ? 'orderedList' : 'bulletList',
        content: items,
      });
      continue;
    }

    const paragraphLines = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() !== '' && !isSpecialStart(lines[i])) {
      paragraphLines.push(lines[i]);
      i += 1;
    }
    const paragraphText = paragraphLines.join('\n').trimEnd();
    const paragraphContent = parseInlineWithHardBreaks(paragraphText, referenceMap);
    blocks.push({
      type: 'paragraph',
      ...(paragraphContent.length > 0 ? { content: paragraphContent } : {}),
    });
  }

  if (blocks.length === 0) {
    return [{ type: 'paragraph' }];
  }
  return blocks;
}

function extractTitleFromFilename(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  const separatorIndex = base.lastIndexOf('-');
  return separatorIndex > 0 ? base.slice(0, separatorIndex).trim() : base.trim();
}

function firstNodePlainText(node) {
  if (!node || !node.content) return '';
  return normalizeWhitespace(
    node.content
      .filter((child) => child.type === 'text')
      .map((child) => child.text || '')
      .join(' ')
  );
}

function ensureTitleHeading(nodes, title) {
  const trimmedTitle = normalizeWhitespace(title || '');
  if (!trimmedTitle) {
    return nodes;
  }

  if (nodes.length > 0 && nodes[0].type === 'heading') {
    const existing = firstNodePlainText(nodes[0]);
    if (existing && existing.toLowerCase() === trimmedTitle.toLowerCase()) {
      return nodes;
    }
  }

  const heading = {
    type: 'heading',
    attrs: { level: 1 },
    content: [createTextNode(trimmedTitle)],
  };
  return [heading, ...nodes];
}

function buildMissingMediaMessage(noteFilePath, originalTarget, attemptedPath) {
  return `Missing media in ${path.basename(noteFilePath)}: "${originalTarget}" (looked for ${attemptedPath})`;
}

function createMediaResolver({
  notesDir,
  imagesDir,
  attachmentsDir,
  uploadsDir,
  execute,
  userId,
  failOnMissingMedia,
  verbose,
}) {
  const copiedBySourcePath = new Map();
  const summary = {
    copiedImages: 0,
    copiedAttachments: 0,
    missingMedia: 0,
    warnings: [],
  };

  async function resolveLocalFilePath(noteDir, cleanedTarget) {
    const attempts = [];
    const normalizedTarget = cleanedTarget.replace(/\\/g, '/');
    const decodedTarget = decodeURIComponentSafe(normalizedTarget);

    const directCandidate = path.resolve(noteDir, decodedTarget);
    attempts.push(directCandidate);
    if (await pathExists(directCandidate)) {
      return { filePath: directCandidate, attempted: directCandidate };
    }

    const notesCandidate = path.resolve(notesDir, decodedTarget);
    attempts.push(notesCandidate);
    if (await pathExists(notesCandidate)) {
      return { filePath: notesCandidate, attempted: notesCandidate };
    }

    const basename = path.basename(decodedTarget);
    const imageCandidate = path.resolve(imagesDir, basename);
    attempts.push(imageCandidate);
    if (await pathExists(imageCandidate)) {
      return { filePath: imageCandidate, attempted: imageCandidate };
    }

    const attachmentCandidate = path.resolve(attachmentsDir, basename);
    attempts.push(attachmentCandidate);
    if (await pathExists(attachmentCandidate)) {
      return { filePath: attachmentCandidate, attempted: attachmentCandidate };
    }

    return { filePath: null, attempted: attempts[attempts.length - 1] };
  }

  async function resolveTarget(noteFilePath, rawTarget) {
    const cleanedTarget = cleanMarkdownTarget(rawTarget);
    if (!cleanedTarget) return '';
    if (isRemoteTarget(cleanedTarget)) return cleanedTarget;
    if (cleanedTarget.startsWith('/api/uploads/')) return cleanedTarget;
    if (cleanedTarget.startsWith('/')) return cleanedTarget;

    const noteDir = path.dirname(noteFilePath);
    const canBeLocalMedia = isLocalMediaLike(cleanedTarget) || !cleanedTarget.includes('://');
    if (!canBeLocalMedia) {
      return cleanedTarget;
    }

    const resolved = await resolveLocalFilePath(noteDir, cleanedTarget);
    if (!resolved.filePath) {
      const message = buildMissingMediaMessage(noteFilePath, rawTarget, resolved.attempted);
      summary.missingMedia += 1;
      summary.warnings.push(message);
      if (verbose) {
        console.warn(`[warn] ${message}`);
      }
      if (failOnMissingMedia) {
        throw new Error(message);
      }
      return cleanedTarget;
    }

    if (copiedBySourcePath.has(resolved.filePath)) {
      return copiedBySourcePath.get(resolved.filePath);
    }

    const buffer = await fs.readFile(resolved.filePath);
    const hash = crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 12);
    const sourceBase = sanitizeFilename(path.basename(resolved.filePath));
    const destinationName = `imported-u${userId}-${hash}-${sourceBase}`;
    const destinationPath = path.join(uploadsDir, destinationName);
    const destinationUrl = `/api/uploads/${destinationName}`;

    const extension = path.extname(resolved.filePath).toLowerCase();
    const isImage = ALLOWED_IMAGE_EXTENSIONS.has(extension);

    if (execute) {
      const exists = await pathExists(destinationPath);
      if (!exists) {
        await fs.writeFile(destinationPath, buffer);
      }
    }

    copiedBySourcePath.set(resolved.filePath, destinationUrl);
    if (isImage) {
      summary.copiedImages += 1;
    } else {
      summary.copiedAttachments += 1;
    }

    return destinationUrl;
  }

  return {
    resolveTarget,
    summary,
  };
}

async function collectReferenceMap(body, noteFilePath, mediaResolver) {
  const referenceMap = new Map();
  const patterns = [
    /!\[[^\]]*]\(([^)]+)\)/g,
    /\[[^\]]+]\(([^)]+)\)/g,
  ];

  for (const pattern of patterns) {
    const matches = body.matchAll(pattern);
    for (const match of matches) {
      const rawTarget = match[1];
      if (!rawTarget) continue;
      if (referenceMap.has(rawTarget) || referenceMap.has(cleanMarkdownTarget(rawTarget))) {
        continue;
      }
      const resolved = await mediaResolver.resolveTarget(noteFilePath, rawTarget);
      referenceMap.set(rawTarget, resolved);
      referenceMap.set(cleanMarkdownTarget(rawTarget), resolved);
    }
  }

  return referenceMap;
}

async function transformNoteFile(filePath, mediaResolver, verbose) {
  const fileContent = await fs.readFile(filePath, 'utf8');
  const fileStat = await fs.stat(filePath);
  const { frontmatter, body } = parseFrontmatter(fileContent);

  const createdAt = parseDateValue(frontmatter.creation_date, fileStat.mtime);
  const updatedAt = parseDateValue(frontmatter.modification_date, createdAt);
  const title = frontmatter.title || extractTitleFromFilename(filePath);

  const referenceMap = await collectReferenceMap(body, filePath, mediaResolver);
  const contentNodes = parseMarkdownToTiptap(body, referenceMap);
  const titledNodes = ensureTitleHeading(contentNodes, title);
  const document = {
    type: 'doc',
    content: titledNodes.length > 0 ? titledNodes : [{ type: 'paragraph' }],
  };

  if (verbose) {
    console.log(`[parse] ${path.basename(filePath)} -> ${document.content.length} block(s)`);
  }

  return {
    sourceFile: filePath,
    createdAt,
    updatedAt,
    content: document,
  };
}

async function writeBackupFile({
  client,
  userId,
  backupFileFromArgs,
  serverDir,
}) {
  const backupDir = path.resolve(serverDir, 'import-backups');
  await fs.mkdir(backupDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = backupFileFromArgs
    ? path.resolve(backupFileFromArgs)
    : path.join(backupDir, `notes-user-${userId}-${timestamp}.json`);

  const existing = await client.query(
    'SELECT id, user_id, content, created_at, updated_at FROM notes WHERE user_id = $1 ORDER BY updated_at DESC, created_at DESC, id DESC',
    [userId]
  );

  const payload = {
    generated_at: new Date().toISOString(),
    user_id: userId,
    note_count: existing.rows.length,
    notes: existing.rows,
  };

  await fs.mkdir(path.dirname(backupFile), { recursive: true });
  await fs.writeFile(backupFile, JSON.stringify(payload, null, 2), 'utf8');

  return backupFile;
}

function printUsage() {
  console.log(`Usage:
  node import-script.js --user-id <id> [--source <path>] [--execute --confirm-replace REPLACE_USER_<id>] [--backup-file <path>] [--verbose] [--fail-on-missing-media]

Examples:
  node import-script.js --user-id 1 --source ../iCloud
  node import-script.js --user-id 1 --source /absolute/path/to/iCloud --execute --confirm-replace REPLACE_USER_1
`);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[error] ${error.message}`);
    printUsage();
    process.exit(1);
  }

  const serverDir = path.dirname(fileURLToPath(import.meta.url));
  const sourceRoot = path.resolve(args.source || path.join(serverDir, '..', 'iCloud'));
  const notesDir = path.join(sourceRoot, SOURCE_NOTES_DIRNAME);
  const imagesDir = path.join(notesDir, SOURCE_IMAGES_DIRNAME);
  const attachmentsDir = path.join(notesDir, SOURCE_ATTACHMENTS_DIRNAME);
  const uploadsDir = path.join(serverDir, 'uploads');

  console.log(`[info] Mode: ${args.execute ? 'EXECUTE' : 'DRY RUN (default safe mode)'}`);
  console.log(`[info] Source: ${sourceRoot}`);
  console.log(`[info] User ID: ${args.userId}`);

  if (!(await pathExists(sourceRoot))) {
    throw new Error(`Source path does not exist: ${sourceRoot}`);
  }
  if (!(await pathExists(notesDir))) {
    throw new Error(`Notes directory not found: ${notesDir}`);
  }
  if (!(await pathExists(uploadsDir))) {
    throw new Error(`Uploads directory not found: ${uploadsDir}`);
  }

  const hasImagesDir = await pathExists(imagesDir);
  const hasAttachmentsDir = await pathExists(attachmentsDir);
  if (!hasImagesDir) {
    console.warn(`[warn] Optional directory missing: ${imagesDir}`);
  }
  if (!hasAttachmentsDir) {
    console.warn(`[warn] Optional directory missing: ${attachmentsDir}`);
  }

  const pool = new Pool(DB_CONFIG);
  const client = await pool.connect();
  let lockAcquired = false;
  let inTransaction = false;

  try {
    const userResult = await client.query('SELECT id FROM users WHERE id = $1', [args.userId]);
    if (userResult.rows.length === 0) {
      throw new Error(`User not found: ${args.userId}`);
    }

    const lockResult = await client.query(
      'SELECT pg_try_advisory_lock($1, $2) AS acquired',
      [ADVISORY_LOCK_KEY_NAMESPACE, args.userId]
    );
    lockAcquired = lockResult.rows[0]?.acquired === true;
    if (!lockAcquired) {
      throw new Error(`Could not acquire advisory lock for user ${args.userId}`);
    }

    const markdownFiles = await collectMarkdownFiles(notesDir);
    if (markdownFiles.length === 0) {
      throw new Error(`No markdown files found in ${notesDir}`);
    }

    const mediaResolver = createMediaResolver({
      notesDir,
      imagesDir,
      attachmentsDir,
      uploadsDir,
      execute: args.execute,
      userId: args.userId,
      failOnMissingMedia: args.failOnMissingMedia,
      verbose: args.verbose,
    });

    const transformedNotes = [];
    for (const filePath of markdownFiles) {
      transformedNotes.push(
        await transformNoteFile(filePath, mediaResolver, args.verbose)
      );
    }

    let backupPath = null;

    if (args.execute) {
      await client.query('BEGIN');
      inTransaction = true;

      backupPath = await writeBackupFile({
        client,
        userId: args.userId,
        backupFileFromArgs: args.backupFile,
        serverDir,
      });

      await client.query('DELETE FROM notes WHERE user_id = $1', [args.userId]);

      for (const note of transformedNotes) {
        await client.query(
          'INSERT INTO notes (user_id, content, created_at, updated_at) VALUES ($1, $2, $3, $4)',
          [args.userId, JSON.stringify(note.content), note.createdAt, note.updatedAt]
        );
      }

      await client.query('COMMIT');
      inTransaction = false;
    }

    const verification = await client.query(
      'SELECT COUNT(*)::int AS count FROM notes WHERE user_id = $1',
      [args.userId]
    );
    const insertedCount = verification.rows[0]?.count ?? 0;

    const mediaSummary = mediaResolver.summary;
    console.log('--- Import Summary ---');
    console.log(`Notes discovered: ${markdownFiles.length}`);
    console.log(`Notes transformed: ${transformedNotes.length}`);
    console.log(`Images copied: ${mediaSummary.copiedImages}`);
    console.log(`Attachments copied: ${mediaSummary.copiedAttachments}`);
    console.log(`Missing media refs: ${mediaSummary.missingMedia}`);
    console.log(`DB rows for user ${args.userId}: ${insertedCount}`);
    if (backupPath) {
      console.log(`Backup file: ${backupPath}`);
    }
    if (!args.execute) {
      console.log('[info] Dry run complete. Re-run with --execute to write to database.');
    }

    if (mediaSummary.warnings.length > 0 && args.verbose) {
      console.log('--- Warnings ---');
      for (const warning of mediaSummary.warnings) {
        console.log(`- ${warning}`);
      }
    }
  } catch (error) {
    if (inTransaction) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('[error] Rollback failed:', rollbackError.message);
      }
    }
    throw error;
  } finally {
    if (lockAcquired) {
      try {
        await client.query('SELECT pg_advisory_unlock($1, $2)', [
          ADVISORY_LOCK_KEY_NAMESPACE,
          args.userId,
        ]);
      } catch (unlockError) {
        console.error('[error] Failed to release advisory lock:', unlockError.message);
      }
    }
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  const details =
    error instanceof Error
      ? error.stack || error.message
      : String(error);
  console.error(`[fatal] ${details}`);
  process.exit(1);
});
