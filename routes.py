from __future__ import annotations

import base64
import hashlib
import io
import json
import math
import os
import re
import shutil
import sqlite3
import time
import zipfile
from datetime import datetime
from pathlib import Path

from fastapi import Body, FastAPI


PROFILE_FILE = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "FeedTone" / "mixer-profiles.json"
COMMAND_FILE = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "FeedTone" / "feedback-command.json"
SYNC_DIR = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "FeedTone" / "feedback-sync"
LIVE_FILE = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "FeedTone" / "feedback-live.json"
PLAYBACK_FILE = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "FeedTone" / "feedback-playback.json"
CONTROL_FILE = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "FeedTone" / "feedback-control.json"
_DEFAULT_PACKAGE_BACKUPS = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "FeedTone" / "tone-package-backups"
PACKAGE_BACKUPS = _DEFAULT_PACKAGE_BACKUPS
PACKAGE_SCHEMAS = {"feedtone.tone-package.v1"}
MAX_PACKAGE_BYTES = 128 * 1024 * 1024
MAX_EXPANDED_BYTES = 512 * 1024 * 1024


def _norm(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").casefold())


def _package_backups() -> Path:
    if PACKAGE_BACKUPS != _DEFAULT_PACKAGE_BACKUPS:
        return PACKAGE_BACKUPS
    try:
        workspace = json.loads((Path(os.environ.get("LOCALAPPDATA", Path.home())) / "FeedTone" / "workspace.json").read_text(encoding="utf-8"))
        return Path(workspace["backup_folder"]) / "tone-packages"
    except Exception:
        return PACKAGE_BACKUPS


def _profiles() -> dict:
    try:
        value = json.loads(PROFILE_FILE.read_text(encoding="utf-8"))
        return value.get("profiles", {}) if isinstance(value, dict) else {}
    except Exception:
        return {}


def _write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def _safe_mixer(value: dict) -> dict:
    limits = {
        "song_percent": (0.0, 100.0), "monitor": (0.0, 4.0),
        "input_db": (-24.0, 12.0), "amp_db": (-24.0, 12.0), "nam_output": (0.0, 2.0),
    }
    result = {}
    for key, (minimum, maximum) in limits.items():
        try:
            number = float(value[key])
            if math.isfinite(number): result[key] = max(minimum, min(maximum, number))
        except (KeyError, TypeError, ValueError):
            pass
    return result


def _config_root(context: dict | None = None) -> Path:
    for key in ("config_root", "config_dir", "slopsmith_config"):
        value = str((context or {}).get(key) or "")
        candidate = Path(value) if value else None
        if candidate and candidate.is_dir():
            return candidate
    return Path(os.environ.get("APPDATA", Path.home())) / "feedback-desktop" / "slopsmith-config"


def _archive_json(archive: zipfile.ZipFile, name: str) -> dict:
    try:
        value = json.loads(archive.read(name).decode("utf-8-sig"))
    except (KeyError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(f"Invalid {name}: {error}") from error
    if not isinstance(value, dict):
        raise ValueError(f"Invalid {name}")
    return value


def _verify_archive(archive: zipfile.ZipFile) -> None:
    expanded = 0
    for item in archive.infolist():
        path = Path(item.filename.replace("\\", "/"))
        if path.is_absolute() or ".." in path.parts:
            raise ValueError("The tone package contains an unsafe path")
        expanded += item.file_size
    if expanded > MAX_EXPANDED_BYTES:
        raise ValueError("The expanded tone package is too large")
    try:
        hashes = archive.read("SHA256SUMS.txt").decode("ascii").splitlines()
    except (KeyError, UnicodeDecodeError) as error:
        raise ValueError("The tone package has no valid checksum manifest") from error
    for row in hashes:
        digest, separator, name = row.partition("  ")
        if not separator or hashlib.sha256(archive.read(name)).hexdigest() != digest:
            raise ValueError(f"Tone package checksum failed: {name or 'unknown file'}")


def _copy_package_asset(archive: zipfile.ZipFile, source: str, target: Path) -> None:
    data = archive.read(source)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + ".tmp")
    temporary.write_bytes(data)
    temporary.replace(target)


def _resolve_package_pieces(archive: zipfile.ZipFile, presets: list[dict], config: Path) -> int:
    names = set(archive.namelist())
    copied = 0
    for preset in presets:
        for piece in preset.get("pieces") or []:
            source = str(piece.get("file") or "").replace("\\", "/")
            if source.startswith("assets/models/"):
                if source not in names: raise ValueError(f"Required model is missing: {Path(source).name}")
                target = config / "nam_models" / "feedtone" / Path(source).name
                _copy_package_asset(archive, source, target); copied += 1
                piece["file"] = str(target.resolve()) if piece.get("kind") == "nam_fullchain" else f"feedtone/{target.name}"
            elif source.startswith("assets/irs/"):
                if source not in names: raise ValueError(f"Required IR is missing: {Path(source).name}")
                target = config / "nam_irs" / "feedtone" / Path(source).name
                _copy_package_asset(archive, source, target); copied += 1
                piece["file"] = f"feedtone/{target.name}"
            dependency = piece.get("dependency") if isinstance(piece.get("dependency"), dict) else {}
            if piece.get("kind") == "vst":
                route = str(dependency.get("route") or "").replace("/", os.sep)
                candidates = [config / route, config / "vst" / Path(route).name]
                installed = next((path for path in candidates if path.exists()), None)
                if installed: piece["vst_path"] = str(installed.resolve())
                elif not Path(str(piece.get("vst_path") or "")).exists():
                    raise ValueError(f"Required Rig Builder device is missing: {dependency.get('name') or Path(route).name}")
    return copied


def _database(config: Path) -> Path | None:
    return next((path for path in (config / "nam_tone.db", config / "rig_builder_cache.db") if path.is_file()), None)


def _sqlite_backup(source: Path, target: Path) -> None:
    reader = sqlite3.connect(source, timeout=15)
    writer = sqlite3.connect(target)
    try: reader.backup(writer)
    finally: writer.close(); reader.close()


def _backup_package_state(target: str, config: Path) -> Path:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    backups = _package_backups()
    root = backups / f"{_norm(target)}-{stamp}"
    root.mkdir(parents=True, exist_ok=True)
    sync = SYNC_DIR / f"{_norm(target)}.json"
    if sync.is_file(): shutil.copy2(sync, root / "sync.json")
    if PROFILE_FILE.is_file(): shutil.copy2(PROFILE_FILE, root / "mixer-profiles.json")
    database = _database(config)
    if database: _sqlite_backup(database, root / "rig-builder.sqlite")
    _write_json(root / "backup.json", {"target": target, "database": str(database or ""), "created_at": time.time()})
    _write_json(backups / f"{_norm(target)}-latest.json", {"path": str(root)})
    return root


def _import_package_blob(data: bytes, target: str, title: str = "", artist: str = "", config: Path | None = None) -> dict:
    target = Path(str(target or "")).name
    if not target.casefold().endswith((".feedpak", ".sloppak")):
        raise ValueError("Open the matching song in FeedBack before importing its tone")
    if len(data) > MAX_PACKAGE_BYTES:
        raise ValueError("The tone package is too large")
    config = Path(config) if config else _config_root()
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        _verify_archive(archive)
        package = _archive_json(archive, "tone-package.json")
        if package.get("schema") not in PACKAGE_SCHEMAS:
            raise ValueError("This tone package version is not supported")
        song = package.get("song") if isinstance(package.get("song"), dict) else {}
        if title and song.get("title") and _norm(title) != _norm(song["title"]):
            raise ValueError(f"This package is for {song.get('artist', '')} - {song['title']}, not the open song")
        if artist and song.get("artist") and _norm(artist) != _norm(song["artist"]):
            raise ValueError(f"This package is for {song['artist']} - {song.get('title', '')}, not the open song")
        payload = _archive_json(archive, "presets.json")
        presets = [item for item in payload.get("presets") or [] if isinstance(item, dict)]
        if not presets: raise ValueError("The tone package contains no playable presets")
        copied = _resolve_package_pieces(archive, presets, config)
    backup = _backup_package_state(target, config)
    payload.update({"filename": target, "title": str(song.get("title") or title), "artist": str(song.get("artist") or artist), "native_persisted": False})
    for preset in presets:
        preset["filename"] = target
        preset["name"] = f"{target}::{preset.get('tone_key') or 'tone'}"
    SYNC_DIR.mkdir(parents=True, exist_ok=True)
    _write_json(SYNC_DIR / f"{_norm(target)}.json", payload)
    profiles = {"version": 2, "profiles": {}}
    try: profiles = json.loads(PROFILE_FILE.read_text(encoding="utf-8"))
    except Exception: pass
    entry = profiles.setdefault("profiles", {}).setdefault(_norm(target), {"filename": target, "title": payload["title"], "artist": payload["artist"], "arrangements": {}})
    for preset in presets:
        arrangement = entry.setdefault("arrangements", {}).setdefault(_norm(preset.get("feedtone_arrangement")), {"tones": {}})
        arrangement.setdefault("tones", {})[str(preset.get("tone_key") or "tone")] = _safe_mixer(preset.get("mixer") or {})
    _write_json(PROFILE_FILE, profiles)
    return {"ok": True, "target": target, "tones": len(presets), "assets": copied, "backup": str(backup)}


def _restore_package_state(target: str, config: Path | None = None) -> dict:
    target = Path(str(target or "")).name
    pointer = _package_backups() / f"{_norm(target)}-latest.json"
    try: root = Path(json.loads(pointer.read_text(encoding="utf-8"))["path"])
    except Exception as error: raise FileNotFoundError("No previous tone-package state exists for this song") from error
    sync = SYNC_DIR / f"{_norm(target)}.json"
    if (root / "sync.json").is_file(): shutil.copy2(root / "sync.json", sync)
    else: sync.unlink(missing_ok=True)
    if (root / "mixer-profiles.json").is_file(): shutil.copy2(root / "mixer-profiles.json", PROFILE_FILE)
    database = _database(Path(config) if config else _config_root())
    if database and (root / "rig-builder.sqlite").is_file(): _sqlite_backup(root / "rig-builder.sqlite", database)
    pointer.unlink(missing_ok=True)
    return {"ok": True, "target": target, "restart_required": bool(database)}


def _command() -> dict:
    try:
        value = json.loads(COMMAND_FILE.read_text(encoding="utf-8"))
        filename = str(value.get("filename") or "").replace("\\", "/")
        created_at = float(value.get("created_at") or 0)
        valid = (
            bool(value.get("nonce"))
            and filename.casefold().endswith((".feedpak", ".sloppak"))
            and not Path(filename).is_absolute()
            and ".." not in Path(filename).parts
            and created_at > 0
        )
        return value if valid else {}
    except Exception:
        return {}


def setup(app: FastAPI, context: dict) -> None:
    config = _config_root(context)

    @app.post("/api/plugins/feedtone_bridge/package/import")
    def import_tone_package(payload: dict = Body(default_factory=dict)):
        try:
            encoded = str(payload.get("data") or "")
            if "," in encoded: encoded = encoded.split(",", 1)[1]
            return _import_package_blob(base64.b64decode(encoded, validate=True), str(payload.get("target_filename") or ""), str(payload.get("title") or ""), str(payload.get("artist") or ""), config)
        except Exception as error:
            return {"ok": False, "reason": str(error)}

    @app.post("/api/plugins/feedtone_bridge/package/restore")
    def restore_tone_package(payload: dict = Body(default_factory=dict)):
        try: return _restore_package_state(str(payload.get("target_filename") or ""), config)
        except Exception as error: return {"ok": False, "reason": str(error)}

    @app.post("/api/plugins/feedtone_bridge/playback")
    def playback_context(payload: dict = Body(default_factory=dict)):
        """Publish only non-audio playback context for the local FeedTone UI."""
        mixer = payload.get("mixer") if isinstance(payload.get("mixer"), dict) else {}
        safe_mixer = _safe_mixer(mixer)
        safe = {
            "version": 1,
            "updated_at": time.time(),
            "filename": str(payload.get("filename") or "")[:512],
            "title": str(payload.get("title") or "")[:256],
            "artist": str(payload.get("artist") or "")[:256],
            "arrangement": str(payload.get("arrangement") or "")[:128],
            "tone": str(payload.get("tone") or "")[:256],
            "source_tone": str(payload.get("source_tone") or "")[:256],
            "position_ms": max(0, int(float(payload.get("position_ms") or 0))),
            "playing": bool(payload.get("playing")),
            "mixer": safe_mixer,
        }
        PLAYBACK_FILE.parent.mkdir(parents=True, exist_ok=True)
        temporary = PLAYBACK_FILE.with_suffix(".tmp")
        temporary.write_text(json.dumps(safe, ensure_ascii=False), encoding="utf-8")
        temporary.replace(PLAYBACK_FILE)
        return {"ok": True}

    @app.post("/api/plugins/feedtone_bridge/mix")
    def save_tone_mix(payload: dict = Body(default_factory=dict)):
        """Persist the visible mixer for one FeedPak arrangement and tone."""
        filename = Path(str(payload.get("filename") or "")).name
        arrangement = str(payload.get("arrangement") or "")[:128]
        tone = str(payload.get("tone") or "")[:256]
        source_tone = str(payload.get("source_tone") or "")[:256]
        mixer = _safe_mixer(payload.get("mixer") if isinstance(payload.get("mixer"), dict) else {})
        if not filename.casefold().endswith((".feedpak", ".sloppak")) or not arrangement or not tone or not mixer:
            return {"ok": False, "reason": "filename, arrangement, tone and mixer are required"}
        mixer.update({"automate": ["song", "monitor", "input", "amp", "nam"], "source": "user", "manual_override": True, "gain_contract_version": 7})

        sync_path = SYNC_DIR / f"{_norm(filename)}.json"
        updated = 0
        try:
            staged = json.loads(sync_path.read_text(encoding="utf-8"))
            if _norm(staged.get("filename")) != _norm(filename):
                return {"ok": False, "reason": "the staged song does not match"}
            for preset in staged.get("presets", []):
                if (_norm(preset.get("feedtone_arrangement")) == _norm(arrangement)
                        and _norm(preset.get("tone_key")) == _norm(tone)):
                    preset["mixer"] = dict(mixer)
                    updated += 1
            if not updated: return {"ok": False, "reason": "the selected tone is not staged"}
            _write_json(sync_path, staged)
        except Exception as error:
            return {"ok": False, "reason": str(error)}

        try:
            data = json.loads(PROFILE_FILE.read_text(encoding="utf-8")) if PROFILE_FILE.is_file() else {"version": 2, "profiles": {}}
            profiles = data.setdefault("profiles", {})
            entry = profiles.setdefault(_norm(filename), {})
            entry.update({"filename": filename, "title": str(payload.get("title") or "")[:256], "artist": str(payload.get("artist") or "")[:256]})
            selected = entry.setdefault("arrangements", {}).setdefault(_norm(arrangement), {})
            tones = selected.setdefault("tones", {})
            tones[tone] = dict(mixer)
            if source_tone: tones[source_tone] = dict(mixer)
            _write_json(PROFILE_FILE, data)
        except Exception as error:
            return {"ok": False, "reason": f"mixer profile could not be saved: {error}"}
        return {"ok": True, "updated": updated, "filename": filename, "arrangement": arrangement, "tone": tone}

    @app.get("/api/plugins/feedtone_bridge/control")
    def pending_control():
        try:
            value = json.loads(CONTROL_FILE.read_text(encoding="utf-8"))
            valid = (
                value.get("version") == 1 and value.get("action") == "seek"
                and bool(value.get("nonce")) and time.time() - float(value.get("created_at") or 0) < 10
                and str(value.get("filename") or "").casefold().endswith((".feedpak", ".sloppak"))
            )
            if not valid: return {"ok": True, "pending": False}
            return {"ok": True, "pending": True, "nonce": str(value["nonce"]), "action": "seek", "position_ms": max(0, int(value.get("position_ms") or 0)), "filename": Path(str(value["filename"])).name}
        except Exception:
            return {"ok": True, "pending": False}

    @app.post("/api/plugins/feedtone_bridge/control/ack")
    def acknowledge_control(nonce: str = ""):
        try:
            value = json.loads(CONTROL_FILE.read_text(encoding="utf-8"))
            if str(value.get("nonce")) != str(nonce): return {"ok": False, "acknowledged": False}
            CONTROL_FILE.unlink(missing_ok=True)
            return {"ok": True, "acknowledged": True}
        except Exception:
            return {"ok": False, "acknowledged": False}

    @app.get("/api/plugins/feedtone_bridge/live")
    def live_preview():
        import time
        try:
            value = json.loads(LIVE_FILE.read_text(encoding="utf-8"))
            preset = value.get("preset")
            valid = (
                value.get("version") == 1
                and isinstance(preset, dict)
                and preset.get("filename") == "__feedtone_live__.feedpak"
                and preset.get("tone_key") == "live"
                and isinstance(preset.get("pieces"), list)
                and time.time() - float(value.get("created_at") or 0) < 10
            )
            return {"ok": True, "active": bool(valid), **(value if valid else {})}
        except Exception:
            return {"ok": True, "active": False}

    @app.get("/api/plugins/feedtone_bridge/rig-sync")
    def rig_sync(filename: str = ""):
        key = _norm(Path(filename).name)
        path = SYNC_DIR / f"{key}.json"
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            if _norm(value.get("filename")) != key or not isinstance(value.get("presets"), list):
                return {"ok": True, "matched": False}
            stat = path.stat()
            return {
                "ok": True,
                "matched": True,
                "presets": value["presets"],
                "native_persisted": bool(value.get("native_persisted")),
                # The renderer must not keep an earlier rig after the user
                # edits and reopens the same FeedPak during one game session.
                "revision": f"{stat.st_mtime_ns}:{stat.st_size}",
            }
        except Exception:
            return {"ok": True, "matched": False}

    @app.get("/api/plugins/feedtone_bridge/profile")
    def profile(filename: str = "", arrangement: str = "", tone: str = "", settings_key: str = "", title: str = "", artist: str = ""):
        profiles = _profiles()
        filename_key = _norm(Path(filename).name)
        filename_stem = _norm(Path(filename).stem)
        settings_norm = _norm(settings_key)
        candidates = []
        if filename_key and filename_key in profiles:
            candidates.append(profiles[filename_key])
        wanted_title, wanted_artist = _norm(title), _norm(artist)
        for entry in profiles.values():
            if entry in candidates:
                continue
            entry_stem = _norm(Path(str(entry.get("filename") or "")).stem)
            identity = _norm(f"{entry.get('artist', '')}-{entry.get('title', '')}")
            metadata_match = wanted_title and _norm(entry.get("title")) == wanted_title and (not wanted_artist or _norm(entry.get("artist")) == wanted_artist)
            file_match = filename_stem and entry_stem and filename_stem == entry_stem
            settings_match = settings_norm and identity and (identity in settings_norm or settings_norm in identity)
            if metadata_match or file_match or settings_match:
                candidates.append(entry)
        if not candidates:
            return {"ok": True, "matched": False, "settings_key": settings_key}
        aliases = [_norm(arrangement)]
        match = re.search(r"(\d+)$", str(arrangement or ""))
        if match:
            aliases.extend([match.group(1), _norm(f"arrangement-{match.group(1)}")])
        arrangements = candidates[0].get("arrangements", {})
        selected = next((arrangements[key] for key in aliases if key in arrangements), None)
        distinct = {json.dumps(value, sort_keys=True) for value in arrangements.values()}
        if selected is None and len(distinct) == 1:
            selected = next(iter(arrangements.values()), None)
        if selected and tone:
            wanted = _norm(tone)
            tone_profiles = selected.get("tones", {}) if isinstance(selected, dict) else {}
            selected_tone = next((value for key, value in tone_profiles.items() if _norm(key) == wanted), None)
            if isinstance(selected_tone, dict):
                selected = selected_tone
        return {"ok": True, "matched": bool(selected), "profile": selected or {}, "settings_key": settings_key, "automatic": bool(selected and not selected.get("manual_override"))}

    @app.get("/api/plugins/feedtone_bridge/status")
    def status():
        return {"ok": True, "profile_file": str(PROFILE_FILE), "exists": PROFILE_FILE.is_file(), "songs": len(_profiles())}

    @app.get("/api/plugins/feedtone_bridge/command")
    def pending_command():
        import time
        value = _command()
        if not value:
            return {"ok": True, "pending": False}
        if time.time() - float(value["created_at"]) > 900:
            return {"ok": True, "pending": False, "reason": "expired"}
        return {
            "ok": True,
            "pending": True,
            "nonce": value["nonce"],
            "filename": value["filename"],
            "arrangement_index": value.get("arrangement_index"),
            "arrangement": str(value.get("arrangement") or "")[:128],
        }

    @app.post("/api/plugins/feedtone_bridge/command/ack")
    def acknowledge_command(nonce: str = ""):
        value = _command()
        if not value or str(value.get("nonce")) != str(nonce):
            return {"ok": False, "acknowledged": False}
        try:
            COMMAND_FILE.unlink(missing_ok=True)
        except Exception:
            return {"ok": False, "acknowledged": False}
        return {"ok": True, "acknowledged": True}
