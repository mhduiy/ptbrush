"""定时与手动刷流共用执行状态，避免重复添加种子。"""
from datetime import datetime
from threading import Lock, Thread
from time import sleep

from loguru import logger

from config.config import PTBrushConfig
from tasks.services import BrushService, PtTorrentService, QBTorrentService

_lock = Lock()
_state = {
    "running": False,
    "status": "idle",
    "message": "尚未执行刷流任务",
    "started_at": None,
    "finished_at": None,
}


def brush_status():
    with _lock:
        return dict(_state)


def _reserve():
    with _lock:
        if _state["running"]:
            return False
        _state.update(running=True, status="running", message="正在执行刷流任务",
                      started_at=datetime.now().isoformat(timespec="seconds"), finished_at=None)
        return True


def _execute(manual):
    status = "succeeded"
    message = "本轮执行结束，添加数量及跳过原因请查看日志"
    try:
        logger.info("{}刷流任务开始", "手动" if manual else "定时")
        config = PTBrushConfig()
        if not config.downloader or not config.downloader.url:
            raise ValueError("未配置 qBittorrent 地址，请先在配置页填写")
        if not config.sites:
            raise ValueError("未配置 PT 站点，请先在配置页填写")
        if manual:
            logger.info("手动执行：忽略工作时间限制，保留磁盘、速度和下载数量限制")
            logger.info("手动执行：先采集 qBittorrent 状态")
            QBTorrentService().fetch_qb_status()
            logger.info("手动执行：先抓取 PT 站点 FREE 种子")
            PtTorrentService().fetcher()
        count = BrushService().brush()
        if count > 0:
            logger.info("本轮成功添加 {} 个种子，1分钟后开始拆包", count)
            sleep(60)
            QBTorrentService().torrent_thinned()
        else:
            status = "skipped"
            message = "本轮未添加种子，请查看日志中的限制条件或种子下载失败原因"
        logger.info(message)
    except Exception:
        status = "failed"
        message = "刷流执行失败，请打开运行日志查看具体原因"
        logger.opt(exception=True).error(message)
    finally:
        with _lock:
            _state.update(running=False, status=status, message=message,
                          finished_at=datetime.now().isoformat(timespec="seconds"))


def run_brush():
    if not _reserve():
        logger.info("刷流任务正在运行，跳过本次定时执行")
        return
    _execute(manual=False)


def start_brush():
    if not _reserve():
        return False
    try:
        Thread(target=_execute, args=(True,), name="manual-brush", daemon=True).start()
    except Exception:
        with _lock:
            _state.update(running=False, status="failed", message="无法启动刷流线程",
                          finished_at=datetime.now().isoformat(timespec="seconds"))
        logger.opt(exception=True).error("无法启动刷流线程")
        raise
    return True
