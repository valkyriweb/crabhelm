#!/usr/bin/env bash
# Non-interactive, user-local install. Does not log in or start a donor.
set -euo pipefail

version=0.79.1-valky.11
sha256=5a4ebfa3a607038b9bd9b360ad18d0bf9c3cfe193fc60581be0892e2a3c73ba7
asset="crabbox_${version}_linux_amd64.tar.gz"
url="https://github.com/valkyriweb/crabbox/releases/download/v${version}/${asset}"
usage='usage: install-crabbox-linux.sh [--dry-run]'
fail() { printf 'install-crabbox-linux: %s\n' "$*" >&2; exit 1; }
case "$#:${1:-}" in
  0:|1:--dry-run) ;;
  1:--help|1:-h) printf '%s\n' "$usage"; exit 0 ;;
  *) fail "$usage" ;;
esac

platform=$(uname -sm)
[[ $platform == 'Linux x86_64' ]] || fail "no pinned release for $platform (requires Linux x86_64)"
[[ ${HOME:-} == /* ]] || fail 'HOME must be an absolute path'
root="$HOME/.local/share/crabbox/releases"
release="$root/$version"
bin="$HOME/.local/bin/crabbox"
if [[ ${1:-} == --dry-run ]]; then
  printf 'Dry run on %s (no network or writes)\nRelease: v%s\nURL: %s\nSHA-256: %s\nInstall: %s -> %s\n' \
    "$platform" "$version" "$url" "$sha256" "$bin" "$release/crabbox"
  exit 0
fi

# Never take over a different installation. Keep the runtime pack next to the
# controller in the versioned directory; ~/.local/bin only holds a symlink.
if [[ -e $bin || -L $bin ]]; then
  [[ -L $bin && $(readlink -- "$bin") == "$release/crabbox" ]] || fail 'existing ~/.local/bin/crabbox is not managed by this pin; leaving it alone'
fi
ready() {
  [[ ! -L $release && -x $release/crabbox && -f $release/crabbox-runtime/manifest.json &&
     -f $release/archive.sha256 && $(<"$release/archive.sha256") == "$sha256" ]]
}
if ! ready; then
  [[ ! -e $release && ! -L $release ]] || fail 'existing release directory is incomplete or unmanaged; leaving it alone'
  umask 077
  mkdir -p -- "$root"
  stage=$(mktemp -d -- "$root/.stage.XXXXXX")
  trap 'rm -rf -- "$stage"' EXIT
  curl --disable --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --connect-timeout 15 --max-time 300 --retry 2 --output "$stage/$asset" "$url"
  (cd "$stage" && printf '%s  %s\n' "$sha256" "$asset" | sha256sum --check --status) || fail 'release SHA-256 mismatch'
  mkdir -- "$stage/release"
  tar --extract --gzip --no-same-permissions --file "$stage/$asset" --directory "$stage/release"
  [[ -x $stage/release/crabbox && -f $stage/release/crabbox-runtime/manifest.json ]] || fail 'release is missing the controller or runtime pack'
  printf '%s\n' "$sha256" > "$stage/release/archive.sha256"
  mv -nT -- "$stage/release" "$release"
  ready || fail 'unable to publish the verified release'
fi

mkdir -p -- "${bin%/*}"
if [[ ! -L $bin || $(readlink -- "$bin") != "$release/crabbox" ]]; then
  ln -sT -- "$release/crabbox" "$bin"
fi
printf 'Crabbox v%s ready at %s\n' "$version" "$bin"
