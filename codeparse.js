'use strict';
const { Parser, Language } = require('web-tree-sitter');
const path = require('path');

let _parser = null;

async function initJavaParser() {
  if (_parser) return _parser;
  await Parser.init();
  const parser = new Parser();
  const javaWasm = path.join(__dirname, 'node_modules', 'tree-sitter-java', 'tree-sitter-java.wasm');
  const Java = await Language.load(javaWasm);
  parser.setLanguage(Java);
  _parser = parser;
  return parser;
}

// Extract methods + classes as structured units from Java source
async function parseJava(source) {
  const parser = await initJavaParser();
  const tree = parser.parse(source);
  const units = [];
  const lines = source.split('\n');

  function walk(node) {
    if (node.type === 'method_declaration' || node.type === 'constructor_declaration') {
      let name = '(anonymous)';
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (c.type === 'identifier') { name = c.text; break; }
      }
      units.push({
        type: 'method',
        name,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        code: lines.slice(node.startPosition.row, node.endPosition.row + 1).join('\n'),
      });
    }
    if (node.type === 'class_declaration') {
      let name = '(anonymous)';
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (c.type === 'identifier') { name = c.text; break; }
      }
      units.push({
        type: 'class',
        name,
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

module.exports = { parseJava };