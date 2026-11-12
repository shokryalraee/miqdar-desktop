#!/bin/sh
# One command release (needs the GitHub CLI `gh`, logged in): ./release.sh 1.1.3
# Same as GitHub → Actions → build → Run workflow → version. Builds Windows + macOS and publishes the Release; installed apps update themselves.
[ -n "$1" ] || { echo "usage: ./release.sh 1.2.3"; exit 1; }
gh workflow run build.yml -f version="$1" && echo "started — watch: gh run watch"
