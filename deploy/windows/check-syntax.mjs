#!/usr/bin/env node
/**
 * deploy/windows 静态自检器（纯 Node，零依赖）。
 *
 * 为什么需要它：本项目的开发/CI 环境是 Linux，**没有 pwsh**，deploy/windows 下的 .ps1
 * 无法在真实 PowerShell 上执行。所以这里用 Node 做一层「不执行也能发现低级错误」的
 * 静态检查，至少挡住三类最容易犯、又最难在 Windows 上肉眼发现的错：
 *
 *   1. 引号 / 括号不配对（PS 5.1 报错信息很差，常常只说「缺少 }」不指位置）；
 *   2. 必需参数没声明（比如 install.ps1 少了 -RepoRoot，计划任务就会拿到空路径）；
 *   3. 调用了不存在的 qq-archive 子命令或 CLI 不认识的选项（脚本看上去很对，
 *      跑起来直接退出码 2）。
 *
 * 它**不是** PowerShell 语法分析器：不解析 AST，不理解 here-string 的语义，
 * 也无法替代真机执行。判定能力边界见文件末尾的「已知局限」注释。
 *
 * 用法：
 *   node deploy/windows/check-syntax.mjs
 *   node deploy/windows/check-syntax.mjs --verbose
 *   node deploy/windows/check-syntax.mjs --json
 *   node deploy/windows/check-syntax.mjs --file install.ps1     # 只查一个（可重复）
 *
 * 退出码：0 = 全部通过；1 = 存在失败项。
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

/* ------------------------------------------------------------------ */
/* 一、期望清单                                                        */
/* ------------------------------------------------------------------ */

/** 必需存在的文件。params 为 null 表示「允许没有 param()」。 */
const EXPECTED_FILES = [
  {
    file: 'install.ps1',
    params: [
      'Action', 'ConfigPath', 'RepoRoot', 'InstallPath',
      'TaskName', 'ServeTaskName', 'CollectIntervalMinutes',
      'MinNodeMajor', 'KeepCollectLogs', 'KeepServeLogs', 'RunAsSystem',
    ],
  },
  {
    file: 'uninstall.ps1',
    params: [
      'RepoRoot', 'TaskName', 'ServeTaskName', 'PurgeData', 'KeepData', 'Force',
    ],
  },
  {
    file: 'status.ps1',
    params: [
      'RepoRoot', 'ConfigPath', 'TaskName', 'ServeTaskName', 'TailLines',
    ],
  },
  {
    file: 'run-collect.ps1',
    params: ['RepoRoot', 'ConfigPath', 'KeepLogs', 'DryRun'],
  },
  {
    file: 'run-serve.ps1',
    params: ['RepoRoot', 'ConfigPath', 'KeepLogs', 'DryRun'],
  },
];

/** qq-archive 真实存在的子命令（取自 apps/cli/src/main.ts 的 usage() 与 switch）。 */
const CLI_COMMANDS = [
  'serve', 'import', 'collect', 'backup', 'restore',
  'verify', 'login', 'doctor', 'token', 'stats', 'logs',
];

/** 各子命令真实支持的选项（取自 apps/cli/src/main.ts 的 usage()）。 */
const CLI_FLAGS = {
  serve: ['host', 'port'],
  import: ['account', 'format', 'limit', 'no-media'],
  collect: ['once'],
  backup: ['no-verify', 'label'],
  restore: ['apply'],
  verify: [],
  login: ['list', 'uin', 'no-wait', 'timeout'],
  doctor: [],
  token: [],
  stats: [],
  logs: ['limit'],
  // 可放在任意命令前后的全局选项
  '*': ['config', 'help', 'h', 'version', 'V'],
};

/** 简写的单连字符 flag（parseArgs 把它们存进同一个 flags 表）。 */
const SHORT_FLAGS = { h: 'help', V: 'version' };

/* ------------------------------------------------------------------ */
/* 二、PowerShell 词法扫描（注释 / 引号 / here-string 感知）           */
/* ------------------------------------------------------------------ */

const BACKTICK = String.fromCharCode(96);

/**
 * 逐行扫描一个 .ps1 文件，剥离注释与字符串内容，统计配对符号。
 *
 * 返回：
 *   balances  { cur, par, brk }  三类定界符的净差值（应全为 0）
 *   quotes    { single, double } 单/双引号是否留在了「开启」状态
 *   issues    string[]           扫描过程中发现的问题
 *   hereStrings { single, double } here-string 是否未闭合
 *   paramsText string            去掉注释与字符串后、供 param() 检测用的全文
 *   raw       string
 */
function scanPowerShell(raw) {
  const issues = [];
  let state = 'code'; // code | single | double | lineComment | blockComment | hereSingle | hereDouble
  let pendingStringStart = 0;
  const balances = { cur: 0, par: 0, brk: 0 };
  const quoteCounts = { single: 0, double: 0 };
  const hereCounts = { single: 0, double: 0 };
  const codeChars = [];
  const lines = raw.split(/\r?\n/);

  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = lines[lineNo];
    const lineStartState = state;
    let openBlockDepth = 0;

    // here-string 的结束定界符必须在行首（前面只允许空白）。
    if (state === 'hereSingle' || state === 'hereDouble') {
      const closer = state === 'hereSingle' ? "'@" : '"@';
      if (line.trimStart().startsWith(closer)) {
        state = 'code';
        hereCounts[state === 'hereSingle' ? 'single' : 'double']++;
        const rest = line.trimStart().slice(2);
        codeChars.push(rest);
        scanCodeFragment(rest, lineNo + 1, openBlockDepth);
      } else {
        codeChars.push('');
      }
      if (lineStartState === 'hereSingle' || lineStartState === 'hereDouble') {
        // 整个物理行都在 here-string 里，除结束行外不做符号统计。
        if (state === 'hereSingle' || state === 'hereDouble') { /* 仍未闭合 */ }
      }
      continue;
    }

    let i = 0;
    while (i < line.length) {
      const ch = line[i];

      if (state === 'code') {
        // 行尾续行符：跳过，它只影响「本行是否算结束」，不影响配对统计。
        if (ch === BACKTICK) { i += 2; continue; }

        if (ch === '<' && line[i + 1] === '#') { state = 'blockComment'; i += 2; continue; }
        if (ch === '#') { state = 'lineComment'; break; }

        if (ch === '@' && (line[i + 1] === "'" || line[i + 1] === '"')) {
          const kind = line[i + 1];
          const rest = line.slice(i + 2);
          if (rest.trim() === '') {
            state = kind === "'" ? 'hereSingle' : 'hereDouble';
            if (kind === "'") { hereCounts.single++; } else { hereCounts.double++; }
            i = line.length;
            continue;
          }
          // `@"` / `@'` 不是行末 → 不是 here-string（可能是 `@'x'` 之类的奇怪写法），
          // 当作普通字符继续，后面的引号处理会接管。
        }

        if (ch === "'") { state = 'single'; quoteCounts.single++; pendingStringStart = lineNo + 1; i++; continue; }
        if (ch === '"') { state = 'double'; quoteCounts.double++; pendingStringStart = lineNo + 1; i++; continue; }

        if (ch === '{') { balances.cur++; openBlockDepth++; i++; continue; }
        if (ch === '}') { balances.cur--; openBlockDepth--; i++; continue; }
        if (ch === '(') { balances.par++; i++; continue; }
        if (ch === ')') { balances.par--; i++; continue; }
        if (ch === '[') { balances.brk++; i++; continue; }
        if (ch === ']') { balances.brk--; i++; continue; }

        codeChars.push(ch);
        i++;
        continue;
      }

      if (state === 'single') {
        codeChars.push('');
        if (ch === "'") {
          if (line[i + 1] === "'") { i += 2; continue; } // '' → 转义的单引号
          state = 'code'; quoteCounts.single++;
        }
        i++;
        continue;
      }

      if (state === 'double') {
        codeChars.push('');
        if (ch === BACKTICK) { i += 2; continue; } // `" → 转义
        if (ch === '$' && line[i + 1] === '(') {
          // $(...) 子表达式允许嵌套，这里只做计数不切状态，风险极低。
          i += 2; continue;
        }
        if (ch === '"') { state = 'code'; quoteCounts.double++; }
        i++;
        continue;
      }

      if (state === 'lineComment') { break; }

      if (state === 'blockComment') {
        codeChars.push('');
        if (ch === '#' && line[i + 1] === '>') { state = 'code'; i += 2; continue; }
        i++;
        continue;
      }
    }

    // 逐字符扫描不带换行，而 `param(` 恰恰只在「行首」或「空白之后」才合法。
    // 不补回换行，`#>` 与 `param(` 会拼成 `#>param(`，参数块存在也会被判「未找到」。
    codeChars.push('\n');

    if (state === 'lineComment') { state = 'code'; }

    // 赋值语句的块（`$x = @{` / `$x = [`）跨行是合法的；普通代码行结束时若还有
    // 未闭合的 `{`，PowerShell 会报「意外的 token」——这里只报告，不阻断。
    if (state === 'code' && openBlockDepth > 0 && !/[={[]\s*$/.test(line.trimEnd()) && !/[={[]$/.test(line.trimEnd())) {
      issues.push(`第 ${lineNo + 1} 行：花括号 { 未在行内闭合（如果这是跨行赋值 @{ / [，可忽略）`);
    }
  }

  if (state === 'single' || state === 'double') {
    issues.push(`第 ${pendingStringStart} 行开始的${state === 'single' ? '单' : '双'}引号没有闭合`);
  }
  if (state === 'hereSingle' || state === 'hereDouble') {
    issues.push('here-string（@\'…\'@ / @"…"@）没有闭合');
  }
  if (state === 'blockComment') {
    issues.push('块注释 <# … #> 没有闭合');
  }

  return {
    balances,
    issues,
    hereCounts,
    quoteCounts,
    // codeChars 是**逐字符**累加的（见上面 code 分支的 `codeChars.push(ch)`），
    // 所以必须用空串连接还原成完整文本；用 '\n' 会把每个字符都拆到独立一行。
    paramsText: codeChars.join(''),
    raw,
  };
}

/** 极简的代码片段扫描（here-string 结束行之后可能还有代码）。 */
function scanCodeFragment(_fragment, _lineNo, _depth) {
  // 这些代码片段本身不参与配对统计（已在 scanPowerShell 主体里统计过），
  // 保留函数是为了让未来的扩展（比如结束行后跟 `$x`）有落脚点。
}

/* ------------------------------------------------------------------ */
/* 三、检查项                                                          */
/* ------------------------------------------------------------------ */

/** 从脚本里抽出实际调用的 qq-archive 子命令与选项，验证它们真实存在。 */
function extractCliUsage(text) {
  const found = [];
  const errors = [];

  // 匹配数组字面量里的调用，例如：
  //   @('--config', $config, 'collect', '--once')
  //   @('--config', $ConfigFullPath, 'serve')
  const arrayPattern = /@\(([^)]*)\)/g;
  let m;
  while ((m = arrayPattern.exec(text)) !== null) {
    const body = m[1];
    const tokens = [];
    const tokenPattern = /'([^']*)'|"([^"]*)"/g;
    let t;
    while ((t = tokenPattern.exec(body)) !== null) {
      tokens.push(t[1] !== undefined ? t[1] : t[2]);
    }
    if (tokens.length === 0) continue;

    const commandIndex = tokens.findIndex((x) => CLI_COMMANDS.includes(x));
    if (commandIndex === -1) {
      // 也可能是 `@('--config', $x, 'collect', '--once')` 里命令在变量之后，
      // 只有在存在其它 qq-archive 选项时才报「未知命令」。
      const onlyFlags = tokens.every((x) => x.startsWith('-'));
      if (!onlyFlags) continue;
      errors.push(`数组字面量里找不到已知子命令：@(${body.trim()})`);
      continue;
    }

    const command = tokens[commandIndex];
    found.push(command);
    const allowed = new Set([
      ...(CLI_FLAGS[command] ?? []),
      ...CLI_FLAGS['*'],
      ...Object.values(SHORT_FLAGS),
    ]);

    for (let k = commandIndex + 1; k < tokens.length; k++) {
      const tok = tokens[k];
      if (!tok.startsWith('--')) continue;
      const name = tok.slice(2);
      if (!allowed.has(name)) {
        errors.push(`子命令 ${command} 使用了 CLI 不认识的选项 --${name}`);
      }
    }
  }

  return { found, errors };
}

/** 检查脚本引用的 .ps1 是否存在（只认明确写出来的文件名）。 */
function checkReferencedScripts(relFile, text) {
  const errors = [];
  const refs = new Set();
  const pattern = /['"]([A-Za-z0-9-]+\.ps1)['"]/g;
  let m;
  while ((m = pattern.exec(text)) !== null) {
    refs.add(m[1]);
  }
  for (const ref of refs) {
    const full = join(HERE, ref);
    try {
      readFileSync(full);
    } catch {
      errors.push(`引用了不存在的脚本：${ref}`);
    }
  }
  return errors;
}

/** 检查「禁止在 .ps1 里硬编码绝对路径」。 */
function checkHardcodedAbsolutePath(relFile, text) {
  const errors = [];
  const bad = [
    /[A-Za-z]:\\\\(?!\\)/g, // C:\\ 这种双反斜杠写法（Windows 上不成立，多半是笔误）
    /(^|[^-\w])[A-Za-z]:\\Users\\/g, // C:\Users\...
    /(^|[^-\w])[A-Za-z]:\\opt\\/g,
  ];
  for (const re of bad) {
    const hit = text.match(re);
    if (hit) {
      errors.push(`疑似硬编码的绝对路径：${hit[0].trim()}`);
    }
  }
  return errors;
}

/** 检查 PowerShell 7+ 专属语法是否被误用（必须兼容 5.1）。 */
function checkPs51Compatibility(text) {
  const errors = [];
  if (/\?\?/.test(text)) {
    errors.push('使用了 PowerShell 7+ 的空合并运算符 ?? （5.1 不支持）');
  }
  if (/\?\s*:/.test(text) && !/:\s*\?/.test(text)) {
    // 三元运算符 `$a ? $b : $c`；排除哈希表 `@{a = $x ? ...}` 的场景很难，
    // 所以只在明显形态（? 两侧是变量、且没有引号包裹）时告警。
    const ternary = /(\(|\s)(\$[\w.:]+|\d+)\s*\?\s*[^:\n]+\s*:\s*[^=\n]+/.exec(text);
    if (ternary) {
      errors.push(`疑似 PowerShell 7+ 三元运算符 ?: （5.1 不支持）：${ternary[0].trim().slice(0, 60)}`);
    }
  }
  if (/\s-Parallel\b/.test(text)) {
    errors.push('使用了 PowerShell 7+ 的 -Parallel（5.1 不支持）');
  }
  if (/\bForEach-Object\s+-Parallel\b/.test(text)) {
    errors.push('使用了 ForEach-Object -Parallel（5.1 不支持）');
  }
  return errors;
}

/* ------------------------------------------------------------------ */
/* 四、主流程                                                          */
/* ------------------------------------------------------------------ */

function checkFile(entry, verbose) {
  const path = join(HERE, entry.file);
  const checks = [];
  const push = (name, ok, detail) => checks.push({ name, ok, detail: detail ?? '' });

  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return {
      file: entry.file,
      missing: true,
      checks: [{ name: '文件存在', ok: false, detail: `找不到 ${path}` }],
      scan: null,
    };
  }

  const scan = scanPowerShell(raw);

  // 0) 编码：Windows PowerShell 5.1 对「无 BOM 的 UTF-8」按系统 ANSI 代码页解码，
  //    脚本里的中文注释/中文字符串会变成乱码，甚至因为引号被拆开而直接语法报错。
  //    所以 .ps1 必须带 UTF-8 BOM（EF BB BF）。可用 `node check-syntax.mjs --fix-bom` 补。
  const hasBom = raw.startsWith('\uFEFF');
  push('UTF-8 BOM（PowerShell 5.1 中文必需）', hasBom,
    hasBom ? '' : '缺少 BOM：Windows PowerShell 5.1 会把中文按 ANSI 解码，运行 --fix-bom 补上');

  // 1) 定界符配对
  push('大括号 {} 配对', scan.balances.cur === 0, `净差值 ${scan.balances.cur}`);
  push('圆括号 () 配对', scan.balances.par === 0, `净差值 ${scan.balances.par}`);
  push('方括号 [] 配对', scan.balances.brk === 0, `净差值 ${scan.balances.brk}`);

  // 2) 引号闭合
  push('单引号闭合', scan.quoteCounts.single % 2 === 0, `出现 ${scan.quoteCounts.single} 次`);
  push('双引号闭合', scan.quoteCounts.double % 2 === 0, `出现 ${scan.quoteCounts.double} 次`);
  push('here-string 闭合', scan.hereCounts.single % 2 === 0 && scan.hereCounts.double % 2 === 0,
    `单引号型 ${scan.hereCounts.single} 次 / 双引号型 ${scan.hereCounts.double} 次`);

  // 3) 扫描过程发现的问题
  push('词法扫描无告警', scan.issues.length === 0, scan.issues.join('；'));

  // 4) param() 声明
  if (entry.params === null || entry.params === undefined) {
    push('param() 声明', true, '本文件不要求参数块');
  } else {
    // 扫描器**丢弃定界符**（`(` / `)` / `[` / `]` / `{` / `}` 只做配对统计，不进 paramsText），
    // 所以这里不能要求 `param` 后面跟着 `(`；只认「独立的 param 词」即可，
    // 同时用 `[^\w$]` 排除 `$param` 这类变量名。
    const hasParam = /(^|[^\w$])param\b/.test(scan.paramsText);
    push('存在 param() 参数块', hasParam, hasParam ? '' : '未找到 param( 声明');

    const missing = [];
    for (const name of entry.params) {
      const re = new RegExp('\\$' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
      if (!re.test(scan.paramsText)) missing.push(name);
    }
    push(`必需参数已声明（${entry.params.length} 个）`, missing.length === 0,
      missing.length ? `缺少 ${missing.join(', ')}` : '');
  }

  // 5) qq-archive 调用合法性
  const cli = extractCliUsage(scan.paramsText);
  push('qq-archive 调用合法', cli.errors.length === 0, cli.errors.join('；'));
  if (verbose && cli.found.length) {
    push('实际调用的子命令', true, cli.found.join(', '));
  }

  // 6) 引用的其它脚本存在
  const refErrors = checkReferencedScripts(entry.file, raw);
  push('引用的脚本存在', refErrors.length === 0, refErrors.join('；'));

  // 7) 无硬编码绝对路径
  const absErrors = checkHardcodedAbsolutePath(entry.file, raw);
  push('无硬编码绝对路径', absErrors.length === 0, absErrors.join('；'));

  // 8) PowerShell 5.1 兼容性
  const psErrors = checkPs51Compatibility(scan.paramsText);
  push('兼容 PowerShell 5.1', psErrors.length === 0, psErrors.join('；'));

  return { file: entry.file, missing: false, checks, scan };
}

/**
 * 检查必需文件清单之外的散落文件：deploy/windows 下不允许出现未登记的 .ps1
 * （防止有人加了脚本却忘了写进 EXPECTED_FILES，从而绕过参数检查）。
 */
function checkStrayFiles() {
  const errors = [];
  let names = [];
  try {
    names = readdirSync(HERE);
  } catch {
    return ['无法读取 deploy/windows 目录'];
  }
  const known = new Set(EXPECTED_FILES.map((e) => e.file));
  known.add('README.md');
  known.add('check-syntax.mjs');
  for (const name of names) {
    if (name.endsWith('.ps1') && !known.has(name)) {
      errors.push(`发现未登记在 EXPECTED_FILES 里的脚本：${name}（请加入检查清单）`);
    }
  }
  return errors;
}

/** 校验 README.md 是否覆盖了必需章节。 */
function checkReadme() {
  const checks = [];
  let text = '';
  try {
    text = readFileSync(join(HERE, 'README.md'), 'utf8');
  } catch {
    return [{ name: 'README.md 存在', ok: false, detail: '找不到 README.md' }];
  }

  const topics = [
    { name: '安装步骤', re: /安装/ },
    { name: '升级步骤', re: /升级/ },
    { name: '卸载步骤', re: /卸载/ },
    { name: '验证步骤', re: /验证/ },
    { name: '已验证 / 未验证说明', re: /已验证[\s\S]*未验证|未验证[\s\S]*已验证/ },
    { name: '计划任务工作目录坑点', re: /工作目录/ },
    { name: 'ExecutionPolicy 坑点', re: /ExecutionPolicy/i },
    { name: '网络驱动器坑点', re: /映射的网络驱动器|网络驱动器/ },
    { name: '路径含空格', re: /空格/ },
    { name: '注销后作业停止', re: /注销/ },
  ];
  for (const t of topics) {
    checks.push({ name: `README 覆盖「${t.name}」`, ok: t.re.test(text), detail: '' });
  }
  return checks;
}

/**
 * --fix-bom：给缺少 UTF-8 BOM 的 .ps1 补上（幂等：已有 BOM 的文件一个字节都不动）。
 * 返回 { fixed: string[], already: string[] }。
 */
function fixBom() {
  const fixed = [];
  const already = [];
  for (const entry of EXPECTED_FILES) {
    if (!entry.file.endsWith('.ps1')) continue;
    const file = join(HERE, entry.file);
    let bytes;
    try {
      bytes = readFileSync(file);
    } catch {
      continue;
    }
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      already.push(entry.file);
      continue;
    }
    writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]));
    fixed.push(entry.file);
  }
  return { fixed, already };
}

function main() {
  const argv = process.argv.slice(2);
  const verbose = argv.includes('--verbose') || argv.includes('-v');
  const asJson = argv.includes('--json');
  const fix = argv.includes('--fix-bom');

  if (fix) {
    const { fixed, already } = fixBom();
    for (const f of fixed) console.log(`已补 BOM：${f}`);
    for (const f of already) console.log(`已有 BOM：${f}`);
    console.log(`\n补 BOM 完成：新增 ${fixed.length} 个，跳过 ${already.length} 个（幂等，可重复跑）。`);
    process.exit(0);
  }

  const only = [];
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--file' || argv[i] === '-f') && argv[i + 1]) {
      only.push(argv[i + 1]);
      i++;
    }
  }

  const targets = EXPECTED_FILES.filter((e) => only.length === 0 || only.includes(e.file));
  const results = targets.map((e) => checkFile(e, verbose));
  const strayErrors = only.length === 0 ? checkStrayFiles() : [];
  const readmeChecks = only.length === 0 ? checkReadme() : [];

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ repo: REPO_ROOT, dir: HERE, results, strayErrors, readmeChecks }, null, 2)}\n`);
    const failed = results.some((r) => r.missing || r.checks.some((c) => !c.ok)) ||
      strayErrors.length > 0 || readmeChecks.some((c) => !c.ok);
    process.exit(failed ? 1 : 0);
  }

  const line = '='.repeat(66);
  console.log(line);
  console.log('QQ 归档系统 · deploy/windows 静态自检（纯 Node，零依赖）');
  console.log(`目录: ${HERE}`);
  console.log(`仓库: ${REPO_ROOT}`);
  console.log(`Node: ${process.version}`);
  console.log(line);

  let total = 0;
  let failed = 0;

  for (const r of results) {
    console.log('');
    if (r.missing) {
      console.log(`[缺失] ${r.file}`);
      for (const c of r.checks) {
        console.log(`   ✗ ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
        total++;
        failed++;
      }
      continue;
    }

    const bad = r.checks.filter((c) => !c.ok);
    const mark = bad.length === 0 ? 'OK  ' : 'FAIL';
    console.log(`[${mark}] ${r.file}  （${r.checks.length} 项检查，${bad.length} 项失败）`);
    const lines = r.scan.raw.split(/\r?\n/).length;
    console.log(`       行数 ${lines}｜大括号净差 ${r.scan.balances.cur}｜圆括号净差 ${r.scan.balances.par}｜方括号净差 ${r.scan.balances.brk}`);
    for (const c of r.checks) {
      total++;
      if (c.ok) {
        if (verbose) console.log(`   ✓ ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
      } else {
        failed++;
        console.log(`   ✗ ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
      }
    }
  }

  if (strayErrors.length > 0 || readmeChecks.length > 0) {
    console.log('');
    console.log('-- 清单与文档 --');
    for (const e of strayErrors) {
      total++;
      failed++;
      console.log(`   ✗ ${e}`);
    }
    for (const c of readmeChecks) {
      total++;
      if (c.ok) {
        if (verbose) console.log(`   ✓ ${c.name}`);
      } else {
        failed++;
        console.log(`   ✗ ${c.name}`);
      }
    }
    if (readmeChecks.length > 0 && readmeChecks.every((c) => c.ok)) {
      console.log(`   ✓ README.md 覆盖全部 ${readmeChecks.length} 个必需章节`);
    }
  }

  console.log('');
  console.log(line);
  console.log(`总计 ${total} 项检查，失败 ${failed} 项。`);
  console.log(failed === 0
    ? '结论：静态自检全部通过。（注意：这不等于脚本能在真实 PowerShell 上跑通。）'
    : '结论：存在失败项，请修正后重跑。');
  console.log(line);

  process.exit(failed === 0 ? 0 : 1);
}

main();

/* ------------------------------------------------------------------ */
/* 已知局限（必须如实告知，不要把它当成「脚本已验证」）                 */
/* ------------------------------------------------------------------ */
/*
 * 本检查器做不到的事情：
 *   1. 不解析 PowerShell AST，不能发现「参数名拼错但语法合法」「cmdlet 名字写错」
 *      「-Action Install 之外的分支语法错」这类问题；
 *   2. 不校验 cmdlet 参数（例如 New-ScheduledTaskSettingsSet -RestartCount 是否
 *      在当前 Windows 版本存在）；
 *   3. 不理解 here-string 的语义，只在行首匹配结束定界符；
 *   4. 不检查 Windows 特有行为（计划任务权限、路径长度上限、执行策略）；
 *   5. 引号/括号计数是启发式的：如果字符串里出现未转义的同类引号（PowerShell 里
 *      必须用 '' 或 `" 转义），会误报或漏报。
 *
 * 真正的验证必须在 Windows 上用 Windows PowerShell 5.1 跑一遍，见 README.md
 * 的「验证」与「已验证 / 未验证」两节。
 */
