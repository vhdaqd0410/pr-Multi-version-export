// ============================================================
// 多版本交付导出 —— 宿主脚本（Premiere Pro 内执行）
// 版本 3.1.0
// 依赖：PR 14.0+（原生 JSON 可用）
//
// 核心 API（已验证 / 来自 Premiere Pro Scripting Guide）：
//   sequence.exportAsMediaDirect(outputPath, presetPath, exportType)
//   track.setMute(1/0)   静音 / 恢复 音频轨（1=静音，0=取消，成功返回 0）
//   seq.audioTracks[i]    0-based 音频轨索引
//   track.name            音轨名称（只读）
// ============================================================

function meVersion() { return "3.1.0"; }

// 列出项目里所有序列
function meListSequences() {
    try {
        var seqs = [];
        for (var i = 0; i < app.project.sequences.numSequences; i++) {
            seqs.push({ name: app.project.sequences[i].name, id: i });
        }
        return "OK:" + JSON.stringify(seqs);
    } catch (e) { return "ERR:" + e; }
}

// 激活指定序列（按名字）
function meActivateSequence(name) {
    try {
        for (var i = 0; i < app.project.sequences.numSequences; i++) {
            if (app.project.sequences[i].name === name) {
                app.project.activeSequence = app.project.sequences[i];
                return "OK:" + name;
            }
        }
        return "ERR:未找到序列 " + name;
    } catch (e) { return "ERR:" + e; }
}

// 列出活动序列的所有音频轨（含名称）
function meListAudioTracks() {
    try {
        var s = app.project.activeSequence;
        if (!s) return "ERR:没有活动序列";
        var tracks = [];
        for (var i = 0; i < s.audioTracks.numTracks; i++) {
            var nm = "";
            try { nm = s.audioTracks[i].name; } catch (_) {}
            tracks.push({ index: i, name: nm });
        }
        return "OK:" + JSON.stringify(tracks);
    } catch (e) { return "ERR:" + e; }
}

// 静音所有「不在保留列表内」的音频轨
// keepListStr: 逗号分隔的 0-based 索引字符串，如 "0,1"，这些轨道保留（不静音）
function meMuteExcept(keepListStr) {
    try {
        var s = app.project.activeSequence;
        if (!s) return "ERR:没有活动序列";
        var parts = String(keepListStr).split(',');
        var keepSet = {};
        for (var k = 0; k < parts.length; k++) {
            var idx = parseInt(parts[k], 10);
            if (!isNaN(idx)) keepSet[String(idx)] = true;
        }
        var n = s.audioTracks.numTracks;
        var muted = [];
        var kept = [];
        for (var i = 0; i < n; i++) {
            var keep = (keepSet[String(i)] === true);
            s.audioTracks[i].setMute(keep ? 0 : 1);
            if (keep) kept.push(i + 1); else muted.push(i + 1);
        }
        return "OK:" + JSON.stringify({ muted: muted, kept: kept, total: n });
    } catch (e) { return "ERR:" + e; }
}

// 取消所有音频轨静音（逐个处理，单个失败不中断整体）
function meUnmuteAll() {
    try {
        var s = app.project.activeSequence;
        if (!s) return "ERR:没有活动序列";
        var n = s.audioTracks.numTracks;
        var failed = 0;
        for (var i = 0; i < n; i++) {
            try { s.audioTracks[i].setMute(0); } catch (e) { failed++; }
        }
        if (failed > 0) return "ERR:" + failed + " 条轨道恢复失败";
        return "OK:";
    } catch (e) { return "ERR:" + e; }
}

// 用指定预设导出活动序列
// exportType: 0 = 整个序列, 1 = 入点到出点
function meExport(outputPath, presetPath, exportType) {
    try {
        var s = app.project.activeSequence;
        if (!s) return "ERR:没有活动序列";

        var preset = new File(presetPath);
        if (!preset.exists) return "ERR:找不到预设 " + presetPath;

        var output = new File(outputPath);
        var parent = output.parent;
        if (parent && !parent.exists) parent.create();

        var ok = s.exportAsMediaDirect(output.fsName, preset.fsName, exportType || 0);
        if (!ok) return "ERR:exportAsMediaDirect 返回失败";
        return "OK:" + output.fsName;
    } catch (e) { return "ERR:" + e; }
}
