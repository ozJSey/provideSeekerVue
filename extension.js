const vscode = require("vscode");
const path = require("path");
const fs = require("fs");

/**
 * Regex Definitions
 */
const RX_VUE_SCRIPT_BLOCK = /<script[^>]*>([\s\S]*?)<\/script>/g; // Capture ALL <script> blocks
const RX_IMPORT_STATEMENTS = /import\s+(\{?\s*[\w,\s]+\}?)\s+from\s+['"][^'"]+['"]/g; // Matches import statements in script
const RX_PROVIDE_CAPTURE = /provide\s*\(\s*([\s\S]*?)\s*\)/g; // Captures the content inside provide(...)
const RX_PROVIDE_BLOCK = /provide\s*\(\s*[\s\S]*?\s*\)/g; // Matches entire provide(...) blocks
const RX_OBJECT_PAIRS = /(['"]?[\w]+['"]?)\s*:\s*(['"]?[\w\s]+['"]?)|(['"]?[\w]+['"]?)(?=\s*[},])/g; // Matches key-value pairs within an object

/**
 * Caches & Globals
 */
const fileContentCache = new Map();
const parentsCache = new Map();
const providesCache = new Map();
let vueFilesList = [];

/**
 * Helper functions
 */
const _stripQuotes = (s = "") => s.replace(/^['"]|['"]$/g, "");

const _readFile = (filePath) =>
  new Promise((resolve, reject) => {
    fs.readFile(filePath, "utf8", (err, data) => (err ? reject(err) : resolve(data)));
  });

const _extractScriptContent = (fileContent = "") => {
  const scriptMatches = fileContent.matchAll(RX_VUE_SCRIPT_BLOCK);
  let combinedScript = "";
  for (const match of scriptMatches) {
    // match[1] is the script block content
    combinedScript += match[1] + "\n";
  }
  return combinedScript;
};

const _doesFileImportComponent = (fileContent = "", compName) => {
  const scriptContent = _extractScriptContent(fileContent);
  return [...scriptContent.matchAll(RX_IMPORT_STATEMENTS)].some((match) => {
    const imported = match[1]
      .replace(/[{}]/g, "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    return imported.includes(compName);
  });
};

const _parseKeyValuePairs = (str = "") => {
  const matches = [...str.matchAll(RX_OBJECT_PAIRS)];
  return matches.map((m) => {
    const key = m[1] || m[3];
    const val = m[2] || m[3];
    return [_stripQuotes(key), _stripQuotes(val)];
  });
};

const _formatObjectProvides = (inner) =>
  _parseKeyValuePairs(inner).map(([k, v]) => `- **${k}**: ${v}`);

const _formatSingleProvideKV = (inner) => {
  const kv = inner.match(/^([^,]+?)\s*,\s*([\s\S]+)$/);
  return kv
    ? [`- **${_stripQuotes(kv[1].trim())}**: ${_stripQuotes(kv[2].trim())}`]
    : ["- *(Non-valid provide syntax found)*"];
};

const _extractProvideContent = (str = "") => {
  const matches = [...str.matchAll(RX_PROVIDE_CAPTURE)];
  if (!matches.length) return "- *(Non-valid provide syntax found)*";

  const results = matches.flatMap((match) => {
    const inner = (match[1] || "").trim();
    if (inner.startsWith("{")) {
      try {
        return _formatObjectProvides(inner);
      } catch {
        return [];
      }
    }
    return _formatSingleProvideKV(inner);
  });

  return results.length ? results.join("\n\n") : "- *(Non-valid provide syntax found)*";
};

const _generateHoverContent = (parents) => {
  const lines = [
    "**Ancestors provide values 💉:**\n",
    ...parents.map(({ provides, name, source }) => {
      const parsed = provides.map(_extractProvideContent).join("\n\n");
      return `**Provides:**\n${parsed || "(no values)"}\n\n${name}\n*(at ${source})*`;
    }),
  ];

  const md = new vscode.MarkdownString(lines.join("\n\n---\n\n"));
  md.isTrusted = true;
  return md;
};

/**
 * Cache retrieval and storing
 */
const _getFileContent = async (filePath) => {
  if (fileContentCache.has(filePath)) return fileContentCache.get(filePath);

  try {
    const data = await _readFile(filePath);
    fileContentCache.set(filePath, data);
    return data;
  } catch {
    fileContentCache.set(filePath, "");
    return "";
  }
};

const _getFileProvides = async (filePath) => {
  if (providesCache.has(filePath)) return providesCache.get(filePath);

  const content = await _getFileContent(filePath);
  if (!content.includes("provide")) {
    providesCache.set(filePath, []);
    return [];
  }

  const matches = [...content.matchAll(RX_PROVIDE_BLOCK)].map((m) => m[0]);
  providesCache.set(filePath, matches);
  return matches;
};

const _getParentFiles = async (componentName) => {
  if (parentsCache.has(componentName)) return parentsCache.get(componentName);

  // Identify all .vue files import this component
  const found = (
    await Promise.all(
      vueFilesList.map(async (filePath) => {
        const content = await _getFileContent(filePath);
        return _doesFileImportComponent(content, componentName) ? filePath : null;
      })
    )
  ).filter(Boolean);

  parentsCache.set(componentName, found);
  return found;
};

const _exploreParentsDFS = async (compName, visitedFiles, parentsWithProvides) => {
  const parentFiles = await _getParentFiles(compName);

  await Promise.all(
    parentFiles.map(async (filePath) => {
      if (visitedFiles.has(filePath)) return;
      visitedFiles.add(filePath);

      const provides = await _getFileProvides(filePath);
      if (provides.length > 0) {
        parentsWithProvides.push({
          name: path.basename(filePath),
          source: filePath,
          provides,
        });
      }

      const nextComp = path.basename(filePath, ".vue");
      await _exploreParentsDFS(nextComp, visitedFiles, parentsWithProvides);
    })
  );
};

const _findAncestorsThatProvide = async (componentName) => {
  const visitedFiles = new Set();
  const parentsWithProvides = [];
  await _exploreParentsDFS(componentName, visitedFiles, parentsWithProvides);
  return parentsWithProvides;
};

/**
 * Cache Invalidation and Removal
 */
const invalidateFileCaches = (filePath) => {
  fileContentCache.delete(filePath);
  providesCache.delete(filePath);

  const name = path.basename(filePath, ".vue");
  parentsCache.delete(name);
};

const removeFileFromCaches = (filePath) => {
  invalidateFileCaches(filePath);
  parentsCache.forEach((filePaths, comp) => {
    parentsCache.set(comp, filePaths.filter((p) => p !== filePath));
  });
};

/**
 * Gather all .vue files in the workspace
 */
const getAllVueFiles = async () =>
  vscode.workspace
    .findFiles("**/*.vue", "**/node_modules/**")
    .then((uris) => uris.map((u) => u.fsPath));

/**
 * Decoration / Provide Seeker
 */
const handleProvideSeeker = async (document) => {
  if (!document.fileName.endsWith(".vue")) return;

  const componentName = path.basename(document.fileName, ".vue");
  const parents = await _findAncestorsThatProvide(componentName);

  if (!parents.length) return;

  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.fileName !== document.fileName) return;

  // Decorate line 1 (index 0) if ancestors provide something
  const deco = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    after: {
      contentText: "Ancestors provide values 💉",
      color: "orange",
      fontWeight: "semibold",
    },
  });

  editor.setDecorations(deco, [
    {
      range: new vscode.Range(0, 0, 0, 0),
      hoverMessage: _generateHoverContent(parents),
    },
  ]);
};

/**
 * VSCode Extension Entry
 */
const activate = async (context) => {
  vueFilesList = await getAllVueFiles();
  // Setup a file system watcher for .vue files
  const watcher = vscode.workspace.createFileSystemWatcher("**/*.vue", false, false, false);

  watcher.onDidCreate((uri) => {
    if (!vueFilesList.includes(uri.fsPath)) {
      vueFilesList.push(uri.fsPath);
    }
    invalidateFileCaches(uri.fsPath);
  });

  watcher.onDidDelete((uri) => {
    removeFileFromCaches(uri.fsPath);
    vueFilesList = vueFilesList.filter((p) => p !== uri.fsPath);
  });

  watcher.onDidChange((uri) => {
    invalidateFileCaches(uri.fsPath);
  });

  const { activeTextEditor } = vscode.window;
  if (activeTextEditor?.document.languageId === "vue") {
    handleProvideSeeker(activeTextEditor.document);
  }

  vscode.workspace.onDidOpenTextDocument((doc) => {
    if (doc.languageId === "vue") {
      handleProvideSeeker(doc);
    }
  });

  vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (editor?.document.languageId === "vue") {
      handleProvideSeeker(editor.document);
    }
  });
};

const deactivate = () => {};

module.exports = {
  activate,
  deactivate,
};