#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'CaMe requires Node.js 24 or newer.' >&2
  exit 1
fi

nodeMajor=$(node -p 'Number(process.versions.node.split(".")[0])')
if [ "$nodeMajor" -lt 24 ]; then
  printf '%s\n' 'CaMe requires Node.js 24 or newer.' >&2
  exit 1
fi

if command -v pnpm >/dev/null 2>&1; then
  packageManager=pnpm
  pnpm --dir "$root" install --frozen-lockfile
  pnpm --dir "$root" build
elif command -v corepack >/dev/null 2>&1; then
  packageManager=corepack
  corepack pnpm --dir "$root" install --frozen-lockfile
  corepack pnpm --dir "$root" build
else
  printf '%s\n' 'CaMe requires pnpm or corepack.' >&2
  exit 1
fi

CAME_PACKAGE_MANAGER=$packageManager exec node "$root/dist/cli/came-install.js" --source-root "$root"
