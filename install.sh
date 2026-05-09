#!/usr/bin/env sh
# install.sh — fetch a prebuilt pihub binary from GitHub Releases and drop
# it at ~/.local/bin/pihub.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Derek-X-Wang/pihub/main/install.sh | sh
#   PIHUB_VERSION=v0.1.0 sh install.sh           # pin to a specific tag
#   PIHUB_INSTALL_DIR=/opt/pihub sh install.sh   # override install location

set -eu

REPO="Derek-X-Wang/pihub"
INSTALL_DIR="${PIHUB_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${PIHUB_VERSION:-latest}"

err() {
  printf "install.sh: %s\n" "$*" >&2
  exit 1
}

detect_target() {
  os=$(uname -s)
  arch=$(uname -m)
  case "$os" in
    Darwin)
      case "$arch" in
        arm64|aarch64) printf "darwin-arm64" ;;
        x86_64) printf "darwin-x64" ;;
        *) err "unsupported macOS arch: $arch" ;;
      esac
      ;;
    Linux)
      case "$arch" in
        x86_64) printf "linux-x64" ;;
        aarch64|arm64) printf "linux-arm64" ;;
        *) err "unsupported Linux arch: $arch" ;;
      esac
      ;;
    *)
      err "unsupported OS: $os"
      ;;
  esac
}

target=$(detect_target)

case "$VERSION" in
  latest) url_base="https://github.com/$REPO/releases/latest/download" ;;
  *)      url_base="https://github.com/$REPO/releases/download/$VERSION" ;;
esac

tarball_url="$url_base/pihub-$target.tar.gz"
checksum_url="$tarball_url.sha256"

if ! command -v curl >/dev/null 2>&1; then
  err "curl is required"
fi

tmp=$(mktemp -d 2>/dev/null || mktemp -d -t pihub)
trap 'rm -rf "$tmp"' EXIT INT TERM

printf "Downloading pihub %s for %s...\n" "$VERSION" "$target"
curl -fsSL --proto '=https' --tlsv1.2 "$tarball_url" -o "$tmp/pihub.tar.gz" \
  || err "failed to download $tarball_url"
curl -fsSL --proto '=https' --tlsv1.2 "$checksum_url" -o "$tmp/pihub.tar.gz.sha256" \
  || err "failed to download $checksum_url"

# Verify SHA-256. Prefer shasum (mac built-in, ubuntu has perl impl) and
# fall back to sha256sum on Linux distros that lack shasum.
expected=$(awk '{print $1}' "$tmp/pihub.tar.gz.sha256")
if command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$tmp/pihub.tar.gz" | awk '{print $1}')
elif command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/pihub.tar.gz" | awk '{print $1}')
else
  err "neither shasum nor sha256sum is available"
fi

if [ "$expected" != "$actual" ]; then
  err "checksum mismatch (expected $expected, got $actual)"
fi

mkdir -p "$INSTALL_DIR"
tar xzf "$tmp/pihub.tar.gz" -C "$tmp"
mv "$tmp/pihub" "$INSTALL_DIR/pihub"
chmod +x "$INSTALL_DIR/pihub"

printf "Installed pihub to %s/pihub\n" "$INSTALL_DIR"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    printf "%s is not on PATH; add it to your shell init:\n" "$INSTALL_DIR"
    printf "  export PATH=\"%s:\$PATH\"\n" "$INSTALL_DIR"
    ;;
esac
printf "Verify with: pihub --version\n"
