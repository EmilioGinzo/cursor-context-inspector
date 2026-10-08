#!/usr/bin/env python3
"""Make Cursor's agent "Context Usage" popover open Agent Context Inspector.

Cursor's popover component already supports a "View Report" header button
(onSeeMore) and clickable category rows (onCategorySelect). In the chat view
the first is gated behind an internal feature flag and the second is never
wired. This patch wires both to:

    cursorContextInspector.open { composerId, categoryId }

so clicking a row opens the inspector on the same chat with that category
expanded, and "View Report" opens it on the chat.

Usage (the workbench file is root-owned, so apply/revert need sudo):
    sudo python3 cursor-popover-patch.py apply   [--file PATH]
    sudo python3 cursor-popover-patch.py revert  [--file PATH]
    python3 cursor-popover-patch.py status       [--file PATH]

Cursor updates replace the file and drop the patch; re-run `apply` (or install
the pacman hook from the README). Reload Cursor windows after apply/revert.
"""

import argparse
import json
import os
import re
import sys

DEFAULT_FILE = "/usr/share/cursor/resources/app/out/vs/workbench/workbench.desktop.main.js"
BEGIN = "/*cursor-context-inspector:begin*/"
END = "/*cursor-context-inspector:end*/"
COMMAND = "cursorContextInspector.open"

FLAG_RE = re.compile(r'(\w+)=NC\("context_usage_canvas"\)')
SEE_MORE_RE = re.compile(r"get onSeeMore\(\)\{return \w+\(\)&&\w+\(\)&&\w+\(\)&&\w+\(\)\?(\w+):void 0\}")


def sidecar(path):
    return path + ".context-inspector.json"


def find_target(src):
    """Locate the popover props in the chat view component; return (span, replacement)."""
    flags = list(FLAG_RE.finditer(src))
    if len(flags) != 1:
        raise SystemExit(f"expected 1 context_usage_canvas gate, found {len(flags)}; Cursor changed, not patching")
    flag = flags[0]
    window = src[flag.start() - 4000 : flag.start() + 4000]

    # const A=Re(()=>b().composerId)  -> accessor for the chat id
    ids = re.findall(r"const (\w+)=\w+\(\(\)=>\w+\(\)\.composerId\)", window)
    # const K=()=>{const{agentClientService:..}=t.instantiationService...  -> services object
    svc = re.search(r"const (\w+)=\(\)=>\{const\{agentClientService:\w+,agentTranscriptService:\w+\}=(\w+)\.instantiationService", window)
    if len(ids) != 1 or not svc:
        raise SystemExit("could not identify the chat id accessor / services object; Cursor changed, not patching")
    composer_id, report_fn, services = ids[0], svc.group(1), svc.group(2)

    sees = [m for m in SEE_MORE_RE.finditer(src, flag.start(), flag.start() + 200000) if m.group(1) == report_fn]
    if len(sees) != 1:
        raise SystemExit(f"expected 1 onSeeMore binding, found {len(sees)}; Cursor changed, not patching")
    see = sees[0]

    run = f'{services}.commandService.executeCommand("{COMMAND}",'
    replacement = (
        BEGIN
        + f"get onSeeMore(){{return()=>{run}{{composerId:{composer_id}()}})}},"
        + f"onCategorySelect:ciCategory=>{run}{{composerId:{composer_id}(),categoryId:ciCategory}})"
        + END
    )
    return (see.start(), see.end()), replacement


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def write(path, text):
    tmp = path + ".context-inspector.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def status(path):
    src = read(path)
    if BEGIN in src:
        return "patched"
    try:
        find_target(src)
        return "unpatched (patch applies cleanly)"
    except SystemExit as e:
        return f"unpatched (cannot patch: {e})"


def apply(path):
    src = read(path)
    if BEGIN in src:
        print("already patched")
        return
    (start, end), replacement = find_target(src)
    original = src[start:end]
    st = os.stat(path)
    write(path, src[:start] + replacement + src[end:])
    os.chmod(path, st.st_mode)
    with open(sidecar(path), "w", encoding="utf-8") as f:
        json.dump({"original": original, "replacement": replacement}, f)
    print(f"patched {path}\n  - {original}\n  + {replacement}\nReload Cursor windows to apply.")


def revert(path):
    src = read(path)
    if BEGIN not in src:
        print("not patched")
        return
    with open(sidecar(path), encoding="utf-8") as f:
        saved = json.load(f)
    if src.count(saved["replacement"]) != 1:
        raise SystemExit("patched region does not match the saved record; reinstall cursor-bin to restore")
    st = os.stat(path)
    write(path, src.replace(saved["replacement"], saved["original"]))
    os.chmod(path, st.st_mode)
    os.remove(sidecar(path))
    print(f"reverted {path}. Reload Cursor windows to apply.")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("action", choices=["apply", "revert", "status"])
    p.add_argument("--file", default=DEFAULT_FILE)
    a = p.parse_args()
    if a.action == "status":
        print(status(a.file))
    elif a.action == "apply":
        apply(a.file)
    else:
        revert(a.file)


if __name__ == "__main__":
    sys.exit(main())
