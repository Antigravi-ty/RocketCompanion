ensure_fix_sh_persisted() {
  local work_dir="$1"
  local fix_path="${work_dir}/fix.sh"
  mkdir -p "$work_dir"

  local self_path="${BASH_SOURCE[0]:-}"
  if [ -n "$self_path" ] && [ -f "$self_path" ]; then
    local abs_self abs_fix
    abs_self="$(readlink -f "$self_path" 2>/dev/null || echo "$self_path")"
    abs_fix="$(readlink -f "$fix_path" 2>/dev/null || echo "$fix_path")"
    if [ "$abs_self" != "$abs_fix" ]; then
      cp -f "$self_path" "$fix_path" 2>/dev/null || true
      chmod +x "$fix_path" 2>/dev/null || true
    else
      chmod +x "$fix_path" 2>/dev/null || true
    fi
  elif [ ! -f "$fix_path" ]; then
    curl -fsSL "https://envinit.maboco-mark.workers.dev/" -o "$fix_path" 2>/dev/null || true
    chmod +x "$fix_path" 2>/dev/null || true
  fi
}

setup_tmpfs_pnpm_and_wrapper() {
  local persist_prefix="$1"
  local tmp_dir="$2"
  local work_dir="$3"
  local pnpm_store="$4"
  local pnpm_cache="$5"
  local npm_cache="$6"

  local real_pnpm_prefix="${tmp_dir}/pnpm-global"
  local real_pnpm_bin="${real_pnpm_prefix}/bin/pnpm"
  local real_pnpx_bin="${real_pnpm_prefix}/bin/pnpx"

  # Purge any legacy 63MB pnpm installation on OverlayFS (/usr/local/lib/node_modules/pnpm)
  rm -rf "${persist_prefix}/lib/node_modules/pnpm" /root/.npm /root/.cache/pnpm /root/.local/share/pnpm 2>/dev/null || true

  # Install pnpm binary into tmpfs (/tmp/pnpm-global)
  if [ ! -x "$real_pnpm_bin" ]; then
    mkdir -p "$real_pnpm_prefix" "$npm_cache" 2>/dev/null || true
    NPM_CONFIG_CACHE="$npm_cache" npm install -g pnpm --prefix "$real_pnpm_prefix" --force --no-audit --no-fund --silent >/dev/null 2>&1 || \
      NPM_CONFIG_CACHE="$npm_cache" npm install -g pnpm --prefix "$real_pnpm_prefix" --force
    rm -rf /root/.npm "$npm_cache" 2>/dev/null || true
  fi

  mkdir -p "${persist_prefix}/etc/pnpm" "${persist_prefix}/bin" 2>/dev/null || true
  cat << EOF > "${persist_prefix}/etc/pnpm/config.yaml"
cacheDir: ${pnpm_cache}
storeDir: ${pnpm_store}
verifyDepsBeforeRun: false
confirmModulesPurge: false
EOF

  # Remove any symlinks in /usr/local/bin/{pnpm,pnpx,pn,pnx} so we write real 2KB scripts
  for bin_name in pnpm pnpx pn pnx; do
    rm -f "${persist_prefix}/bin/${bin_name}" 2>/dev/null || true
  done

  cat << EOF > "${persist_prefix}/bin/pnpm"
#!/usr/bin/env bash
export XDG_CONFIG_HOME="${persist_prefix}/etc"
export XDG_CACHE_HOME="${tmp_dir}"
export XDG_DATA_HOME="${tmp_dir}"
export XDG_STATE_HOME="${tmp_dir}"

REAL_PNPM_PREFIX="${real_pnpm_prefix}"
REAL_PNPM="\${REAL_PNPM_PREFIX}/bin/pnpm"

if [ ! -x "\$REAL_PNPM" ]; then
  echo "[pnpm-wrapper] /tmp reset detected. Reinstalling pnpm to tmpfs & healing workspace..." >&2
  mkdir -p "\$REAL_PNPM_PREFIX" "${pnpm_store}" "${pnpm_cache}" "${npm_cache}" 2>/dev/null || true
  NPM_CONFIG_CACHE="${npm_cache}" npm install -g pnpm --prefix "\$REAL_PNPM_PREFIX" --force --no-audit --no-fund --silent >/dev/null 2>&1 || \
    NPM_CONFIG_CACHE="${npm_cache}" npm install -g pnpm --prefix "\$REAL_PNPM_PREFIX" --force >&2
  rm -rf /root/.npm "${npm_cache}" 2>/dev/null || true
  if [ -x "${work_dir}/fix.sh" ] && [ -z "\${FIX_SH_RUNNING:-}" ]; then
    FIX_SH_RUNNING=1 "${work_dir}/fix.sh" --no-check >&2 || true
  fi
fi

for link_dir in dist .vite src-tauri/target public; do
  if [ -L "\$link_dir" ] && [ ! -e "\$link_dir" ]; then
    mkdir -p "\$(readlink "\$link_dir")" 2>/dev/null || true
  fi
done

if [ -L "node_modules" ] && [ -f "package.json" ]; then
  NM_TARGET="\$(readlink "node_modules")"
  if [ ! -e "node_modules" ] || [ ! -f "node_modules/.modules.yaml" ]; then
    mkdir -p "\$NM_TARGET" "${pnpm_store}" 2>/dev/null || true
    case "\${1:-}" in
      install|i|add|remove|config|--version|-v|--help|-h) ;;
      *) "\$REAL_PNPM" install --store-dir="${pnpm_store}" --config.confirm-modules-purge=false >&2 ;;
    esac
  fi
fi

exec "\$REAL_PNPM" "\$@"
EOF
  chmod +x "${persist_prefix}/bin/pnpm"

  cat << EOF > "${persist_prefix}/bin/pnpx"
#!/usr/bin/env bash
if [ ! -x "${real_pnpx_bin}" ]; then
  "${persist_prefix}/bin/pnpm" --version >/dev/null 2>&1 || true
fi
exec "${real_pnpx_bin}" "\$@"
EOF
  chmod +x "${persist_prefix}/bin/pnpx"

  # Install a lightweight git wrapper at /usr/local/bin/git so `git reset --hard`
  # (which natively does not trigger post-checkout in Git) automatically invokes
  # .git/hooks/post-checkout to restore tmpfs submodule symlinks (e.g. public -> /tmp/...)
  if [ -x "/usr/bin/git" ]; then
    cat << 'EOF' > "${persist_prefix}/bin/git"
#!/usr/bin/env bash
/usr/bin/git "$@"
GIT_EXIT=$?
if [ $GIT_EXIT -eq 0 ]; then
  case "$*" in
    *reset*--hard*|*checkout*|*switch*|*merge*|*pull*|*rebase*)
      TOP_DIR="$(/usr/bin/git rev-parse --show-toplevel 2>/dev/null || true)"
      if [ -n "$TOP_DIR" ] && [ -x "${TOP_DIR}/.git/hooks/post-checkout" ]; then
        "${TOP_DIR}/.git/hooks/post-checkout" HEAD HEAD 1 >/dev/null 2>&1 || true
      fi
      ;;
  esac
fi
exit $GIT_EXIT
EOF
    chmod +x "${persist_prefix}/bin/git"
  fi
}
