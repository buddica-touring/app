const fs = require('fs');
const babel = require('@babel/core');

// ★2026-10-17 オーナー指示（受け渡し箱0020/0021）: タスク保存の「戻らない試験」16項目を毎回流し、NGならビルドを止める（app.js を書かない）
{
  const { spawnSync } = require('child_process');
  const t = spawnSync(process.execPath, ['tests/task_save_test.js', 'index.html.bak'], { encoding: 'utf8' });
  const last = String(t.stdout || '').trim().split('\n').pop();
  if (t.status !== 0) {
    console.error(t.stdout || ''); console.error(t.stderr || '');
    console.error('❌ タスク保存の戻らない試験が NG のためビルドを中止しました（tests/task_save_test.js）');
    process.exit(1);
  }
  console.log(last);
}

// ★ index.html.bak（JSXソース）から <script type="text/babel"> を抽出
const src = fs.readFileSync('index.html.bak', 'utf8');
const match = src.match(/<script type="text\/babel">([\s\S]*?)<\/script>/);
if (!match) { console.error('text/babel block not found in index.html.bak'); process.exit(1); }

const jsx = match[1];
console.log(`JSX source: ${(jsx.length/1024).toFixed(0)}KB`);

// ★ Babel compile (JSX → JS)
const result = babel.transformSync(jsx, {
  presets: ['@babel/preset-react'],
});
console.log(`Compiled JS: ${(result.code.length/1024).toFixed(0)}KB`);

// ★ app.js に書き出し
fs.writeFileSync('app.js', result.code);
console.log('app.js written');

// ★ terser圧縮（利用可能なら）
try {
  const { execSync } = require('child_process');
  execSync('npx terser app.js --compress passes=3,pure_getters=true --mangle toplevel=true --output app.js', { stdio: 'inherit' });
  const sz = fs.statSync('app.js').size;
  console.log(`Minified app.js: ${(sz/1024).toFixed(0)}KB`);
} catch(e) {
  console.warn('terser not available, using unminified app.js');
}

console.log('✅ Build complete');
