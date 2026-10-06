'use strict';

const assert = require('node:assert/strict');
const {
  REQUIRED_FORMULAS,
  sha256,
  protectPlainSource,
  parseProtectedSource,
  serializeForAI,
  collectMathBlocks,
  roundTripDocument,
  runRequiredFormulaTests,
  createDocumentFromMarkdown
} = require('../app.js');

const numberedWithMath = createDocumentFromMarkdown(String.raw`1. Первый пункт:

\[x_1=1\]

2. Второй пункт:

\[x_2=2\]

3. Третий пункт.`).document;
assert.deepEqual(numberedWithMath.blocks.filter(b => b.type === 'list').map(b => b.start), [1, 2, 3]);
assert.match(serializeForAI(numberedWithMath), /2\. Второй пункт/);
assert.match(serializeForAI(numberedWithMath), /3\. Третий пункт/);
assert.equal(roundTripDocument(numberedWithMath).ok, true);

function documentFromPlain(source) {
  const scan = protectPlainSource(source);
  return {
    version: 1,
    rawImports: [{ plain: source, html: '', timestamp: 'test' }],
    blocks: parseProtectedSource(scan.protectedSource, scan.formulas),
    metadata: { title: 'Test', author: '' }
  };
}

assert.equal(
  sha256('abc'),
  'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  'SHA-256 must match the standard vector'
);

const fixtureResult = runRequiredFormulaTests();
assert.equal(fixtureResult.ok, true, JSON.stringify(fixtureResult.failures, null, 2));
assert.equal(fixtureResult.passed, REQUIRED_FORMULAS.length);

const allDelimiters = String.raw`Inline \(a_b^2\), dollars $c_d$, display:

\[E_{\overline a,\overline b}\]

$$\operatorname{Fix}(\mathcal C_n)$$`;
const delimiterDocument = documentFromPlain(allDelimiters);
assert.deepEqual(
  collectMathBlocks(delimiterDocument).map((block) => block.latexOriginal),
  [String.raw`a_b^2`, String.raw`c_d`, String.raw`E_{\overline a,\overline b}`, String.raw`\operatorname{Fix}(\mathcal C_n)`]
);
assert.equal(roundTripDocument(delimiterDocument).ok, true);

const doubledDelimiters = String.raw`Двойное экранирование \\(C_{10}^2=I\\) и \\[D_{10}^n\\].`;
const doubledDocument = documentFromPlain(doubledDelimiters);
assert.deepEqual(
  collectMathBlocks(doubledDocument).map((block) => block.latexOriginal),
  [String.raw`C_{10}^2=I`, String.raw`D_{10}^n`]
);
assert.equal(roundTripDocument(doubledDocument).ok, true);

const strippedDisplayDelimiters = String.raw`Обычный текст.

[
M_{n+2}=100M_n+45S_n^{stat}.
]

Продолжение текста.`;
const strippedDocument = documentFromPlain(strippedDisplayDelimiters);
assert.deepEqual(
  collectMathBlocks(strippedDocument).map((block) => block.latexOriginal),
  [String.raw`M_{n+2}=100M_n+45S_n^{stat}.
`]
);
assert.equal(collectMathBlocks(strippedDocument)[0].recoveredBareDelimiter, true);
assert.equal(roundTripDocument(strippedDocument).ok, true);

const codeFence = 'До кода $x$.\n\n```js\nconst untouched = "$not_math$";\n```\n\nПосле \\(y\\).';
const codeDocument = documentFromPlain(codeFence);
assert.deepEqual(collectMathBlocks(codeDocument).map((block) => block.latexOriginal), ['x', 'y']);
assert.match(serializeForAI(codeDocument), /\$not_math\$/);

const escapedDollar = String.raw`Цена \$25, формула $x\$y$ и текст.`;
const escapedDocument = documentFromPlain(escapedDollar);
assert.deepEqual(collectMathBlocks(escapedDocument).map((block) => block.latexOriginal), [String.raw`x\$y`]);

const forbiddenNormalizationPayload = String.raw`M\_{n+2}\=100M\_n+45S\_n^{stat}\\ \# { } ^ \Vert`;
const forbiddenNormalizationDocument = documentFromPlain(`\\[${forbiddenNormalizationPayload}\\]`);
assert.equal(collectMathBlocks(forbiddenNormalizationDocument)[0].latexOriginal, forbiddenNormalizationPayload);
assert.equal(roundTripDocument(forbiddenNormalizationDocument).ok, true);

const exactMultiline = `\\[${REQUIRED_FORMULAS[9]}\\]`;
const multilineDocument = documentFromPlain(exactMultiline);
assert.equal(collectMathBlocks(multilineDocument)[0].latexOriginal, REQUIRED_FORMULAS[9]);
assert.equal(roundTripDocument(multilineDocument).ok, true);

const saved = JSON.stringify(multilineDocument);
const reopened = JSON.parse(saved);
assert.equal(collectMathBlocks(reopened)[0].latexCurrent, REQUIRED_FORMULAS[9]);
assert.equal(roundTripDocument(reopened).ok, true);

const immutable = collectMathBlocks(delimiterDocument)[0];
const original = immutable.latexOriginal;
immutable.latexCurrent = `${immutable.latexCurrent}+1`;
immutable.modifiedByUser = true;
assert.equal(immutable.latexOriginal, original);
assert.notEqual(sha256(immutable.latexCurrent), immutable.hashOriginal);

const markdownSource = String.raw`# Заголовок

Абзац с **жирным текстом** и формулой \(C_{10}^2=I\).

- Первый пункт
- Второй пункт с формулой \[D_{10}^n\]

> Цитата`;
const markdownImport = createDocumentFromMarkdown(markdownSource, 'example.md');
assert.equal(markdownImport.document.metadata.title, 'example');
assert.equal(markdownImport.document.rawImports[0].plain, markdownSource);
assert.deepEqual(
  markdownImport.document.blocks.map((block) => block.type),
  ['heading', 'paragraph', 'list', 'quote']
);
assert.deepEqual(
  collectMathBlocks(markdownImport.document).map((block) => block.latexOriginal),
  [String.raw`C_{10}^2=I`, String.raw`D_{10}^n`]
);
assert.equal(roundTripDocument(markdownImport.document).ok, true);

const markdownContractSource = [
  '# Заголовок',
  '',
  '**Жирный текст**',
  '',
  String.raw`Для \(X\) выполняется:`,
  '',
  String.raw`\[`,
  String.raw`P(P(X))=X.`,
  String.raw`\]`,
  '',
  String.raw`### Свойство \(P_{10}\)`,
  '',
  String.raw`**Для \(Y\) выполняется**`,
  '',
  '- первый пункт;',
  '- второй пункт.',
  '',
  'Inline: `N`, `256`, `ru108.v1`, `Focus(Ω)`.',
  '',
  '```text',
  'A = 10',
  'B = 01',
  String.raw`literal $ _ \ = **`,
  '```',
  '',
  '> Цитата.',
  '',
  '---'
].join('\n');

const markdownContract = createDocumentFromMarkdown(markdownContractSource, 'contract.md');
const contractDocument = markdownContract.document;
const contractMath = collectMathBlocks(contractDocument);
assert.equal(contractDocument.rawSource, markdownContractSource, 'rawSource must preserve the exact Markdown source');
assert.equal(contractDocument.rawImports[0].plain, markdownContractSource, 'raw import must remain exact');
assert.deepEqual(
  contractMath.map((block) => block.latexOriginal),
  ['X', '\nP(P(X))=X.\n', String.raw`P_{10}`, 'Y'],
  'Markdown must never receive or modify LaTeX payloads'
);
assert.ok(contractMath.every((block) => block.latexOriginal === block.latexCurrent));
assert.ok(contractMath.every((block) => block.hashOriginal === sha256(block.latexCurrent)));

const contractTypes = contractDocument.blocks.map((block) => block.type);
assert.ok(contractTypes.includes('heading'));
assert.ok(contractTypes.includes('list'));
assert.ok(contractTypes.includes('code'));
assert.ok(contractTypes.includes('quote'));
assert.ok(contractTypes.includes('hr'));

const contractTextSegments = contractDocument.blocks.flatMap((block) => [
  ...(block.segments || []),
  ...(block.items || []).flatMap((item) => item.segments || [])
]).filter((segment) => segment.type === 'text');
assert.ok(contractTextSegments.some((segment) => segment.bold && segment.text === 'Жирный текст'));
assert.deepEqual(
  contractTextSegments.filter((segment) => segment.code).map((segment) => segment.text),
  ['N', '256', 'ru108.v1', 'Focus(Ω)'],
  'inline code must be stored without backticks'
);
const boldFormulaParagraph = contractDocument.blocks.find((block) =>
  block.type === 'paragraph'
  && (block.segments || []).some((segment) => segment.type === 'math' && segment.latexOriginal === 'Y')
);
assert.ok(boldFormulaParagraph, 'formula inside bold Markdown must remain an atomic math segment');
assert.ok(boldFormulaParagraph.segments.filter((segment) => segment.type === 'text').every((segment) => segment.bold));
assert.equal(boldFormulaParagraph.segments.find((segment) => segment.type === 'math').bold, undefined);

const fencedBlock = contractDocument.blocks.find((block) => block.type === 'code');
assert.equal(fencedBlock.language, 'text');
assert.equal(fencedBlock.text, String.raw`A = 10
B = 01
literal $ _ \ = **`);
assert.doesNotMatch(fencedBlock.text, /```/);
assert.equal(markdownContract.formulas.length, 4, 'dollar and other symbols inside fenced code must stay literal');

const savedMarkdownContract = JSON.stringify(contractDocument);
const reopenedMarkdownContract = JSON.parse(savedMarkdownContract);
assert.equal(roundTripDocument(reopenedMarkdownContract).ok, true);
const copiedMarkdownContract = serializeForAI(reopenedMarkdownContract);
assert.match(copiedMarkdownContract, /```text\nA = 10\nB = 01/);
assert.match(copiedMarkdownContract, /`Focus\(Ω\)`/);
assert.ok(copiedMarkdownContract.includes(String.raw`**Для \(Y\) выполняется**`));
const reimportedMarkdownContract = createDocumentFromMarkdown(copiedMarkdownContract, 'contract-reimport.md');
assert.deepEqual(
  collectMathBlocks(reimportedMarkdownContract.document).map((block) => block.latexOriginal),
  contractMath.map((block) => block.latexOriginal),
  'IMPORT → SAVE → OPEN → COPY → REIMPORT must preserve every LaTeX string'
);
assert.equal(roundTripDocument(reimportedMarkdownContract.document).ok, true);
assert.ok(reimportedMarkdownContract.document.blocks.some((block) => block.type === 'heading'));
assert.ok(reimportedMarkdownContract.document.blocks.some((block) => block.type === 'code'));

const markdownDisabled = createDocumentFromMarkdown(markdownContractSource, 'contract-off.md', { markdownEnabled: false });
const disabledText = markdownDisabled.document.blocks.flatMap((block) => block.segments || [])
  .filter((segment) => segment.type === 'text')
  .map((segment) => segment.text)
  .join('\n');
assert.match(disabledText, /# Заголовок/);
assert.match(disabledText, /\*\*Жирный текст\*\*/);
assert.match(disabledText, /`N`/);
assert.match(disabledText, /```text/);
assert.ok(!markdownDisabled.document.blocks.some((block) => ['heading', 'list', 'quote', 'hr', 'code'].includes(block.type)));
assert.deepEqual(
  collectMathBlocks(markdownDisabled.document).map((block) => block.latexOriginal),
  contractMath.map((block) => block.latexOriginal),
  'feature flag OFF must change only text presentation, never formula data'
);
assert.equal(roundTripDocument(markdownDisabled.document).ok, true);

const additionalRegressionFormulas = [
  String.raw`M_{n+2}=100M_n+45S_n^{stat}`,
  String.raw`R(C_{10}(X))=C_{10}(R(X))=C_{10}(X)`,
  String.raw`P(X)=
\begin{cases}
R(X), & X\neq R(X),\\[4pt]
I(X), & X=R(X).
\end{cases}`,
  String.raw`S(n)=2^{\lfloor n/2\rfloor}`,
  String.raw`P=1+\sum_{i=0}^{M-1}d_iN^{M-1-i}`,
  String.raw`d_i=
\left\lfloor
\frac{P-1}{N^{M-1-i}}
\right\rfloor
\bmod N`
];
const additionalRegressionSource = additionalRegressionFormulas
  .map((formula) => `\\[${formula}\\]`)
  .join('\n\n');
const additionalRegressionDocument = createDocumentFromMarkdown(additionalRegressionSource, 'regression.md').document;
assert.deepEqual(
  collectMathBlocks(additionalRegressionDocument).map((block) => block.latexOriginal),
  additionalRegressionFormulas
);
assert.equal(roundTripDocument(additionalRegressionDocument).ok, true);

console.log(`OK: ${REQUIRED_FORMULAS.length} обязательных формул, Markdown-контракт и все round-trip проверки пройдены.`);
