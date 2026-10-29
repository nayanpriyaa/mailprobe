#!/bin/sh
# Refresh the bundled disposable-domain list from the CC0-licensed upstream project.
set -eu
here="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

git clone --quiet --depth 1 https://github.com/disposable-email-domains/disposable-email-domains "$tmp/repo"
grep -E '^[a-z0-9.-]+$' "$tmp/repo/disposable_email_blocklist.conf" | sort -u > "$here/data/disposable-domains.txt"
echo "disposable-domains.txt: $(wc -l < "$here/data/disposable-domains.txt") domains"
