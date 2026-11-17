#!/bin/sh
set -e

echo "[builder] DeployService Container Sandbox Entrypoint started."

# 1. Strict URL validation
if [ -z "$REPO_URL" ]; then
  echo "[builder] ERROR: REPO_URL environment variable is missing." >&2
  exit 1
fi

# Reject leading '-' (prevents git command-line option injection, e.g. --upload-pack)
case "$REPO_URL" in
  -*)
    echo "[builder] ERROR: REPO_URL must not start with '-'." >&2
    exit 1
    ;;
esac

# Validate strict HTTPS github.com pattern
# Allows https://github.com/<owner>/<repo>[.git]
VALID_URL=$(echo "$REPO_URL" | grep -E '^https://github\.com/[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+(\.git)?/?$' || true)
if [ -z "$VALID_URL" ]; then
  echo "[builder] ERROR: REPO_URL '$REPO_URL' is invalid or not an allowed GitHub repository." >&2
  exit 1
fi

# 2. Setup writable environment and directories inside /build volume and /tmp
export HOME=/build/.home
export npm_config_cache=/build/.cache/npm
export YARN_CACHE_FOLDER=/build/.cache/yarn
export PNPM_HOME=/build/.cache/pnpm
export PATH="$PNPM_HOME:$PATH"
export CI=true

mkdir -p /build/.home /build/.cache/npm /build/.cache/yarn /build/.cache/pnpm /build/repo /tmp

# 3. Clone repository using -- to terminate option parsing
echo "[builder] Cloning repository: $REPO_URL"
git clone --depth 1 -- "$REPO_URL" /build/repo
cd /build/repo

COMMIT_SHA=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
echo "[builder] Cloned commit: $COMMIT_SHA"

# 4. Detect Framework
FRAMEWORK=""
OUTPUT_DIR=""

if [ -f "vite.config.ts" ] || [ -f "vite.config.js" ] || [ -f "vite.config.mjs" ]; then
  FRAMEWORK="vite"
  OUTPUT_DIR="dist"
elif [ -f "package.json" ] && grep -q '"react-scripts"' package.json; then
  FRAMEWORK="cra"
  OUTPUT_DIR="build"
elif [ -f "index.html" ]; then
  FRAMEWORK="static"
  OUTPUT_DIR="."
else
  echo "[builder] ERROR: Could not detect supported framework. Expected vite.config.*, react-scripts, or root index.html." >&2
  exit 1
fi

echo "[builder] Detected framework: $FRAMEWORK (output: $OUTPUT_DIR)"

# 5. Detect Package Manager and Install/Build
if [ "$FRAMEWORK" != "static" ]; then
  INSTALL_CMD="npm install"
  BUILD_CMD="npm run build"

  if [ -f "pnpm-lock.yaml" ]; then
    echo "[builder] Enabling pnpm via corepack..."
    corepack enable pnpm
    INSTALL_CMD="pnpm install --frozen-lockfile"
    BUILD_CMD="pnpm run build"
  elif [ -f "yarn.lock" ]; then
    echo "[builder] Enabling yarn via corepack..."
    corepack enable yarn
    INSTALL_CMD="yarn install --frozen-lockfile"
    BUILD_CMD="yarn build"
  elif [ -f "package-lock.json" ]; then
    INSTALL_CMD="npm ci"
    BUILD_CMD="npm run build"
  fi

  echo "[builder] Running install: $INSTALL_CMD"
  $INSTALL_CMD

  echo "[builder] Running build: $BUILD_CMD"
  $BUILD_CMD

  if [ ! -d "$OUTPUT_DIR" ]; then
    echo "[builder] ERROR: Expected build output directory '$OUTPUT_DIR' does not exist." >&2
    exit 1
  fi
fi

# 6. Stage output directory to /build/output for archive extraction
mkdir -p /build/output
if [ "$OUTPUT_DIR" = "." ]; then
  # Plain static site: copy html/js/css/assets, exclude git and cache
  find . -maxdepth 1 ! -name '.' ! -name '..' ! -name '.git' ! -name 'node_modules' -exec cp -r {} /build/output/ \;
else
  cp -r "$OUTPUT_DIR"/* /build/output/
fi

# Write metadata
cat <<EOF > /build/.metadata.json
{
  "commitSha": "$COMMIT_SHA",
  "framework": "$FRAMEWORK",
  "outputDir": "$OUTPUT_DIR"
}
EOF

echo "[builder] Build completed successfully. Staged artifacts in /build/output."
exit 0
