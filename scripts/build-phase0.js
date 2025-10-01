#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");

function normalizePath(p) {
  return p.split(path.sep).join("/");
}

function ensureJsExtension(specifier) {
  return specifier.endsWith(".js") ? specifier : `${specifier}.js`;
}

function getModuleId(absPath) {
  const relPath = normalizePath(path.relative(rootDir, absPath));
  return relPath.startsWith(".") ? relPath : `./${relPath}`;
}

function resolveImport(fromPath, specifier) {
  if (!specifier.startsWith(".")) {
    throw new Error(
      `Unsupported bare import "${specifier}" in ${path.relative(
        rootDir,
        fromPath
      )}`
    );
  }
  const target = ensureJsExtension(specifier);
  return path.resolve(path.dirname(fromPath), target);
}

function indent(code, spaces = 4) {
  const pad = " ".repeat(spaces);
  return code
    .split("\n")
    .map((line) => (line.length ? pad + line : pad))
    .join("\n");
}

const moduleGraph = new Map();

function transformModule(absPath) {
  const source = fs.readFileSync(absPath, "utf8");
  let code = source;
  const dependencies = new Set();
  const namedExports = [];
  let reExportCounter = 0;

  // Handle re-export statements first
  code = code.replace(
    /export\s*{([^}]+)}\s*from\s*["']([^"']+)["'];?/g,
    (match, specifiers, specifierPath) => {
      const resolved = resolveImport(absPath, specifierPath);
      dependencies.add(resolved);
      const moduleId = getModuleId(resolved);
      const tempVar = `__reExport${reExportCounter++}`;
      const lines = [`const ${tempVar} = require("${moduleId}");`];

      specifiers
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .forEach((part) => {
          const aliasParts = part.split(/\s+as\s+/i).map((token) => token.trim());
          const original = aliasParts[0];
          const alias = aliasParts[1] || original;
          lines.push(`exports.${alias} = ${tempVar}.${original};`);
        });

      return lines.join("\n");
    }
  );

  // Handle named imports
  code = code.replace(
    /import\s*{([^}]+)}\s*from\s*["']([^"']+)["'];?/g,
    (match, specifiers, specifierPath) => {
      const resolved = resolveImport(absPath, specifierPath);
      dependencies.add(resolved);
      const moduleId = getModuleId(resolved);

      const destructured = specifiers
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const aliasParts = part.split(/\s+as\s+/i).map((token) => token.trim());
          return aliasParts[1]
            ? `${aliasParts[0]}: ${aliasParts[1]}`
            : aliasParts[0];
        })
        .join(", ");

      return `const { ${destructured} } = require("${moduleId}");`;
    }
  );

  // Handle export class declarations
  code = code.replace(
    /export\s+class\s+([A-Za-z0-9_$]+)/g,
    (match, className) => {
      namedExports.push({ name: className, alias: className });
      return `class ${className}`;
    }
  );

  // Handle export function (including async)
  code = code.replace(
    /export\s+(async\s+)?function\s+([A-Za-z0-9_$]+)/g,
    (match, asyncKeyword = "", fnName) => {
      namedExports.push({ name: fnName, alias: fnName });
      return `${asyncKeyword}function ${fnName}`;
    }
  );

  // Handle export variable declarations
  code = code.replace(
    /export\s+(const|let|var)\s+([A-Za-z0-9_$]+)/g,
    (match, kind, varName) => {
      namedExports.push({ name: varName, alias: varName });
      return `${kind} ${varName}`;
    }
  );

  // Handle direct export lists (no from)
  code = code.replace(/export\s*{([^}]+)}\s*;?/g, (match, specifiers) => {
    const lines = [];
    specifiers
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .forEach((part) => {
        const aliasParts = part.split(/\s+as\s+/i).map((token) => token.trim());
        const original = aliasParts[0];
        const alias = aliasParts[1] || original;
        lines.push(`exports.${alias} = ${original};`);
      });
    return lines.join("\n");
  });

  if (namedExports.length > 0) {
    const lines = namedExports.map(
      ({ name, alias }) => `exports.${alias} = ${name};`
    );
    code = `${code}\n${lines.join("\n")}`;
  }

  return { code, dependencies: Array.from(dependencies) };
}

function collectModule(absPath) {
  const id = getModuleId(absPath);
  if (moduleGraph.has(id)) {
    return;
  }

  const { code, dependencies } = transformModule(absPath);
  moduleGraph.set(id, { code, absPath });

  dependencies.forEach((depAbsPath) => {
    collectModule(depAbsPath);
  });
}

function bundle(entryRelativePath, outputRelativePath) {
  moduleGraph.clear();

  const entryAbs = path.resolve(rootDir, entryRelativePath);
  collectModule(entryAbs);

  const sortedModules = Array.from(moduleGraph.entries()).sort((a, b) =>
    a[0] < b[0] ? -1 : 1
  );

  const modulesBlob = sortedModules
    .map(([id, { code }]) => {
      return `  "${id}": function (exports, module, require) {\n${indent(
        code
      )}\n  }`;
    })
    .join(",\n");

  const entryId = getModuleId(entryAbs);
  const output = `(() => {\n  const modules = {\n${modulesBlob}\n  };\n  const cache = {};\n  function require(id) {\n    if (cache[id]) return cache[id].exports;\n    if (!modules[id]) {\n      throw new Error('Module not found: ' + id);\n    }\n    const module = { exports: {} };\n    cache[id] = module;\n    modules[id](module.exports, module, require);\n    return module.exports;\n  }\n  require('${entryId}');\n})();\n`;

  const outputAbs = path.resolve(rootDir, outputRelativePath);
  fs.mkdirSync(path.dirname(outputAbs), { recursive: true });
  fs.writeFileSync(outputAbs, output, "utf8");
}

function main() {
  const targets = [
    {
      entry: "src/runtime/content-script.js",
      output: "src/extension/content.js",
    },
    {
      entry: "src/runtime/bookmarklet.js",
      output: "dist/2048-hud.js",
    },
  ];

  targets.forEach(({ entry, output }) => {
    bundle(entry, output);
    console.log(`Bundled ${entry} -> ${output}`);
  });

  // Provide a copy named .min.js for Phase 0 deliverable parity (no extra minification yet)
  const bookmarkletOutput = path.resolve(rootDir, "dist/2048-hud.js");
  const minifiedOutput = path.resolve(rootDir, "dist/2048-hud.min.js");
  fs.copyFileSync(bookmarkletOutput, minifiedOutput);
  console.log("Created dist/2048-hud.min.js (pre-minified copy)");
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error("Build failed:", error);
    process.exitCode = 1;
  }
}
