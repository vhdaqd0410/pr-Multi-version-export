/* global require, CSInterface, console */
(function () {
  // Node 环境检查（CEP --enable-nodejs）
  var fs, os, path;
  try {
    fs = require('fs');
    os = require('os');
    path = require('path');
  } catch (e) {
    document.body.innerHTML =
      '<div style="color:#f66;padding:20px;font:14px Microsoft YaHei">' +
      '<h3>面板加载失败</h3><p>Node.js 环境不可用，请确认已开启 CEP 调试模式并重启 Premiere Pro。</p>' +
      '<p style="color:#888;font-size:12px">' + e.message + '</p></div>';
    return;
  }

  var csInterface = new CSInterface();
  function evalHost(s) { return new Promise(function (r) { csInterface.evalScript(s, r); }); }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // ── UI 元素 ──────────────────────────────────
  var seqList = document.getElementById('seq-list');
  var btnSelAll = document.getElementById('btn-sel-all');
  var btnSelNone = document.getElementById('btn-sel-none');
  var dirCaption = document.getElementById('dir-caption');
  var dirNoCaption = document.getElementById('dir-no-caption');
  var dirNoMusic = document.getElementById('dir-no-music');
  var presetCaption = document.getElementById('preset-caption');
  var presetNoCaption = document.getElementById('preset-no-caption');
  var keepMode = document.getElementById('keep-mode');
  var keepCountRow = document.getElementById('keep-count-row');
  var keepCountEl = document.getElementById('keep-count');
  var keepListRow = document.getElementById('keep-list-row');
  var keepListEl = document.getElementById('keep-list');
  var log = document.getElementById('log');
  var btnGo = document.getElementById('btn-go');
  var btnStop = document.getElementById('btn-stop');
  var btnRefresh = document.getElementById('btn-refresh');
  var statusDot = document.getElementById('status-dot');
  var progressArea = document.getElementById('progress-area');
  var progressFill = document.getElementById('progress-fill');
  var progressPct = document.getElementById('progress-pct');
  var progressTime = document.getElementById('progress-time');
  var progressState = document.getElementById('progress-state');

  // 停止控制
  var stopRequested = false;

  function setLog(msg, isErr) {
    var line = document.createElement('div');
    line.className = isErr ? 'log-line err' : 'log-line';
    line.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }
  function setBusy(b) {
    btnGo.disabled = b;
    btnStop.disabled = !b;
    statusDot.className = b ? 'dot busy' : 'dot on';
  }
  function fmtTime(sec) {
    sec = Math.max(0, Math.round(sec));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    function pad(x) { return x < 10 ? '0' + x : '' + x; }
    if (h > 0) return h + ':' + pad(m) + ':' + pad(s);
    return pad(m) + ':' + pad(s);
  }
  function setProgress(pct, stateText, elapsedSec, remainSec) {
    pct = Math.max(0, Math.min(100, pct));
    progressFill.style.width = pct + '%';
    progressPct.textContent = Math.round(pct) + '%';
    if (stateText) progressState.textContent = stateText;
    var t = '已用 ' + fmtTime(elapsedSec || 0);
    if (remainSec !== undefined && remainSec !== null) t += ' · 预计剩余 ' + fmtTime(remainSec);
    progressTime.textContent = t;
  }

  // ── 扫描 AME 预设目录 ─────────────────────────
  function scanPresets() {
    var presets = [];
    var ameRoot = path.join(os.homedir(), 'Documents', 'Adobe', 'Adobe Media Encoder');
    if (fs.existsSync(ameRoot)) {
      try {
        fs.readdirSync(ameRoot).forEach(function (v) {
          var pdir = path.join(ameRoot, v, 'Presets');
          if (!fs.existsSync(pdir)) return;
          fs.readdirSync(pdir).forEach(function (fn) {
            if (/\.epr$/i.test(fn)) {
              presets.push({ name: fn, dir: pdir, full: path.join(pdir, fn) });
            }
          });
        });
      } catch (_) {}
    }
    return presets;
  }

  function fillPresetSelect(sel, presets, keyword) {
    sel.innerHTML = '';
    presets.forEach(function (p) {
      var o = document.createElement('option');
      o.value = p.full;
      o.textContent = p.name;
      sel.appendChild(o);
    });
    if (keyword) {
      presets.forEach(function (p) {
        if (p.name.indexOf(keyword) >= 0) { sel.value = p.full; }
      });
    }
  }

  function refreshPresets() {
    var presets = scanPresets();
    fillPresetSelect(presetCaption, presets, '有字幕');
    fillPresetSelect(presetNoCaption, presets, '无字幕');
    if (presets.length === 0) {
      setLog('未扫描到 AME 导出预设（.epr），请手动输入完整路径', true);
    } else {
      setLog('已扫描到 ' + presets.length + ' 个导出预设');
    }
    return presets;
  }

  // ── 从 .epr 推断容器格式后缀 ──────────────────
  function inferExtFromPreset(presetPath) {
    try {
      var raw = fs.readFileSync(presetPath, 'utf8');
      var m = raw.match(/<ExporterFileType>(\d+)<\/ExporterFileType>/);
      if (!m) return 'mp4';
      var code = parseInt(m[1], 10);
      var chars = String.fromCharCode(
        (code >> 24) & 0xff, (code >> 16) & 0xff, (code >> 8) & 0xff, code & 0xff
      );
      var map = {
        'H264': 'mp4', 'h264': 'mp4', 'avc1': 'mp4',
        'HEVC': 'mp4', 'hvc1': 'mp4', 'hev1': 'mp4',
        'MP4 ': 'mp4', 'mp4v': 'mp4',
        'QT  ': 'mov', 'Quick': 'mov',
        'MXF ': 'mxf', 'MXF': 'mxf',
        'AVI ': 'avi',
        'WAVE': 'wav', 'WAV ': 'wav',
        'MP3 ': 'mp3', 'mp3 ': 'mp3'
      };
      return map[chars.trim()] || 'mp4';
    } catch (_) { return 'mp4'; }
  }

  // ── 序列列表 ──────────────────────────────────
  var allSeqs = [];
  function renderSeqList() {
    seqList.innerHTML = '';
    allSeqs.forEach(function (s) {
      var lab = document.createElement('label');
      lab.className = 'seq-item';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = s.name;
      // 默认选中纯数字命名序列
      if (/^\d+$/.test(s.name)) cb.checked = true;
      var span = document.createElement('span');
      span.textContent = s.name;
      lab.appendChild(cb);
      lab.appendChild(span);
      seqList.appendChild(lab);
    });
  }
  function getCheckedSeqs() {
    var out = [];
    seqList.querySelectorAll('input[type=checkbox]').forEach(function (cb) {
      if (cb.checked) out.push(cb.value);
    });
    return out;
  }
  async function refreshSequences() {
    var r = await evalHost('meListSequences()');
    if (r.indexOf('OK:') !== 0) { setLog('读取序列失败：' + r, true); return; }
    allSeqs = JSON.parse(r.slice(3));
    renderSeqList();
    setLog('已加载 ' + allSeqs.length + ' 个序列');
  }

  // ── 音轨保留选项 ──────────────────────────────
  var audioTracks = [];
  function renderKeepList() {
    keepListEl.innerHTML = '';
    audioTracks.forEach(function (t) {
      var lab = document.createElement('label');
      lab.className = 'track-item';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = String(t.index);
      if (t.index < 2) cb.checked = true;
      var span = document.createElement('span');
      span.textContent = 'A' + (t.index + 1) + (t.name ? ' · ' + t.name : '');
      lab.appendChild(cb);
      lab.appendChild(span);
      keepListEl.appendChild(lab);
    });
  }
  function getKeepList() {
    var out = [];
    keepListEl.querySelectorAll('input[type=checkbox]').forEach(function (cb) {
      if (cb.checked) out.push(parseInt(cb.value, 10));
    });
    return out;
  }  async function refreshAudioTracks() {
    var r = await evalHost('meListAudioTracks()');
    if (r.indexOf('OK:') !== 0) { setLog('读取音轨失败：' + r, true); return; }
    audioTracks = JSON.parse(r.slice(3));
    renderKeepList();
    setLog('已加载 ' + audioTracks.length + ' 条音频轨');
  }

  // ── 输出目录浏览（修乱码：结果写 UTF-8 文件再读回） ──
  function browseFolder(targetInput) {
    var tmpFile = path.join(os.tmpdir(), 'cep_folder_' + Date.now() + '_' + Math.floor(Math.random() * 1e6) + '.txt');
    var ps = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      '$d.Description = "选择输出目录"',
      'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
      '  [System.IO.File]::WriteAllText("' + tmpFile + '", $d.SelectedPath, [System.Text.Encoding]::UTF8)',
      '}'
    ].join(';');
    var cmd = 'powershell -NoProfile -STA -Command "' + ps.replace(/"/g, '\\"') + '"';
    require('child_process').exec(cmd, { windowsHide: true }, function (err) {
      if (err) { setLog('打开目录选择失败：' + err.message, true); return; }
      try {
        if (fs.existsSync(tmpFile)) {
          var p = fs.readFileSync(tmpFile, 'utf8').trim();
          try { fs.unlinkSync(tmpFile); } catch (_) {}
          if (p) {
            targetInput.value = p;
            setLog('已选择输出目录：' + p);
          } else {
            setLog('未选择目录（已取消）');
          }
        } else {
          setLog('未选择目录（已取消）');
        }
      } catch (e) { setLog('读取目录失败：' + e.message, true); }
    });
  }

  // ── 等待输出文件完整落地 ─────────────────────
  function waitForFile(filePath, timeoutMs, isStopped) {
    return new Promise(function (resolve, reject) {
      var start = Date.now();
      function check() {
        if (isStopped && isStopped()) { reject(new Error('__STOPPED__')); return; }
        var exists = fs.existsSync(filePath);
        var sz = 0;
        try { if (exists) sz = fs.statSync(filePath).size; } catch (_) {}
        if (exists && sz > 0) {
          setTimeout(function () {
            var sz2 = 0;
            try { if (fs.existsSync(filePath)) sz2 = fs.statSync(filePath).size; } catch (_) {}
            if (sz2 === sz) { resolve(); return; }
            if (Date.now() - start > timeoutMs) { reject(new Error('导出超时')); return; }
            check();
          }, 2000);
          return;
        }
        if (Date.now() - start > timeoutMs) { reject(new Error('导出超时 ' + timeoutMs + 'ms')); return; }
        setTimeout(check, 1500);
      }
      check();
    });
  }

  // ── 构建三个版本的输出目标（处理目录冲突） ────
  // 三个目录独立；若目录有重复，则对应版本文件名加后缀避免覆盖
  function buildOutputs(seqName, ext) {
    var dirs = [dirCaption.value.trim(), dirNoCaption.value.trim(), dirNoMusic.value.trim()];
    var tags = ['成片', '无字幕', '无音乐无字幕'];
    var seen = {};
    dirs.forEach(function (d) { seen[d] = (seen[d] || 0) + 1; });
    var outs = [];
    for (var i = 0; i < 3; i++) {
      var name = (seen[dirs[i]] > 1) ? (seqName + '_' + tags[i]) : seqName;
      outs.push({ dir: dirs[i], file: name + '.' + ext });
    }
    return outs;
  }

  // ── 单个序列的导出流程 ───────────────────────
  // onProgress(percent 0-100, stateText)
  async function exportOneSequence(seqName, pc, pn, keepList, onProgress) {
    var steps = [
      { p: 0, t: '准备' },
      { p: 8, t: '导出成片' },
      { p: 40, t: '导出无字幕版' },
      { p: 72, t: '静音并导出无音乐无字幕版' },
      { p: 100, t: '完成' }
    ];
    function rep(p, t) { if (onProgress) onProgress(p, '[' + seqName + '] ' + t); }
    try {
      rep(0, '准备');
      var act = await evalHost('meActivateSequence(' + JSON.stringify(seqName) + ')');
      if (act.indexOf('OK:') !== 0) return { ok: false, err: '激活序列失败：' + act };

      var ext = inferExtFromPreset(pc);
      var outs = buildOutputs(seqName, ext);
      var o1 = outs[0], o2 = outs[1], o3 = outs[2];

      fs.mkdirSync(o1.dir, { recursive: true });
      fs.mkdirSync(o2.dir, { recursive: true });
      fs.mkdirSync(o3.dir, { recursive: true });

      var f1 = path.join(o1.dir, o1.file);
      var f2 = path.join(o2.dir, o2.file);
      var f3 = path.join(o3.dir, o3.file);

      // 1. 成片（有字幕预设，全轨道）
      rep(10, '导出成片');
      setLog('▶ [' + seqName + '] 成片 → ' + f1);
      var r1 = await evalHost('meExport(' + JSON.stringify(f1) + ', ' + JSON.stringify(pc) + ', 0)');
      if (r1.indexOf('OK:') !== 0) return { ok: false, err: '成片提交失败：' + r1 };
      if (stopRequested) return { stopped: true };
      await waitForFile(f1, 30 * 60 * 1000, function () { return stopRequested; });
      if (stopRequested) return { stopped: true };
      rep(40, '成片完成');
      setLog('  ✓ 成片完成');

      // 2. 无字幕版（无字幕预设，全轨道）
      rep(42, '导出无字幕版');
      setLog('▶ [' + seqName + '] 无字幕版 → ' + f2);
      var r2 = await evalHost('meExport(' + JSON.stringify(f2) + ', ' + JSON.stringify(pn) + ', 0)');
      if (r2.indexOf('OK:') !== 0) return { ok: false, err: '无字幕版提交失败：' + r2 };
      if (stopRequested) return { stopped: true };
      await waitForFile(f2, 30 * 60 * 1000, function () { return stopRequested; });
      if (stopRequested) return { stopped: true };
      rep(72, '无字幕版完成');
      setLog('  ✓ 无字幕版完成');

      // 3. 无音乐无字幕版（无字幕预设 + 静音非保留轨）
      rep(74, '静音并导出无音乐无字幕版');
      setLog('▶ [' + seqName + '] 静音非保留音轨');
      var m = await evalHost('meMuteExcept(' + JSON.stringify(keepList.join(',')) + ')');
      if (m.indexOf('OK:') !== 0) return { ok: false, err: '静音失败：' + m };
      setLog('▶ [' + seqName + '] 无音乐无字幕版 → ' + f3);
      var r3 = await evalHost('meExport(' + JSON.stringify(f3) + ', ' + JSON.stringify(pn) + ', 0)');
      if (r3.indexOf('OK:') !== 0) { await evalHost('meUnmuteAll()'); return { ok: false, err: '无音乐无字幕版提交失败：' + r3 }; }
      if (stopRequested) { await evalHost('meUnmuteAll()'); return { stopped: true }; }
      await waitForFile(f3, 30 * 60 * 1000, function () { return stopRequested; });
      if (stopRequested) { await evalHost('meUnmuteAll()'); return { stopped: true }; }
      setLog('  ✓ 无音乐无字幕版完成');

      // 恢复轨道
      var um = await evalHost('meUnmuteAll()');
      if (um.indexOf('OK:') === 0) setLog('  ✓ 已恢复所有音频轨');
      else setLog('  ⚠ ' + um, true);

      rep(100, '完成');
      return { ok: true };
    } catch (e) {
      if (e && e.message === '__STOPPED__') {
        try { await evalHost('meUnmuteAll()'); } catch (_) {}
        return { stopped: true };
      }
      try { await evalHost('meUnmuteAll()'); } catch (_) {}
      return { ok: false, err: e.message };
    }
  }

  // ── 主流程：批量导出 ─────────────────────────
  async function runExport() {
    var seqs = getCheckedSeqs();
    if (seqs.length === 0) { setLog('请至少勾选一个序列', true); return; }

    var d1 = dirCaption.value.trim();
    var d2 = dirNoCaption.value.trim();
    var d3 = dirNoMusic.value.trim();
    if (!d1 || !d2 || !d3) { setLog('请填齐三个版本的输出目录', true); return; }
    if (!fs.existsSync(d1) || !fs.existsSync(d2) || !fs.existsSync(d3)) {
      [d1, d2, d3].forEach(function (d) { if (!fs.existsSync(d)) setLog('输出目录不存在：' + d, true); });
      return;
    }

    var pc = presetCaption.value.trim();
    var pn = presetNoCaption.value.trim();
    if (!pc || !pn) { setLog('请确认两个导出预设已选好', true); return; }
    if (!fs.existsSync(pc)) { setLog('有字幕预设文件不存在：' + pc, true); return; }
    if (!fs.existsSync(pn)) { setLog('无字幕预设文件不存在：' + pn, true); return; }

    var keepList;
    if (keepMode.value === 'count') {
      var keep = parseInt(keepCountEl.value, 10);
      if (isNaN(keep) || keep < 0) { setLog('保留人声轨数需为 ≥0 的整数', true); return; }
      keepList = [];
      for (var i = 0; i < keep; i++) keepList.push(i);
    } else {
      keepList = getKeepList();
      if (keepList.length === 0) { setLog('请至少勾选一条保留音轨（或切换为「按数量」并设为 0）', true); return; }
    }

    stopRequested = false;
    setBusy(true);
    progressArea.style.display = '';
    var totalSeq = seqs.length;
    var startTime = Date.now();
    var doneSeq = 0;

    function overallPercent(seqIdx, inSeqPercent) {
      var base = (seqIdx / totalSeq) * 100;
      var span = (1 / totalSeq) * 100;
      return base + span * (inSeqPercent / 100);
    }

    try {
      for (var k = 0; k < seqs.length; k++) {
        if (stopRequested) break;
        var seqName = seqs[k];
        setLog('━━ 开始处理 [' + seqName + '] (' + (k + 1) + '/' + totalSeq + ') ━━');

        var res = await exportOneSequence(seqName, pc, pn, keepList, function (p, t) {
          if (stopRequested) return;
          var overall = overallPercent(k, p);
          var elapsed = (Date.now() - startTime) / 1000;
          var remain = 0;
          if (overall > 0) {
            remain = elapsed * (100 - overall) / overall;
          }
          setProgress(overall, t, elapsed, remain);
        });

        if (res.stopped) { setLog('⏹ 已停止（用户中止）', true); break; }
        if (res.ok) { doneSeq++; setLog('✓ [' + seqName + '] 全部完成'); }
        else { setLog('✗ [' + seqName + '] 失败：' + res.err, true); }
      }

      if (stopRequested) {
        setLog('════ 任务已停止：完成 ' + doneSeq + ' / ' + totalSeq + ' ════');
      } else {
        setProgress(100, '全部完成', (Date.now() - startTime) / 1000, 0);
        setLog('════ 批量结束：成功 ' + doneSeq + ' / 失败 ' + (totalSeq - doneSeq) + ' ════');
        setLog('字幕 srt 请用快捷键（全选序列 → 文件 → 导出 → 字幕）手动导出');
      }
    } catch (e) {
      setLog('流程中断：' + e.message, true);
      try { await evalHost('meUnmuteAll()'); } catch (_) {}
    } finally {
      setBusy(false);
    }
  }

  // ── 事件绑定 ──────────────────────────────────
  btnGo.addEventListener('click', runExport);
  btnStop.addEventListener('click', function () {
    if (!btnStop.disabled) {
      stopRequested = true;
      setLog('⏹ 正在停止…（当前导出完成后中止）', true);
    }
  });
  btnRefresh.addEventListener('click', async function () {
    refreshPresets();
    await refreshSequences();
    await refreshAudioTracks();
  });

  // 三个目录各自的浏览按钮
  document.getElementById('btn-browse-caption').addEventListener('click', function () { browseFolder(dirCaption); });
  document.getElementById('btn-browse-no-caption').addEventListener('click', function () { browseFolder(dirNoCaption); });
  document.getElementById('btn-browse-no-music').addEventListener('click', function () { browseFolder(dirNoMusic); });

  btnSelAll.addEventListener('click', function () {
    seqList.querySelectorAll('input[type=checkbox]').forEach(function (cb) { cb.checked = true; });
  });
  btnSelNone.addEventListener('click', function () {
    seqList.querySelectorAll('input[type=checkbox]').forEach(function (cb) { cb.checked = false; });
  });

  keepMode.addEventListener('change', function () {
    var isCount = keepMode.value === 'count';
    keepCountRow.style.display = isCount ? '' : 'none';
    keepListRow.style.display = isCount ? 'none' : '';
  });

  seqList.addEventListener('change', async function () {
    var first = getCheckedSeqs()[0];
    if (first) {
      await evalHost('meActivateSequence(' + JSON.stringify(first) + ')');
      await refreshAudioTracks();
    }
  });

  // ── 初始化 ──────────────────────────────────
  (async function () {
    refreshPresets();
    try { await refreshSequences(); } catch (_) {}
    var v = await evalHost('meVersion()');
    if (v) document.getElementById('version').textContent = 'v' + v;
    statusDot.className = 'dot on';
  })();
})();
