#!/usr/bin/env python3
"""Prepare the RISC-V emulation worker and xv6 disk for the WebOS app builder."""

import argparse
import hashlib
import json
from pathlib import Path
import shutil

APP = Path(__file__).resolve().parent.parent
WEB = APP / "webos"


def pinned(source, target, expected):
    if hashlib.sha256(source.read_bytes()).hexdigest() != expected:
        raise ValueError(f"Changed input {source.name}")
    shutil.copyfile(source, target)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inputs", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = args.output
    root.mkdir(parents=True, exist_ok=False)
    native = root / "native"
    native.mkdir()

    inputs = {
        "riscv_emu_rust_wasm.js": "820a43dc46851fe7f86405f7f1158e2a60bb47716876c7da4d086cb1b690ee32",
        "riscv_emu_rust_wasm_bg.wasm": "772e322cd9e3cd95b0e4889a3691c416b8e7640b61e6eea3205f085a18f49744",
    }
    for name, digest in inputs.items():
        pinned(args.inputs / name, native / name, digest)
    fixtures = APP / "resources" / "xv6"
    pinned(fixtures / "kernel", native / "kernel.data",
           "cecad2220d73fc8c6d106d85cf6eccbf82874a167307aac77634e661124ff19b")
    pinned(fixtures / "fs.img", native / "fs.data",
           "440d54ea7d49c7ecb3220e9ffa871e73158131b1426b181b12a1c2ec1e785252")
    shutil.copyfile(WEB / "worker.mjs", native / "worker.mjs")

    shutil.copyfile(WEB / "mount.mjs", root / "index.mjs")
    for name in ("project.mjs", "workspace.css"):
        shutil.copyfile(WEB / name, root / name)
    legal = root / "legal"
    shutil.copytree(WEB / "legal", legal)
    shutil.copyfile(APP / "LICENSE", legal / "riscv-rust-MIT.txt")
    assets = sorted(path.relative_to(root).as_posix() for directory in (native, legal)
                    for path in directory.rglob("*") if path.is_file())
    (root / "app.json").write_text(json.dumps({"assets": assets}, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
