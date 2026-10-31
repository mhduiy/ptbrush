"""运行日志与手动刷流接口。"""
import os
import re
from urllib.parse import urlsplit

from flask import Blueprint, jsonify, request

from config.config import CONFIG_FILE_PATH
from tasks.runner import brush_status, start_brush
from web.auth import login_required
from web.config_io import read_raw

api_runtime_bp = Blueprint("api_runtime", __name__)
LOG_PATH = CONFIG_FILE_PATH.parent / "ptbrush.log"
MAX_LOG_BYTES = 64 * 1024


def _redact(text):
    config = read_raw()
    downloader = config.get("downloader", {})
    web = config.get("web", {})
    secrets = [downloader.get("password"), downloader.get("api_key"),
               web.get("password"), web.get("secret_key")]
    for site in config.get("sites", []):
        secrets.append(site.get("cookie"))
        secrets.extend(header.get("value") for header in site.get("headers", []))
    for secret in sorted({s for s in secrets if s}, key=len, reverse=True):
        text = text.replace(secret, "***")
    # 下载链接可能携带临时 token；同时隐藏 URL 中的用户名密码。
    text = re.sub(r"(https?://)[^/\s]+@", r"\1***@", text)
    return re.sub(r"(https?://[^\s?\"'<>]+)\?[^\s\"'<>]*", r"\1?***", text)


@api_runtime_bp.after_request
def no_cache(response):
    response.headers["Cache-Control"] = "no-store"
    return response


@api_runtime_bp.get("/api/logs")
@login_required
def logs():
    cursor = request.args.get("cursor", "")
    previous = None
    if cursor:
        try:
            if len(cursor) > 128:
                raise ValueError
            previous = tuple(int(part) for part in cursor.split(":"))
            if len(previous) != 3 or any(part < 0 for part in previous):
                raise ValueError
        except ValueError:
            return jsonify({"error": "无效的日志游标"}), 400
    try:
        with LOG_PATH.open("rb") as handle:
            stat = os.fstat(handle.fileno())
            same_file = previous and previous[:2] == (stat.st_dev, stat.st_ino)
            reset = not same_file or previous[2] > stat.st_size
            offset = max(0, stat.st_size - MAX_LOG_BYTES) if reset else previous[2]
            handle.seek(offset)
            if offset:
                handle.seek(offset - 1)
                if handle.read(1) != b"\n":
                    skipped = handle.readline(MAX_LOG_BYTES)
                    if not skipped.endswith(b"\n"):
                        return jsonify({"text": "",
                                        "cursor": f"{stat.st_dev}:{stat.st_ino}:{handle.tell()}",
                                        "reset": bool(reset)})
            offset = handle.tell()
            data = handle.read(MAX_LOG_BYTES)
            end = data.rfind(b"\n") + 1
            if end:
                data = data[:end]
                offset += end
            elif len(data) == MAX_LOG_BYTES:
                # 超长单行不返回片段，避免截断凭证后无法脱敏。
                offset += len(data)
                data = b""
            else:
                data = b""
            cursor = f"{stat.st_dev}:{stat.st_ino}:{offset}"
        return jsonify({"text": _redact(data.decode("utf-8", errors="replace")),
                        "cursor": cursor, "reset": bool(reset)})
    except FileNotFoundError:
        return jsonify({"text": "", "cursor": "", "reset": True})
    except OSError:
        return jsonify({"error": "无法读取运行日志，请检查数据目录权限"}), 500


@api_runtime_bp.get("/api/tasks/brush")
@login_required
def task_status():
    return jsonify(brush_status())


@api_runtime_bp.post("/api/tasks/brush")
@login_required
def trigger_brush():
    # 本接口会操作下载器：不接受 HTML 表单或跨站请求。
    origin = request.headers.get("Origin")
    if (not request.is_json or request.headers.get("Sec-Fetch-Site") == "cross-site"
            or (origin and urlsplit(origin) != urlsplit(request.host_url.rstrip("/")))):
        return jsonify({"error": "仅允许同源 JSON 请求"}), 403
    if not start_brush():
        return jsonify({"error": "刷流任务正在运行，请勿重复触发", **brush_status()}), 409
    return jsonify(brush_status()), 202
