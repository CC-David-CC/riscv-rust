# RISC-V Machine Lab

Boot xv6 to start the browser-local RISC-V worker and type directly in the
serial console. The command editor saves a `.riscvlab.json` project with the
xv6 preset and a shell script. Open a project, boot xv6 and choose Run script
to replay it. Each boot starts with the same xv6 disk image.

The WebOS package uses Rust 1.99.1 with the `wasm32-unknown-unknown` target
and the wasm-bindgen CLI 0.2.129. Run this from a clean checkout.

```sh
rustup target add --toolchain 1.99.1 wasm32-unknown-unknown
cp webos/Cargo.lock Cargo.lock
cargo +1.99.1 build --locked --release --target wasm32-unknown-unknown -p riscv_emu_rust_wasm
WASM_INPUTS=$(mktemp -d)
wasm-bindgen --target web --no-typescript --out-dir "$WASM_INPUTS" \
  target/wasm32-unknown-unknown/release/riscv_emu_rust_wasm.wasm
python3 webos/prepare-webos.py --inputs "$WASM_INPUTS" --output "$WASM_INPUTS/stage/riscv-rust"
```

Set the WebOS app builder's `source` to the prepared `stage` directory and
`apps` to `["riscv-rust"]`. The builder supplies its locked xterm.js dependency.
The source and license references are in [NOTICES.txt](legal/NOTICES.txt).
