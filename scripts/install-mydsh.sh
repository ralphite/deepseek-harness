#!/bin/sh

set -eu

MYDSH_DEFAULT_VERSION='0.1.2-alpha.2-mydsh.1'
repository='https://github.com/ralphite/deepseek-harness'
version=${MYDSH_VERSION:-$MYDSH_DEFAULT_VERSION}

fail() {
  printf 'mydsh installer: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

case "$version" in
  ''|*[!0-9A-Za-z.+-]*) fail "MYDSH_VERSION contains unsupported characters: $version" ;;
esac

[ "$(uname -s)" = 'Linux' ] || fail 'only Linux is supported'
case "$(uname -m)" in
  x86_64|amd64) architecture='x64' ;;
  aarch64|arm64) architecture='arm64' ;;
  *) fail "unsupported Linux architecture: $(uname -m)" ;;
esac

require_command curl
require_command sha256sum
require_command getconf

glibc_report=$(getconf GNU_LIBC_VERSION 2>/dev/null || true)
case "$glibc_report" in
  'glibc '*) glibc_version=${glibc_report#glibc } ;;
  *) fail 'glibc 2.28 or newer is required; musl/Alpine is not supported' ;;
esac
glibc_major=${glibc_version%%.*}
glibc_minor=${glibc_version#*.}
glibc_minor=${glibc_minor%%.*}
case "$glibc_major:$glibc_minor" in
  *[!0-9:]*|:*) fail "could not parse glibc version: $glibc_report" ;;
esac
if [ "$glibc_major" -lt 2 ] || { [ "$glibc_major" -eq 2 ] && [ "$glibc_minor" -lt 28 ]; }; then
  fail "glibc 2.28 or newer is required; found $glibc_version"
fi

if [ -n "${MYDSH_INSTALL_DIR:-}" ]; then
  install_dir=$MYDSH_INSTALL_DIR
else
  [ -n "${HOME:-}" ] || fail 'HOME is unset; set MYDSH_INSTALL_DIR to an absolute directory'
  install_dir=$HOME/.local/bin
fi
case "$install_dir" in
  /*) ;;
  *) fail 'MYDSH_INSTALL_DIR must be an absolute path' ;;
esac

asset="mydsh-linux-$architecture"
release_url="$repository/releases/download/mydsh-v$version"
mkdir -p "$install_dir"
[ -d "$install_dir" ] || fail "install path is not a directory: $install_dir"

candidate=''
checksums=''
cleanup() {
  [ -z "$candidate" ] || rm -f "$candidate"
  [ -z "$checksums" ] || rm -f "$checksums"
}
trap cleanup EXIT HUP INT TERM
candidate=$(mktemp "$install_dir/.mydsh.XXXXXX")
checksums=$(mktemp "$install_dir/.mydsh-checksums.XXXXXX")

curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  --output "$candidate" "$release_url/$asset"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  --output "$checksums" "$release_url/SHA256SUMS"

expected=$(awk -v asset="$asset" '$2 == asset || $2 == "*" asset { print $1 }' "$checksums")
[ -n "$expected" ] || fail "SHA256SUMS has no entry for $asset"
case "$expected" in
  *[!0-9a-fA-F]*) fail "SHA256SUMS contains an invalid digest for $asset" ;;
esac
[ "${#expected}" -eq 64 ] || fail "SHA256SUMS contains an invalid digest for $asset"
actual=$(sha256sum "$candidate" | awk '{ print $1 }')
[ "$actual" = "$expected" ] || fail "checksum verification failed for $asset"

chmod 0755 "$candidate"
reported_version=$("$candidate" --version 2>/dev/null || true)
[ "$reported_version" = "$version" ] || fail "downloaded binary reported version '$reported_version', expected '$version'"

mv -f "$candidate" "$install_dir/mydsh"
candidate=''
printf 'mydsh %s installed at %s/mydsh\n' "$version" "$install_dir"
case ":${PATH:-}:" in
  *":$install_dir:"*) ;;
  *) printf 'Add mydsh to PATH: export PATH="%s:$PATH"\n' "$install_dir" ;;
esac
