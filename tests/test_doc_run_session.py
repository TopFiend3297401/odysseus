"""Tests for the document editor's interactive run-session helpers
(routes/shell_routes.py). These cover the pure/host-only logic — sid
validation, log/exit-marker parsing, and the tmux command construction —
without requiring an actual tmux install."""

import routes.shell_routes as sr


# ---- session id validation -------------------------------------------------

def test_sid_regex_accepts_valid():
    assert sr.DOCRUN_SID_RE.match("docrun-0a1b2c3d")


def test_sid_regex_rejects_bad():
    for bad in (
        "docrun-XYZ",            # non-hex
        "docrun-0a1b2c3",        # too short
        "docrun-0a1b2c3d4",      # too long
        "cookbook-0a1b2c3d",     # wrong prefix
        "docrun-0a1b2c3d; rm -rf /",  # injection attempt
        "../../etc/passwd",
        "",
    ):
        assert not sr.DOCRUN_SID_RE.match(bad), bad


# ---- log parsing -----------------------------------------------------------

def _write_log(sid, text):
    sr.TMUX_LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_path, _, _ = sr._docrun_paths(sid)
    log_path.write_text(text, encoding="utf-8")
    return log_path


def test_read_output_strips_exit_marker_and_reports_code():
    sid = "docrun-aaaaaaaa"
    log = _write_log(sid, "Enter first number: hello\n:::EXIT_CODE:::0\n")
    try:
        data, offset, exited, code = sr._read_docrun_output(sid, 0)
        assert "Enter first number: hello" in data
        assert ":::EXIT_CODE:::" not in data  # marker stripped from displayed text
        assert exited is True
        assert code == 0
        assert offset == len(log.read_text())
    finally:
        log.unlink(missing_ok=True)


def test_read_output_nonzero_exit_code():
    sid = "docrun-bbbbbbbb"
    log = _write_log(sid, "boom\n:::EXIT_CODE:::1\n")
    try:
        _, _, exited, code = sr._read_docrun_output(sid, 0)
        assert exited is True and code == 1
    finally:
        log.unlink(missing_ok=True)


def test_read_output_incremental_offset():
    sid = "docrun-cccccccc"
    log = _write_log(sid, "line one\nline two\n")
    try:
        data, offset, exited, _ = sr._read_docrun_output(sid, 0)
        assert "line one" in data and "line two" in data
        assert exited is False
        # Second poll from the advanced offset sees nothing new yet.
        data2, offset2, exited2, _ = sr._read_docrun_output(sid, offset)
        assert data2 == ""
        assert offset2 == offset
        assert exited2 is False
    finally:
        log.unlink(missing_ok=True)


def test_read_output_missing_log_is_safe():
    data, offset, exited, code = sr._read_docrun_output("docrun-deadbeef", 0)
    assert data == "" and offset == 0 and exited is False and code is None


# ---- start / kill command construction (tmux mocked) -----------------------

async def test_start_docrun_writes_wrapper_and_starts_tmux(monkeypatch):
    captured = {}

    async def fake_exec(cmd, timeout=30):
        captured["cmd"] = cmd
        return {"stdout": "", "stderr": "", "exit_code": 0}

    monkeypatch.setattr(sr, "_exec_shell", fake_exec)
    sr._DOCRUN_SESSIONS.clear()

    sid = await sr._start_docrun("print('hi')", "python")
    try:
        assert sr.DOCRUN_SID_RE.match(sid)
        assert sid in sr._DOCRUN_SESSIONS
        # tmux is launched detached with the wrapper script for this sid.
        assert captured["cmd"].startswith(f"tmux new-session -d -s {sid} ")

        log_path, script_path, code_path = sr._docrun_paths(sid)
        assert code_path.read_text() == "print('hi')"
        wrapper = script_path.read_text()
        assert "python3 -u" in wrapper            # unbuffered so prompts flush
        assert sr.EXIT_MARKER in wrapper          # exit code recorded for polling
        assert str(log_path) in wrapper           # output tee'd to the log
    finally:
        for p in sr._docrun_paths(sid):
            p.unlink(missing_ok=True)
        sr._DOCRUN_SESSIONS.pop(sid, None)


async def test_start_docrun_bash_uses_bash_interpreter(monkeypatch):
    async def fake_exec(cmd, timeout=30):
        return {"stdout": "", "stderr": "", "exit_code": 0}

    monkeypatch.setattr(sr, "_exec_shell", fake_exec)
    sr._DOCRUN_SESSIONS.clear()
    sid = await sr._start_docrun("echo hi", "bash")
    try:
        wrapper = sr._docrun_paths(sid)[1].read_text()
        assert "bash " in wrapper and "python3 -u" not in wrapper
    finally:
        for p in sr._docrun_paths(sid):
            p.unlink(missing_ok=True)
        sr._DOCRUN_SESSIONS.pop(sid, None)


async def test_kill_session_sends_ctrlc_and_kills(monkeypatch):
    cmds = []

    async def fake_exec(cmd, timeout=30):
        cmds.append(cmd)
        return {"stdout": "", "stderr": "", "exit_code": 0}

    monkeypatch.setattr(sr, "_exec_shell", fake_exec)
    sid = "docrun-12345678"
    sr._DOCRUN_SESSIONS[sid] = 1.0
    # Drop a stray file to confirm cleanup removes it.
    log_path, _, _ = sr._docrun_paths(sid)
    sr.TMUX_LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_path.write_text("x")

    await sr._docrun_kill(sid)

    joined = " ".join(cmds)
    assert f"send-keys -t {sid} C-c" in joined
    assert f"kill-session -t {sid}" in joined
    assert sid not in sr._DOCRUN_SESSIONS
    assert not log_path.exists()


async def test_kill_session_ignores_bad_sid(monkeypatch):
    called = []

    async def fake_exec(cmd, timeout=30):
        called.append(cmd)
        return {"exit_code": 0}

    monkeypatch.setattr(sr, "_exec_shell", fake_exec)
    await sr._docrun_kill("bad; rm -rf /")
    assert called == []  # never builds a tmux command for an invalid sid
