'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
if (process.platform !== 'darwin') throw new Error('Сборка запускается на macOS');
const root = path.resolve(__dirname, '..');
const binary = process.argv[2] || require('electron');
const source = path.resolve(binary, '../../..');
const filename=process.argv[3] || 'LaTEX Math Tenetko.app';
if(path.basename(filename)!==filename || !filename.endsWith('.app')) throw Error('Укажите только имя сборки .app, без пути');
const output = path.join(root, 'dist', filename);
fs.mkdirSync(path.dirname(output), { recursive: true });
if (fs.existsSync(output)) {
  const identity = cp.execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', path.join(output, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
  if (identity !== 'org.natenetko.math-editor') throw new Error('В папке сборки находится другое приложение');
} else cp.execFileSync('/usr/bin/ditto', [source, output]);
const target = path.join(output, 'Contents', 'Resources', 'app');
fs.mkdirSync(target, { recursive: true });
for (const name of ['index.html', 'app.js', 'styles.css', 'pagination.js', 'pdf-styles.js', 'speech-adapter.js', 'article-reader.js', 'media-export.js', 'audio-draft.js', 'reader.css', 'mathjax.js', 'MATHJAX-LICENSE.txt', 'package.json', 'desktop']) {
  fs.cpSync(path.join(root, name), path.join(target, name), { recursive: true });
}
const plist = path.join(output, 'Contents', 'Info.plist');
for (const [key, value] of Object.entries({
  CFBundleDisplayName: 'LaTEX Math Tenetko', CFBundleName: 'LaTEX Math Tenetko',
  CFBundleIdentifier: 'org.natenetko.math-editor', CFBundleShortVersionString: '1.6.3', CFBundleVersion: '1.6.3'
})) cp.execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
// Local ad-hoc signature. Distribution notarization requires the author's Apple account.
cp.execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', output]);
console.log(output);
