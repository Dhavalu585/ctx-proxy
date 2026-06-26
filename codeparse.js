'use strict';
const { Parser, Language } = require('web-tree-sitter');
const path = require('path');

// Language registry: each maps to its WASM grammar + the node types that
// represent functions/methods and classes/structs in that grammar.
const LANGUAGES = {
  java: {
    wasm: 'tree-sitter-java/tree-sitter-java.wasm',
    fnNodes: ['method_declaration', 'constructor_declaration'],
    classNodes: ['class_declaration', 'interface_declaration'],
    fence: 'java',
  },
  python: {
    wasm: 'tree-sitter-python/tree-sitter-python.wasm',
    fnNodes: ['function_definition'],
    classNodes: ['class_definition'],
    fence: 'python',
  },
  javascript: {
    wasm: 'tree-sitter-javascript/tree-sitter-javascript.wasm',
    fnNodes: ['function_declaration', 'method_definition', 'arrow_function', 'function_expression'],
    classNodes: ['class_declaration'],
    fence: 'javascript',
  },
  typescript: {
    wasm: 'tree-sitter-typescript/tree-sitter-typescript.wasm',
    fnNodes: ['function_declaration', 'method_definition', 'arrow_function', 'function_signature'],
    classNodes: ['class_declaration', 'interface_declaration'],
    fence: 'typescript',
  },
  go: {
    wasm: 'tree-sitter-go/tree-sitter-go.wasm',
    fnNodes: ['function_declaration', 'method_declaration'],
    classNodes: ['type_declaration'],
    fence: 'go',
  },
  rust: {
    wasm: 'tree-sitter-rust/tree-sitter-rust.wasm',
    fnNodes: ['function_item'],
    classNodes: ['struct_item', 'impl_item', 'trait_item', 'enum_item'],
    fence: 'rust',
  },
  cpp: {
    wasm: 'tree-sitter-cpp/tree-sitter-cpp.wasm',
    fnNodes: ['function_definition'],
    classNodes: ['class_specifier', 'struct_specifier'],
    fence: 'cpp',
  },
  csharp: {
    wasm: 'tree-sitter-c-sharp/tree-sitter-c_sharp.wasm',
    fnNodes: ['method_declaration', 'constructor_declaration'],
    classNodes: ['class_declaration', 'interface_declaration', 'struct_declaration'],
    fence: 'csharp',
  },
  php: {
    wasm: 'tree-sitter-php/tree-sitter-php.wasm',
    fnNodes: ['function_definition', 'method_declaration'],
    classNodes: ['class_declaration', 'interface_declaration', 'trait_declaration'],
    fence: 'php',
  },
};

const _parsers = {};
let _initDone = false;

async function getParser(lang) {
  const spec = LANGUAGES[lang];
  if (!spec) throw new Error(`Unsupported language: ${lang}`);
  if (_parsers[lang]) return _parsers[lang];
  if (!_initDone) { await Parser.init(); _initDone = true; }
  const parser = new Parser();
  const wasmPath = path.join(__dirname, 'node_modules', ...spec.wasm.split('/'));
  const Lang = await Language.load(wasmPath);
  parser.setLanguage(Lang);
  _parsers[lang] = parser;
  return parser;
}

async function parseCode(source, lang) {
  const spec = LANGUAGES[lang];
  if (!spec) throw new Error(`Unsupported language: ${lang}`);
  const parser = await getParser(lang);
  const tree = parser.parse(source);
  const units = [];
  const lines = source.split('\n');

  function findName(node) {
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c.type === 'identifier' || c.type === 'name' || c.type === 'type_identifier' || c.type === 'field_identifier') return c.text;
    }
    return '(anonymous)';
  }

  function walk(node) {
    if (spec.fnNodes.includes(node.type)) {
      const name = findName(node);
      let signature = lines[node.startPosition.row].trim();
      let sr = node.startPosition.row;
      while (!signature.includes('{') && !signature.includes(':') && sr < node.endPosition.row) {
        sr++; signature += ' ' + lines[sr].trim();
      }
      signature = signature.split('{')[0].split(':')[0].trim();
      units.push({
        type: 'method', name, signature,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        code: lines.slice(node.startPosition.row, node.endPosition.row + 1).join('\n'),
      });
    }
    if (spec.classNodes.includes(node.type)) {
      const name = findName(node);
      units.push({
        type: 'class', name,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        code: `(class ${name}, lines ${node.startPosition.row + 1}-${node.endPosition.row + 1})`,
      });
    }
    for (let i = 0; i < node.childCount; i++) walk(node.child(i));
  }
  walk(tree.rootNode);
  return units;
}

async function parseJava(source) {
  return parseCode(source, 'java');
}

module.exports = { parseCode, parseJava, LANGUAGES };
