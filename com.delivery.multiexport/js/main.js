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

  // ── UI 元素 ──────────────────────────────────
  var seqList = document.getElementById('seq-list');
  var btnSelAll = document.getElementById('btn-sel-all');
  var btnSelNone = document.getElementById('btn-sel-none');
  var versionsWrap = document.getElementById('versions-wrap');
  var btnAddVersion = document.getElementById('btn-add-version');
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

  // ── 全局状态 ──────────────────────────────────
  var stopRequested = false;
  var allSeqs = [];
  var audioTracks = [];
  var allPresets = [];
  var versions = [];     // 交付版本列表（每个版本独立配置）
  var uidSeq = 0;

  // ── 基础 UI 工具 ──────────────────────────────
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
    allPresets = scanPresets();
    if (allPresets.length === 0) {
      setLog('未扫描到 AME 导出预设（.epr），请手动输入完整路径', true);
    } else {
      setLog('已扫描到 ' + allPresets.length + ' 个导出预设');
    }
    return allPresets;
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
  function renderSeqList() {
    seqList.innerHTML = '';
    allSeqs.forEach(function (s) {
      var lab = document.createElement('label');
      lab.className = 'seq-item';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = s.name;
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

  // ── 音轨结构（全局一份，供每个版本的保留列表渲染） ──
  async function refreshAudioTracks() {
    var r = await evalHost('meListAudioTracks()');
    if (r.indexOf('OK:') !== 0) { setLog('读取音轨失败：' + r, true); return; }
    audioTracks = JSON.parse(r.slice(3));
    setLog('已加载 ' + audioTracks.length + ' 条音频轨');
    renderVersions(); // 音轨结构变了，重渲版本卡片里的保留列表
  }

  // ── 版本数据（持久化到 localStorage） ─────────
  function genId() { return 'v' + (++uidSeq) + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7); }

  function defaultVersions() {
    return [
      { id: genId(), name: '成片', preset: '', muteMode: 'none', keepList: [0, 1], outDir: '', enabled: true },
      { id: genId(), name: '无字幕', preset: '', muteMode: 'none', keepList: [0, 1], outDir: '', enabled: true },
      { id: genId(), name: '无音乐无字幕', preset: '', muteMode: 'mute', keepList: [0, 1], outDir: '', enabled: true }
    ];
  }
  function loadVersions() {
    try {
      var raw = localStorage.getItem('pr_me_versions_v1');
      if (raw) {
        var arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.length > 0) {
          arr.forEach(function (v) {
            if (!v.id) v.id = genId();
            if (!v.muteMode) v.muteMode = 'none';
            if (!v.keepList) v.keepList = [0, 1];
            if (!v.outDir) v.outDir = '';
            if (v.enabled === undefined) v.enabled = true;
          });
          return arr;
        }
      }
    } catch (_) {}
    return defaultVersions();
  }
  function saveVersions() {
    try { localStorage.setItem('pr_me_versions_v1', JSON.stringify(versions)); } catch (_) {}
  }
  function findVersion(id) {
    for (var i = 0; i < versions.length; i++) if (versions[i].id === id) return versions[i];
    return null;
  }

  // ── 渲染版本卡片 ──────────────────────────────
  function toggleKeep(card) {
    var m = card.querySelector('.v-mute').value;
    card.querySelector('.v-keep').style.display = (m === 'mute') ? '' : 'none';
  }

  function createVersionCard(v) {
    var card = document.createElement('div');
    card.className = 'ver-card';
    card.setAttribute('data-id', v.id);

    // 头部：启用勾选 + 版本名 + 删除
    var head = document.createElement('div');
    head.className = 'ver-head';
    var enCheck = document.createElement('input');
    enCheck.type = 'checkbox';
    enCheck.className = 'v-enabled';
    enCheck.title = '取消勾选则该版本不参与本次导出';
    enCheck.checked = (v.enabled !== false);
    head.appendChild(enCheck);
    var nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'v-name';
    nameInput.placeholder = '版本名';
    nameInput.value = v.name;
    head.appendChild(nameInput);
    var delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'v-del';
    delBtn.textContent = '删除';
    delBtn.title = '删除此版本';
    head.appendChild(delBtn);
    card.appendChild(head);

    // 预设
    var pLab = document.createElement('label');
    pLab.textContent = '导出预设';
    card.appendChild(pLab);
    var pSel = document.createElement('select');
    pSel.className = 'v-preset';
    fillPresetSelect(pSel, allPresets, ''); // 只填选项，不自动选
    // 决定选中值：有已存值则用，否则按关键词自动选并回写
    if (v.preset && allPresets.some(function (p) { return p.full === v.preset; })) {
      pSel.value = v.preset;
    } else {
      var keyword = v.name.indexOf('无字幕') >= 0 ? '无字幕' : '有字幕';
      allPresets.forEach(function (p) {
        if (p.name.indexOf(keyword) >= 0) pSel.value = p.full;
      });
      v.preset = pSel.value || ''; // 回写自动选中的预设，避免导出时校验报“预设无效”
    }
    card.appendChild(pSel);

    // 音轨模式
    var mLab = document.createElement('label');
    mLab.textContent = '音轨模式';
    card.appendChild(mLab);
    var mSel = document.createElement('select');
    mSel.className = 'v-mute';
    var o1 = document.createElement('option');
    o1.value = 'none'; o1.textContent = '不静音（全轨道）';
    var o2 = document.createElement('option');
    o2.value = 'mute'; o2.textContent = '静音非保留轨（去音乐）';
    mSel.appendChild(o1);
    mSel.appendChild(o2);
    mSel.value = v.muteMode || 'none';
    card.appendChild(mSel);

    // 输出目录
    var dLab = document.createElement('label');
    dLab.textContent = '输出目录';
    card.appendChild(dLab);
    var dirRow = document.createElement('div');
    dirRow.className = 'dir-row';
    var dirInput = document.createElement('input');
    dirInput.type = 'text';
    dirInput.className = 'v-dir';
    dirInput.placeholder = '例如 D:\\成片';
    dirInput.value = v.outDir || '';
    dirRow.appendChild(dirInput);
    var browseBtn = document.createElement('button');
    browseBtn.type = 'button';
    browseBtn.className = 'v-browse';
    browseBtn.textContent = '浏览…';
    dirRow.appendChild(browseBtn);
    card.appendChild(dirRow);

    // 保留音轨列表（仅静音模式显示）
    var keepWrap = document.createElement('div');
    keepWrap.className = 'v-keep';
    var kLab = document.createElement('label');
    kLab.textContent = '保留音轨（勾选保留，其余静音）';
    keepWrap.appendChild(kLab);
    var keepList = document.createElement('div');
    keepList.className = 'keep-list';
    if (audioTracks.length === 0) {
      keepList.innerHTML = '<div class="keep-empty">尚未加载音轨，点「刷新」</div>';
    } else {
      audioTracks.forEach(function (t) {
        var lab = document.createElement('label');
        lab.className = 'track-item';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'v-keep-cb';
        cb.value = String(t.index);
        if (v.keepList.indexOf(t.index) >= 0) cb.checked = true;
        var span = document.createElement('span');
        span.textContent = 'A' + (t.index + 1) + (t.name ? ' · ' + t.name : '');
        lab.appendChild(cb);
        lab.appendChild(span);
        keepList.appendChild(lab);
      });
    }
    keepWrap.appendChild(keepList);
    card.appendChild(keepWrap);

    // 事件
    delBtn.addEventListener('click', function () { removeVersion(v.id); });
    browseBtn.addEventListener('click', function () { browseFolder(dirInput); });
    mSel.addEventListener('change', function () {
      v.muteMode = mSel.value;
      toggleKeep(card);
      saveVersions();
    });

    toggleKeep(card);
    return card;
  }

  function renderVersions() {
    versionsWrap.innerHTML = '';
    versions.forEach(function (v) {
      versionsWrap.appendChild(createVersionCard(v));
    });
    saveVersions(); // 回写 createVersionCard 里自动选中的预设
  }

  function addVersion() {
    versions.push({ id: genId(), name: '新版本', preset: '', muteMode: 'none', keepList: [0, 1], outDir: '', enabled: true });
    saveVersions();
    renderVersions();
    setLog('已添加新版本，请配置名称/预设/目录');
  }

  function removeVersion(id) {
    if (versions.length <= 1) { setLog('至少保留一个版本', true); return; }
    versions = versions.filter(function (v) { return v.id !== id; });
    saveVersions();
    renderVersions();
    setLog('已删除版本');
  }
  // 本次参与导出的版本（勾选了启用复选框的）
  function enabledVersions() {
    return versions.filter(function (v) { return v.enabled !== false; });
  }

  // ── 输出目录浏览（修乱码：结果写 UTF-8 文件再读回，并记住上次位置） ──
  function getLastDir() {
    try { return localStorage.getItem('pr_me_lastdir') || ''; } catch (_) { return ''; }
  }
  function setLastDir(p) {
    try { localStorage.setItem('pr_me_lastdir', p); } catch (_) {}
  }
  function browseFolder(targetInput) {
    var last = getLastDir();
    var cur = (targetInput && targetInput.value || '').trim();
    var initial = '';
    if (cur && fs.existsSync(cur)) initial = cur;
    else if (cur) { var par = path.dirname(cur); if (fs.existsSync(par)) initial = par; }
    if (!initial && last && fs.existsSync(last)) initial = last;

    var inFile = path.join(os.tmpdir(), 'cep_dir_in_' + Date.now() + '_' + Math.floor(Math.random() * 1e6) + '.txt');
    var outFile = path.join(os.tmpdir(), 'cep_dir_out_' + Date.now() + '_' + Math.floor(Math.random() * 1e6) + '.txt');
    // 把初始位置写进 UTF-8 文件，PowerShell 读回，避免中文路径拼命令行转义
    fs.writeFileSync(inFile, initial, 'utf8');

    var ps = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      '$d.Description = "选择输出目录"',
      '$ini = "' + inFile + '"',
      'if (Test-Path $ini) { $sp = [System.IO.File]::ReadAllText($ini, [System.Text.Encoding]::UTF8); if ($sp -and (Test-Path $sp)) { $d.SelectedPath = $sp } }',
      'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
      '  [System.IO.File]::WriteAllText("' + outFile + '", $d.SelectedPath, [System.Text.Encoding]::UTF8)',
      '}'
    ].join(';');
    var cmd = 'powershell -NoProfile -STA -Command "' + ps.replace(/"/g, '\\"') + '"';
    require('child_process').exec(cmd, { windowsHide: true }, function (err) {
      try { fs.unlinkSync(inFile); } catch (_) {}
      if (err) { setLog('打开目录选择失败：' + err.message, true); return; }
      try {
        if (fs.existsSync(outFile)) {
          var p = fs.readFileSync(outFile, 'utf8').trim();
          try { fs.unlinkSync(outFile); } catch (_) {}
          if (p) {
            targetInput.value = p;
            setLastDir(p);
            // 回写版本数据（浏览按钮是程序赋值，不触发 input 事件，需手动同步 v.outDir）
            var card = targetInput.closest('.ver-card');
            if (card) {
              var vv = findVersion(card.getAttribute('data-id'));
              if (vv) { vv.outDir = p; saveVersions(); }
            }
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

  // ── 构建每个版本的输出目标（处理目录冲突） ────
  function buildOutputs(seqName) {
    var evs = enabledVersions();
    var dirs = evs.map(function (v) { return v.outDir; });
    var seen = {};
    dirs.forEach(function (d) { seen[d] = (seen[d] || 0) + 1; });
    return evs.map(function (v) {
      var ext = inferExtFromPreset(v.preset);
      var name = (seen[v.outDir] > 1) ? (seqName + '_' + v.name) : seqName;
      return { dir: v.outDir, file: name + '.' + ext };
    });
  }

  // ── 单个序列：按版本列表依次导出 ──────────────
  async function exportOneSequence(seqName, onProgress) {
    var evs = enabledVersions();
    var totalV = evs.length;
    function rep(p, t) { if (onProgress) onProgress(p, '[' + seqName + '] ' + t); }
    var muted = false;
    async function unmute() { if (muted) { try { await evalHost('meUnmuteAll()'); } catch (_) {} muted = false; } }

    try {
      rep(0, '准备');
      var act = await evalHost('meActivateSequence(' + JSON.stringify(seqName) + ')');
      if (act.indexOf('OK:') !== 0) return { ok: false, err: '激活序列失败：' + act };

      var outs = buildOutputs(seqName);
      evs.forEach(function (v, i) {
        if (outs[i].dir) fs.mkdirSync(outs[i].dir, { recursive: true });
      });

      for (var i = 0; i < totalV; i++) {
        if (stopRequested) { await unmute(); return { stopped: true }; }
        var v = evs[i];
        var o = outs[i];
        var f = path.join(o.dir, o.file);
        var base = (i / totalV) * 100;
        var span = (1 / totalV) * 100;

        if (v.muteMode === 'mute') {
          rep(base + 2, '静音非保留轨');
          var m = await evalHost('meMuteExcept(' + JSON.stringify(v.keepList.join(',')) + ')');
          if (m.indexOf('OK:') !== 0) return { ok: false, err: '静音失败：' + m };
          muted = true;
        }

        rep(base + 6, '导出「' + v.name + '」');
        setLog('▶ [' + seqName + '] ' + v.name + ' → ' + f);
        var r = await evalHost('meExport(' + JSON.stringify(f) + ', ' + JSON.stringify(v.preset) + ', 0)');
        if (r.indexOf('OK:') !== 0) { await unmute(); return { ok: false, err: '「' + v.name + '」提交失败：' + r }; }
        if (stopRequested) { await unmute(); return { stopped: true }; }
        await waitForFile(f, 30 * 60 * 1000, function () { return stopRequested; });
        if (stopRequested) { await unmute(); return { stopped: true }; }
        await unmute();
        setLog('  ✓ ' + v.name + '完成');
        rep(base + span - 2, '「' + v.name + '」完成');
      }

      rep(100, '完成');
      return { ok: true };
    } catch (e) {
      if (e && e.message === '__STOPPED__') { await unmute(); return { stopped: true }; }
      await unmute();
      return { ok: false, err: e.message };
    }
  }

  // ── 主流程：批量导出 ─────────────────────────
  async function runExport() {
    var seqs = getCheckedSeqs();
    if (seqs.length === 0) { setLog('请至少勾选一个序列', true); return; }
    var evs = enabledVersions();
    if (evs.length === 0) { setLog('请至少启用一个版本（勾选版本卡片前的复选框）', true); return; }

    // 校验每个启用的版本
    for (var i = 0; i < evs.length; i++) {
      var v = evs[i];
      if (!v.name) { setLog('第 ' + (i + 1) + ' 个版本缺名称', true); return; }
      if (!v.preset || !fs.existsSync(v.preset)) { setLog('版本「' + v.name + '」导出预设无效', true); return; }
      if (!v.outDir || !fs.existsSync(v.outDir)) { setLog('版本「' + v.name + '」输出目录不存在：' + v.outDir, true); return; }
      if (v.muteMode === 'mute' && v.keepList.length === 0) { setLog('版本「' + v.name + '」选了静音但没勾保留轨', true); return; }
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

        var res = await exportOneSequence(seqName, function (p, t) {
          if (stopRequested) return;
          var overall = overallPercent(k, p);
          var elapsed = (Date.now() - startTime) / 1000;
          var remain = overall > 0 ? elapsed * (100 - overall) / overall : 0;
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

  btnAddVersion.addEventListener('click', addVersion);

  btnRefresh.addEventListener('click', async function () {
    refreshPresets();
    await refreshSequences();
    await refreshAudioTracks();
    renderVersions();
  });

  // 版本卡片内部 input/change 实时同步到 versions
  versionsWrap.addEventListener('input', function (e) {
    var card = e.target.closest('.ver-card');
    if (!card) return;
    var v = findVersion(card.getAttribute('data-id'));
    if (!v) return;
    if (e.target.classList.contains('v-name')) v.name = e.target.value;
    else if (e.target.classList.contains('v-dir')) v.outDir = e.target.value;
    saveVersions();
  });
  versionsWrap.addEventListener('change', function (e) {
    var card = e.target.closest('.ver-card');
    if (!card) return;
    var v = findVersion(card.getAttribute('data-id'));
    if (!v) return;
    if (e.target.classList.contains('v-preset')) {
      v.preset = e.target.value;
      saveVersions();
    } else if (e.target.classList.contains('v-enabled')) {
      v.enabled = e.target.checked;
      saveVersions();
    } else if (e.target.classList.contains('v-keep-cb')) {
      v.keepList = [];
      card.querySelectorAll('.v-keep-cb:checked').forEach(function (cb) {
        v.keepList.push(parseInt(cb.value, 10));
      });
      saveVersions();
    }
  });

  btnSelAll.addEventListener('click', function () {
    seqList.querySelectorAll('input[type=checkbox]').forEach(function (cb) { cb.checked = true; });
  });
  btnSelNone.addEventListener('click', function () {
    seqList.querySelectorAll('input[type=checkbox]').forEach(function (cb) { cb.checked = false; });
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
    versions = loadVersions();
    try { await refreshSequences(); } catch (_) {}
    try { await refreshAudioTracks(); } catch (_) { renderVersions(); }
    var v = await evalHost('meVersion()');
    if (v) document.getElementById('version').textContent = 'v' + v;
    statusDot.className = 'dot on';
  })();
})();
