"""Probe public YouTube caption metadata and time axes without browser credentials.

Usage: python3 docs/validation/youtube-caption-probe.py VIDEO_ID
Outputs metadata only. Caption text, when available, stays in /tmp for timing tests.
"""
import hashlib
import http.cookiejar
import json
from pathlib import Path
import re
import sys
import time
import urllib.parse
import urllib.request

video_id = sys.argv[1]
if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
    raise ValueError("INVALID_VIDEO_ID")
opener = urllib.request.build_opener(
    urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
)


def get(url, limit):
    started = time.monotonic()
    with opener.open(url, timeout=25) as response:
        body = response.read(limit + 1)
        if len(body) > limit:
            raise ValueError("RESPONSE_TOO_LARGE")
        return body, {
            "status": response.status,
            "bytes": len(body),
            "durationMs": round((time.monotonic() - started) * 1000),
            "contentType": response.headers.get("Content-Type"),
        }


report = {"videoId": video_id, "signedIn": False, "transport": "public HTTP, not extension"}
try:
    page, report["watchPage"] = get("https://www.youtube.com/watch?v=" + video_id, 5_000_000)
    html = page.decode("utf-8")
    match = re.search(r"(?:var\s+)?ytInitialPlayerResponse\s*=\s*", html)
    if not match:
        raise ValueError("PLAYER_RESPONSE_MISSING")
    player, _ = json.JSONDecoder().raw_decode(html[match.end():])
    report["playability"] = player.get("playabilityStatus", {}).get("status")
    tracks = player.get("captions", {}).get("playerCaptionsTracklistRenderer", {}).get("captionTracks", [])
    report["tracks"] = [{"language": t.get("languageCode"), "kind": t.get("kind", "manual"),
                         "translatable": t.get("isTranslatable")} for t in tracks]
    report["fetches"] = []
    selected = [t for t in tracks if t.get("languageCode") == "en"][:2]
    for track in selected:
        entry = {"language": "en", "kind": track.get("kind", "manual")}
        report["fetches"].append(entry)
        try:
            url = urllib.parse.urlsplit(track["baseUrl"])
            if url.scheme != "https" or url.hostname != "www.youtube.com" or url.path != "/api/timedtext":
                raise ValueError("UNEXPECTED_CAPTION_ORIGIN")
            params = [(k, v) for k, v in urllib.parse.parse_qsl(url.query) if k != "fmt"]
            params.append(("fmt", "json3"))
            caption_url = urllib.parse.urlunsplit(url._replace(query=urllib.parse.urlencode(params)))
            body, entry["response"] = get(caption_url, 2_000_000)
            if not body:
                entry["outcome"] = "empty-body"
                # Check the exact supplied URL once to rule out fmt mutation as the cause.
                original, entry["unmodifiedUrlResponse"] = get(track["baseUrl"], 2_000_000)
                entry["unmodifiedUrlEmpty"] = not original
                continue
            payload = json.loads(body)
            cues = [{"startMs": e.get("tStartMs"), "durationMs": e.get("dDurationMs"),
                     "text": "".join(s.get("utf8", "") for s in e.get("segs", []))}
                    for e in payload.get("events", []) if e.get("segs")]
            cues = [c for c in cues if c["text"].strip()]
            valid = bool(cues) and all(isinstance(c["startMs"], (int, float)) and
                                       isinstance(c["durationMs"], (int, float)) for c in cues)
            entry.update(outcome="timed-cues" if valid else "no-valid-timeline", cueCount=len(cues),
                         sha256=hashlib.sha256(body).hexdigest())
            if valid:
                entry.update(firstStartMs=cues[0]["startMs"], lastStartMs=cues[-1]["startMs"],
                             totalCharacters=sum(len(c["text"]) for c in cues))
                Path(f"/tmp/sayvia-youtube-{video_id}-{entry['kind']}-cues.json").write_text(json.dumps(cues))
        except Exception as error:
            # Never write signed caption URLs, cookie values or raw server error bodies.
            entry["outcome"] = "fetch-error"
            entry["errorType"] = type(error).__name__
except Exception as error:
    report["errorType"] = type(error).__name__
print(json.dumps(report, ensure_ascii=False, indent=2))
