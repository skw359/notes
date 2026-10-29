const LEGACY_UPLOAD_PATH_RE = /^\/api\/uploads\/([^?#/]+)$/i;

export function extractLegacyFilenameFromUrl(url) {
  if (typeof url !== 'string') {
    return null;
  }

  const match = url.match(LEGACY_UPLOAD_PATH_RE);
  if (!match) {
    return null;
  }

  return decodeURIComponent(match[1]);
}

export function extractLegacyFilenamesFromContent(content) {
  const filenames = new Set();

  function walk(node) {
    if (!node || typeof node !== 'object') {
      return;
    }

    const src = node.attrs?.src;
    const filename = extractLegacyFilenameFromUrl(src);
    if (filename) {
      filenames.add(filename);
    }

    if (Array.isArray(node.content)) {
      for (const child of node.content) {
        walk(child);
      }
    }
  }

  walk(content);
  return filenames;
}
