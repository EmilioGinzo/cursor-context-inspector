"""mitmproxy add-on: records everything Cursor sends to and receives from its servers.

Run:    mitmdump -q -p 8080 -s tools/cursor-wire.py [--set wire_dir=DIR]
        (or `tools/cursor-wire start`, which does this in the background)
Cursor: /usr/share/cursor/cursor --proxy-server=http://127.0.0.1:8080

Bodies stream through untouched (Cursor's agent RPCs are bidirectional HTTP/2
streams), and every chunk is appended, gzipped, as it passes. One folder per flow,
<wire_dir>/<day>/<time>-<n>-<path>/:
  meta.json            method, url, http version, headers, status, trailers
                       (grpc-status lives there), timings, bytes, error
  request.bin.gz       request body exactly as sent (gRPC/Connect frames)
  response.bin.gz      response body exactly as received
  websocket.jsonl.gz   one line per WebSocket message, if the flow upgrades
and one line per finished flow in <wire_dir>/<day>/flows.jsonl.

Nothing is capped or discarded. Authorization, cookie and API key values are
redacted in meta.json; bodies are kept as they are.
"""

import base64
import gzip
import itertools
import json
import os
import re
import time

from mitmproxy import ctx, http

SECRET_HEADERS = {"authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key", "api-key"}
SECRET_PATTERN = re.compile(r"(token|secret|password|api[-_]?key)", re.I)
counter = itertools.count(1)


def redact(h):
    if h is None:
        return None
    return [[k, "[redacted]" if k.lower() in SECRET_HEADERS or SECRET_PATTERN.search(k) else v]
            for k, v in h.items(multi=True)]


class Body:
    """A gzip file that the flow's body is teed into, chunk by chunk."""

    def __init__(self, path):
        self.path = path
        self.file = gzip.open(path, "wb")
        self.bytes = 0

    def write(self, data):
        if not data:
            return
        if self.file.closed:  # the client kept sending after the response ended: append a gzip member
            with gzip.open(self.path, "ab") as f:
                f.write(data)
        else:
            self.file.write(data)
            self.file.flush()
        self.bytes += len(data)

    def close(self):
        if not self.file.closed:
            self.file.close()


class CursorWire:
    def __init__(self):
        self.open = {}  # flow id -> flow, until it is finalized

    def load(self, loader):
        loader.add_option("wire_dir", str, os.path.expanduser("~/.cursor-wire"), "where captures go")

    # -- folders and files ------------------------------------------------------------

    def _dir(self, flow):
        if "wire_dir" not in flow.metadata:
            now = time.localtime(flow.request.timestamp_start)
            name = re.sub(r"[^A-Za-z0-9._-]+", "_", flow.request.path.split("?")[0].strip("/"))[:80] or "root"
            day = os.path.join(ctx.options.wire_dir, time.strftime("%Y-%m-%d", now))
            while True:
                d = os.path.join(day, f"{time.strftime('%H%M%S', now)}-{next(counter):05d}-{name}")
                try:
                    os.makedirs(d)
                    break
                except FileExistsError:  # an earlier run used this name
                    continue
            flow.metadata["wire_dir"] = d
            flow.metadata["wire_day"] = day
        return flow.metadata["wire_dir"]

    def _body(self, flow, side):
        key = f"wire_{side}"
        if key not in flow.metadata:
            flow.metadata[key] = Body(os.path.join(self._dir(flow), f"{side}.bin.gz"))
        return flow.metadata[key]

    def _tee(self, flow, side):
        body = self._body(flow, side)

        def chunk(data):
            body.write(data)
            return data

        return chunk

    def _close(self, flow, side, message):
        if flow.metadata.get("wire_final"):
            return
        body = self._body(flow, side)
        # Bodies mitmproxy did not stream (empty ones, or ones it buffered) are still recorded.
        if body.bytes == 0 and message is not None and message.raw_content:
            body.write(message.raw_content)
        body.close()

    def _meta(self, flow):
        r = flow.request
        body = lambda side: flow.metadata[f"wire_{side}"].bytes if f"wire_{side}" in flow.metadata else 0
        meta = {
            "method": r.method,
            "url": r.pretty_url,
            "http_version": r.http_version,
            "client": list(flow.client_conn.peername or []),
            "server": list(flow.server_conn.peername or []) if flow.server_conn else [],
            "request_headers": redact(r.headers),
            "request_trailers": redact(r.trailers),
            "request_bytes": body("request"),
            "started": r.timestamp_start,
            "request_ended": r.timestamp_end,
        }
        if flow.response:
            s = flow.response
            meta.update(
                status=s.status_code,
                reason=s.reason,
                response_headers=redact(s.headers),
                response_trailers=redact(s.trailers),
                response_bytes=body("response"),
                response_started=s.timestamp_start,
                response_ended=s.timestamp_end,
            )
        if flow.websocket:
            ws = flow.websocket
            meta["websocket"] = {"messages": flow.metadata.get("wire_ws_messages", 0), "closed_by_client": ws.closed_by_client,
                                 "close_code": ws.close_code, "close_reason": ws.close_reason, "ended": ws.timestamp_end}
        if flow.error:
            meta["error"] = flow.error.msg
        meta["complete"] = flow.metadata.get("wire_final", False)
        path = os.path.join(self._dir(flow), "meta.json")
        with open(path + ".tmp", "w") as f:
            json.dump(meta, f, indent=2)
        os.replace(path + ".tmp", path)
        return meta

    def _finalize(self, flow):
        """Close everything, write the final meta.json and the flows.jsonl line, once."""
        if flow.metadata.get("wire_final") or "wire_dir" not in flow.metadata:
            return
        flow.metadata["wire_final"] = True
        self.open.pop(flow.id, None)
        for key in ("wire_request", "wire_response", "wire_websocket"):
            if key in flow.metadata:
                flow.metadata[key].close()
        meta = self._meta(flow)
        line = {
            "dir": os.path.basename(flow.metadata["wire_dir"]),
            "started": meta["started"],
            "method": meta["method"],
            "url": meta["url"],
            "status": meta.get("status"),
            "request_bytes": meta["request_bytes"],
            "response_bytes": meta.get("response_bytes", 0),
        }
        if flow.websocket:
            line["websocket_messages"] = meta["websocket"]["messages"]
        if flow.error:
            line["error"] = meta["error"]
        with open(os.path.join(flow.metadata["wire_day"], "flows.jsonl"), "a") as f:
            f.write(json.dumps(line) + "\n")

    def _maybe_finalize(self, flow):
        if flow.websocket and not flow.websocket.timestamp_end:
            return  # the upgraded connection keeps going; websocket_end finalizes it
        # A finished response ends the flow even if the request is still open: when the client then
        # resets its half of an HTTP/2 stream, mitmproxy calls no hook at all.
        if flow.metadata.get("wire_response_done"):
            self._finalize(flow)

    # -- HTTP -------------------------------------------------------------------------

    def requestheaders(self, flow: http.HTTPFlow):
        self.open[flow.id] = flow
        flow.request.stream = self._tee(flow, "request")
        self._meta(flow)

    def request(self, flow: http.HTTPFlow):
        self._close(flow, "request", flow.request)
        if flow.metadata.get("wire_final"):
            self._meta(flow)  # the request outlived the response: record its final size and end

    def responseheaders(self, flow: http.HTTPFlow):
        flow.response.stream = self._tee(flow, "response")
        self._meta(flow)

    def response(self, flow: http.HTTPFlow):
        self._close(flow, "response", flow.response)
        flow.metadata["wire_response_done"] = True
        self._meta(flow)
        self._maybe_finalize(flow)

    def error(self, flow: http.HTTPFlow):
        self._finalize(flow)

    # -- WebSocket ----------------------------------------------------------------------

    def websocket_message(self, flow: http.HTTPFlow):
        m = flow.websocket.messages[-1]
        if "wire_websocket" not in flow.metadata:
            flow.metadata["wire_websocket"] = gzip.open(os.path.join(self._dir(flow), "websocket.jsonl.gz"), "wt")
        out = flow.metadata["wire_websocket"]
        out.write(json.dumps({
            "time": m.timestamp,
            "from_client": m.from_client,
            "type": m.type.name.lower(),
            "base64": base64.b64encode(m.content).decode(),
        }) + "\n")
        out.flush()
        flow.metadata["wire_ws_messages"] = flow.metadata.get("wire_ws_messages", 0) + 1

    def websocket_end(self, flow: http.HTTPFlow):
        self._finalize(flow)

    # -- connections that go away without an error hook ---------------------------------

    def client_disconnected(self, client):
        for flow in list(self.open.values()):
            if flow.client_conn.id == client.id:
                self._finalize(flow)

    def done(self):
        for flow in list(self.open.values()):
            self._finalize(flow)


addons = [CursorWire()]
