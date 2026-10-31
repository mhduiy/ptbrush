from threading import Event
from datetime import datetime, timedelta
from types import SimpleNamespace

import peewee
from flask import Flask

from tasks import runner
from web import auth
from tasks import services
from db import Torrent as TorrentDB
from web.blueprints import api_runtime


def test_logs_incremental_rotation_redaction_and_cursor_boundary(tmp_path, monkeypatch):
    path = tmp_path / "ptbrush.log"
    monkeypatch.setattr(api_runtime, "LOG_PATH", path)
    monkeypatch.setattr(api_runtime, "read_raw", lambda: {
        "downloader": {"password": "private-password", "api_key": "private-key"},
    })
    monkeypatch.setattr(auth, "PTBrushConfig", lambda: SimpleNamespace(web=None))
    app = Flask(__name__)
    app.register_blueprint(api_runtime.api_runtime_bp)
    client = app.test_client()
    assert client.get("/api/logs").json["text"] == ""
    path.write_text("ready\nprivate-password https://site/download?token=private-token\n")
    response = client.get("/api/logs")
    first = response.json
    assert "ready" in first["text"]
    assert "private-password" not in first["text"]
    assert "private-token" not in first["text"]
    assert response.headers["Cache-Control"] == "no-store"
    with path.open("a") as handle:
        handle.write("新增日志 private-key\n")
    second = client.get("/api/logs", query_string={"cursor": first["cursor"]}).json
    assert second["text"] == "新增日志 ***\n"
    assert second["reset"] is False
    device, inode, _ = first["cursor"].split(":")
    forged = client.get("/api/logs", query_string={"cursor": f"{device}:{inode}:9"}).json
    assert "password" not in forged["text"]
    path.rename(tmp_path / "old.log")
    path.write_text("rotated\n")
    rotated = client.get("/api/logs", query_string={"cursor": second["cursor"]}).json
    assert rotated["reset"] is True
    assert rotated["text"] == "rotated\n"
    assert client.get("/api/logs?cursor=invalid").status_code == 400
    assert client.get("/api/logs?cursor=1:2:-1").status_code == 400


def test_runtime_auth_and_cross_origin_trigger(monkeypatch):
    monkeypatch.setattr(auth, "PTBrushConfig", lambda: SimpleNamespace(
        web=SimpleNamespace(password="login-password")))
    app = Flask(__name__)
    app.secret_key = "test-secret"
    app.register_blueprint(api_runtime.api_runtime_bp)
    client = app.test_client()
    assert client.get("/api/logs").status_code == 401
    assert client.get("/api/tasks/brush").status_code == 401
    assert client.post("/api/tasks/brush", json={}).status_code == 401
    with client.session_transaction() as session:
        session[auth.SESSION_KEY] = True
    assert client.post("/api/tasks/brush").status_code == 403
    assert client.post("/api/tasks/brush", json={}, headers={
        "Origin": "https://other-site.example"}).status_code == 403


def test_manual_run_serializes_with_scheduler_and_reports_failure(monkeypatch):
    entered, release, finished = Event(), Event(), Event()
    monkeypatch.setattr(auth, "PTBrushConfig", lambda: SimpleNamespace(web=None))
    monkeypatch.setattr(runner, "PTBrushConfig", lambda: SimpleNamespace(
        downloader=SimpleNamespace(url="http://qb"), sites=["M-Team"]))
    monkeypatch.setattr(runner, "_state", {
        "running": False, "status": "idle", "message": "", "started_at": None, "finished_at": None})

    def fetch_status():
        entered.set()
        assert release.wait(5)
        raise RuntimeError("qBittorrent connection refused")

    monkeypatch.setattr(runner, "QBTorrentService", lambda: SimpleNamespace(fetch_qb_status=fetch_status))
    execute = runner._execute

    def observed_execute(manual):
        try:
            execute(manual)
        finally:
            finished.set()

    monkeypatch.setattr(runner, "_execute", observed_execute)
    app = Flask(__name__)
    app.register_blueprint(api_runtime.api_runtime_bp)
    client = app.test_client()
    try:
        first = client.post("/api/tasks/brush", json={})
        assert first.status_code == 202
        assert entered.wait(5)
        assert client.get("/api/tasks/brush").json["running"] is True
        assert client.post("/api/tasks/brush", json={}).status_code == 409
        runner.run_brush()
        assert client.get("/api/tasks/brush").json["running"] is True
    finally:
        release.set()
        assert finished.wait(5)
    state = client.get("/api/tasks/brush").json
    assert state["running"] is False
    assert state["status"] == "failed"
    assert state["finished_at"] is not None


def test_low_disk_space_reports_skipped_without_adding_torrents(monkeypatch):
    service = object.__new__(services.BrushService)
    service._config = SimpleNamespace(brush=SimpleNamespace(min_disk_space=1024))
    service._qb = SimpleNamespace(status=SimpleNamespace(free_space_size=0))
    monkeypatch.setattr(runner, "PTBrushConfig", lambda: SimpleNamespace(
        downloader=SimpleNamespace(url="http://qb"), sites=["M-Team"]))
    monkeypatch.setattr(runner, "BrushService", lambda: service)
    monkeypatch.setattr(runner, "_state", {
        "running": False, "status": "idle", "message": "", "started_at": None, "finished_at": None})
    assert runner._reserve()
    runner._execute(manual=False)
    assert runner.brush_status()["status"] == "skipped"
    assert runner.brush_status()["running"] is False


def test_added_count_and_database_flags_reflect_qb_acceptance(mocker):
    service = object.__new__(services.BrushService)
    service._config = SimpleNamespace(sites=[SimpleNamespace(name="M-Team", cookie="", headers=[])])
    service._qb = SimpleNamespace(download_torrent_url=mocker.Mock(side_effect=[True, False]))
    spider = mocker.patch.object(services, "TorrentFetch").return_value
    spider.parse_torrent_link.return_value = "https://site/download"
    spider.download_torrent_content.return_value = b"torrent-content"
    expiry = datetime.now() + timedelta(days=1)
    torrents = [SimpleNamespace(id=str(i), name=f"seed-{i}", site="M-Team", size=1024,
                               free_end_time=expiry) for i in (1, 2)]
    test_db = peewee.SqliteDatabase(":memory:")
    with test_db.bind_ctx([TorrentDB]):
        test_db.create_tables([TorrentDB])
        for torrent in torrents:
            TorrentDB.create(name=torrent.name, site=torrent.site, torrent_id=torrent.id,
                             free_end_time=expiry)
        assert service.add_brush_torrent(torrents) == 1
        assert TorrentDB.get(TorrentDB.torrent_id == "1").brushed is True
        assert TorrentDB.get(TorrentDB.torrent_id == "2").brushed is False
        service._qb.download_torrent_url.side_effect = [False, False]
        assert service.add_brush_torrent(torrents) == 0
    test_db.close()
