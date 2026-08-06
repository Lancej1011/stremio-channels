#!/usr/bin/env python3
"""Native Linux shell for the local Headend viewer."""

from __future__ import annotations

import argparse
import os
import shutil
import stat
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import Gdk, Gio, GLib, Gtk, WebKit2  # noqa: E402


APP_ID = "io.headend.Desktop"
DEFAULT_URL = "http://127.0.0.1:7654/watch"
SERVICE = "stremio-channels.service"


def install_launcher(source: Path) -> int:
    home = Path.home()
    bin_dir = home / ".local" / "bin"
    app_dir = home / ".local" / "share" / "applications"
    icon_dir = home / ".local" / "share" / "icons" / "hicolor" / "scalable" / "apps"
    for directory in (bin_dir, app_dir, icon_dir):
        directory.mkdir(parents=True, exist_ok=True)

    executable = bin_dir / "headend"
    shutil.copy2(source, executable)
    executable.chmod(executable.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

    candidates = [
        source.parent.parent / "src" / "viewer" / "icon.svg",
        Path(__file__).resolve().parent.parent / "src" / "viewer" / "icon.svg",
    ]
    icon_source = next((path for path in candidates if path.exists()), None)
    icon_target = icon_dir / "headend.svg"
    if icon_source:
        shutil.copy2(icon_source, icon_target)

    desktop = app_dir / "headend.desktop"
    desktop.write_text(
        "\n".join(
            [
                "[Desktop Entry]",
                "Type=Application",
                "Name=Headend",
                "Comment=Watch private clock-synced channels",
                f"Exec={executable}",
                f"Icon={icon_target if icon_target.exists() else 'video-display'}",
                "Terminal=false",
                "StartupNotify=true",
                "Categories=AudioVideo;Video;Player;",
                "Keywords=TV;Guide;Channels;HLS;",
                "",
            ]
        ),
        encoding="utf-8",
    )
    desktop.chmod(0o644)
    subprocess.run(["update-desktop-database", str(app_dir)], check=False, capture_output=True)
    print(f"Installed Headend launcher: {desktop}")
    print("Open Headend from your application menu or run: headend")
    return 0


class HeadendWindow(Gtk.ApplicationWindow):
    def __init__(self, application: Gtk.Application, viewer_url: str):
        super().__init__(application=application, title="Headend")
        self.viewer_url = viewer_url.rstrip("/")
        parsed = urlparse(self.viewer_url)
        self.allowed_origin = f"{parsed.scheme}://{parsed.netloc}"
        self.set_default_size(1280, 800)
        self.set_size_request(720, 480)
        self.set_icon_name("headend")
        self._fullscreen = False

        self.header = Gtk.HeaderBar(title="Headend", subtitle="Connecting to the local channel service")
        self.header.set_show_close_button(True)
        self.set_titlebar(self.header)

        self.previous_button = self._header_button("go-previous-symbolic", "Previous channel", "previous-channel")
        self.guide_button = self._header_button("view-list-symbolic", "Program guide", "guide-button")
        self.next_button = self._header_button("go-next-symbolic", "Next channel", "next-channel")
        self.header.pack_start(self.previous_button)
        self.header.pack_start(self.guide_button)
        self.header.pack_start(self.next_button)

        self.reload_button = Gtk.Button.new_from_icon_name("view-refresh-symbolic", Gtk.IconSize.BUTTON)
        self.reload_button.set_tooltip_text("Reload Headend")
        self.reload_button.connect("clicked", lambda _button: self._connect_service())
        self.fullscreen_button = Gtk.Button.new_from_icon_name("view-fullscreen-symbolic", Gtk.IconSize.BUTTON)
        self.fullscreen_button.set_tooltip_text("Fullscreen (F11)")
        self.fullscreen_button.connect("clicked", lambda _button: self.toggle_fullscreen())
        self.header.pack_end(self.fullscreen_button)
        self.header.pack_end(self.reload_button)

        self.overlay = Gtk.Overlay()
        self.add(self.overlay)

        context = WebKit2.WebContext.get_default()
        self.webview = WebKit2.WebView.new_with_context(context)
        settings = self.webview.get_settings()
        settings.set_enable_fullscreen(True)
        settings.set_enable_javascript(True)
        settings.set_enable_media_stream(True)
        if hasattr(settings, "set_hardware_acceleration_policy"):
            settings.set_hardware_acceleration_policy(WebKit2.HardwareAccelerationPolicy.ON_DEMAND)
        if hasattr(settings, "set_media_playback_requires_user_gesture"):
            settings.set_media_playback_requires_user_gesture(False)
        self.webview.connect("load-changed", self._load_changed)
        self.webview.connect("load-failed", self._load_failed)
        self.webview.connect("decide-policy", self._decide_policy)
        self.webview.connect("enter-fullscreen", self._web_enter_fullscreen)
        self.webview.connect("leave-fullscreen", self._web_leave_fullscreen)
        self.overlay.add(self.webview)

        self.status_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        self.status_box.set_halign(Gtk.Align.CENTER)
        self.status_box.set_valign(Gtk.Align.CENTER)
        self.status_box.set_size_request(420, -1)
        self.spinner = Gtk.Spinner()
        self.status_title = Gtk.Label()
        self.status_title.set_markup("<span size='x-large' weight='bold'>Starting Headend</span>")
        self.status_detail = Gtk.Label(label="Checking the local channel service…")
        self.status_detail.set_line_wrap(True)
        self.status_detail.set_justify(Gtk.Justification.CENTER)
        self.recover_button = Gtk.Button(label="Restart Headend service")
        self.recover_button.set_halign(Gtk.Align.CENTER)
        self.recover_button.connect("clicked", lambda _button: self._restart_service())
        for widget in (self.spinner, self.status_title, self.status_detail, self.recover_button):
            self.status_box.pack_start(widget, False, False, 0)
        self.overlay.add_overlay(self.status_box)

        self.connect("key-press-event", self._key_press)
        self.connect("window-state-event", self._window_state)
        self.show_all()
        self.recover_button.hide()
        self.spinner.start()
        self._connect_service()

    def _header_button(self, icon: str, tooltip: str, element_id: str) -> Gtk.Button:
        button = Gtk.Button.new_from_icon_name(icon, Gtk.IconSize.BUTTON)
        button.set_tooltip_text(tooltip)
        button.connect("clicked", lambda _button: self._click_viewer(element_id))
        return button

    def _set_status(self, title: str, detail: str, recover: bool = False) -> None:
        self.status_title.set_markup(f"<span size='x-large' weight='bold'>{GLib.markup_escape_text(title)}</span>")
        self.status_detail.set_text(detail)
        self.status_box.show()
        if recover:
            self.spinner.stop()
            self.spinner.hide()
            self.recover_button.show()
        else:
            self.recover_button.hide()
            self.spinner.show()
            self.spinner.start()

    def _connect_service(self) -> None:
        self._set_status("Starting Headend", "Checking the local channel service…")
        threading.Thread(target=self._probe_service, daemon=True).start()

    def _probe_service(self) -> None:
        if not self._reachable():
            subprocess.run(["systemctl", "--user", "start", SERVICE], check=False, capture_output=True)
            for _ in range(20):
                time.sleep(0.5)
                if self._reachable():
                    break
        if self._reachable():
            GLib.idle_add(self.webview.load_uri, self.viewer_url)
        else:
            GLib.idle_add(
                self._set_status,
                "Headend is unavailable",
                f"The application could not reach {self.viewer_url}. Check the service configuration or restart it.",
                True,
            )

    def _reachable(self) -> bool:
        try:
            request = urllib.request.Request(self.viewer_url, method="HEAD")
            with urllib.request.urlopen(request, timeout=2) as response:
                return 200 <= response.status < 400
        except (urllib.error.URLError, TimeoutError, OSError):
            return False

    def _restart_service(self) -> None:
        self._set_status("Restarting Headend", "Waiting for the local channel service…")
        subprocess.run(["systemctl", "--user", "restart", SERVICE], check=False, capture_output=True)
        self._connect_service()

    def _load_changed(self, _view: WebKit2.WebView, event: WebKit2.LoadEvent) -> None:
        if event == WebKit2.LoadEvent.FINISHED:
            self.spinner.stop()
            self.status_box.hide()
            self.header.set_subtitle(urlparse(self.viewer_url).netloc)

    def _load_failed(self, _view, _event, _uri, error) -> bool:
        self._set_status("Viewer failed to load", str(error), True)
        return True

    def _decide_policy(self, _view, decision, decision_type) -> bool:
        if decision_type != WebKit2.PolicyDecisionType.NAVIGATION_ACTION:
            return False
        uri = decision.get_navigation_action().get_request().get_uri()
        if uri.startswith(self.allowed_origin):
            return False
        decision.ignore()
        return True

    def _click_viewer(self, element_id: str) -> None:
        script = f"document.getElementById({element_id!r})?.click()"
        self.webview.run_javascript(script, None, None, None)
        self.webview.grab_focus()

    def _key_press(self, _widget, event: Gdk.EventKey) -> bool:
        ctrl = bool(event.state & Gdk.ModifierType.CONTROL_MASK)
        if event.keyval == Gdk.KEY_F11:
            self.toggle_fullscreen()
            return True
        if event.keyval == Gdk.KEY_Escape and self._fullscreen:
            self.unfullscreen()
            return True
        if ctrl and event.keyval in (Gdk.KEY_r, Gdk.KEY_R):
            self.webview.reload_bypass_cache()
            return True
        if ctrl and event.keyval in (Gdk.KEY_g, Gdk.KEY_G):
            self._click_viewer("guide-button")
            return True
        return False

    def toggle_fullscreen(self) -> None:
        if self._fullscreen:
            self.unfullscreen()
        else:
            self.fullscreen()

    def _window_state(self, _window, event: Gdk.EventWindowState) -> bool:
        self._fullscreen = bool(event.new_window_state & Gdk.WindowState.FULLSCREEN)
        self.header.set_visible(not self._fullscreen)
        return False

    def _web_enter_fullscreen(self, _view) -> bool:
        self.fullscreen()
        return True

    def _web_leave_fullscreen(self, _view) -> bool:
        self.unfullscreen()
        return True


class HeadendApplication(Gtk.Application):
    def __init__(self, viewer_url: str):
        super().__init__(application_id=APP_ID, flags=Gio.ApplicationFlags.FLAGS_NONE)
        self.viewer_url = viewer_url

    def do_activate(self) -> None:
        gtk_settings = Gtk.Settings.get_default()
        if gtk_settings is not None:
            gtk_settings.set_property("gtk-application-prefer-dark-theme", True)
        window = self.get_active_window()
        if window is None:
            window = HeadendWindow(self, self.viewer_url)
        window.present()


def main() -> int:
    parser = argparse.ArgumentParser(description="Headend Linux desktop application")
    parser.add_argument("--url", default=os.environ.get("HEADEND_URL", DEFAULT_URL), help="Headend /watch URL")
    parser.add_argument("--install", action="store_true", help="Install the user application launcher")
    args = parser.parse_args()
    if args.install:
        return install_launcher(Path(__file__).resolve())
    return HeadendApplication(args.url).run(sys.argv[:1])


if __name__ == "__main__":
    raise SystemExit(main())
