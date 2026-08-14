"""Wormhole launcher bootstrap.

Optional Chromium flags (proxy + CDP) must be set BEFORE any Qt import, so
QWebEngine's Chromium subprocess picks them up — setting them after
QtWebEngineWidgets is imported is too late on Windows: the renderer process is
already running and ignores the argv.

By default the embedded browser connects DIRECTLY (viewer mode — no proxy
infrastructure is expected to be running). Set the env vars below to opt in:

  WORMHOLE_GUI_PROXY=1   route ALL browser traffic through a local proxy
                         (WORMHOLE_PROXY_PORT, default 18080). Also ignores the
                         proxy's self-signed cert errors.
  WORMHOLE_GUI_CDP=1     expose CDP remote debugging on 0.0.0.0:9222
                         (WORMHOLE_CDP_PORT) for external browser automation.
"""
import os


def main() -> int:
    cdp_port = os.environ.get("WORMHOLE_CDP_PORT", "9222")
    proxy_port = os.environ.get("WORMHOLE_PROXY_PORT", "18080")

    flags = os.environ.get("QTWEBENGINE_CHROMIUM_FLAGS", "")
    if os.environ.get("WORMHOLE_GUI_PROXY") == "1":
        # --proxy-server routes ALL browser traffic through the local proxy.
        # --proxy-bypass-list="<-loopback>" is REQUIRED — Chromium bypasses the
        #   proxy for localhost by default, so without it localhost targets
        #   never reach the proxy and 0 flows are captured.
        # --ignore-certificate-errors: the proxy uses its own CA.
        p = (f"--proxy-server=http://127.0.0.1:{proxy_port} "
             f"--proxy-bypass-list=<-loopback> --ignore-certificate-errors")
        flags = f"{flags} {p}" if flags else p
    if flags:
        os.environ["QTWEBENGINE_CHROMIUM_FLAGS"] = flags
    if os.environ.get("WORMHOLE_GUI_CDP") == "1":
        os.environ["QTWEBENGINE_REMOTE_DEBUGGING"] = f"0.0.0.0:{cdp_port}"

    # NOW import the GUI (QtWebEngineWidgets init reads the env above)
    from wormhole.ui.main_window import main as gui_main
    return gui_main()


if __name__ == "__main__":
    raise SystemExit(main())
