setup_tmpfs_pnpm_and_wrapper() {
  local persist_prefix="$1"
  local tmp_dir="$2"
  local work_dir="$3"
  local pnpm_store="$4"
  local pnpm_cache="$5"
  local npm_cache="$6"
  local root_prefix="${7:-/}"

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
export CARGO_HOME="\${CARGO_HOME:-${tmp_dir}/cargo-home}"
export RUSTUP_HOME="\${RUSTUP_HOME:-${tmp_dir}/rustup}"

if [ -x "${tmp_dir}/git-askpass.sh" ] && [ -s "${tmp_dir}/.git-token" ]; then
  export GIT_ASKPASS="${tmp_dir}/git-askpass.sh"
  export GIT_TERMINAL_PROMPT=0
  if [ -z "\${GITHUB_TOKEN:-}" ]; then
    export GITHUB_TOKEN="\$(cat "${tmp_dir}/.git-token" 2>/dev/null || true)"
  fi
fi

REAL_PNPM_PREFIX="${real_pnpm_prefix}"
REAL_PNPM="\${REAL_PNPM_PREFIX}/bin/pnpm"

if [ ! -x "\$REAL_PNPM" ]; then
  echo "[pnpm-wrapper] /tmp reset detected. Reinstalling pnpm to tmpfs & healing workspace..." >&2
  mkdir -p "\$REAL_PNPM_PREFIX" "${pnpm_store}" "${pnpm_cache}" "${npm_cache}" 2>/dev/null || true
  NPM_CONFIG_CACHE="${npm_cache}" npm install -g pnpm --prefix "\$REAL_PNPM_PREFIX" --force --no-audit --no-fund --silent >/dev/null 2>&1 || \
    NPM_CONFIG_CACHE="${npm_cache}" npm install -g pnpm --prefix "\$REAL_PNPM_PREFIX" --force >&2
  rm -rf /root/.npm "${npm_cache}" 2>/dev/null || true
  if [ -x "${work_dir}/fix.sh" ] && [ -z "\${FIX_SH_RUNNING:-}" ]; then
    CURRENT_TOP="\$(/usr/bin/git rev-parse --show-toplevel 2>/dev/null || true)"
    CURRENT_REPO=""
    if [ -n "\$CURRENT_TOP" ]; then
      CURRENT_REPO="\$(/usr/bin/git -C "\$CURRENT_TOP" config --get remote.origin.url 2>/dev/null || true)"
    fi
    if [ -z "\$CURRENT_REPO" ] && [ -f "${work_dir}/.fix_state" ]; then
      . "${work_dir}/.fix_state" 2>/dev/null || true
      CURRENT_REPO="\${LAST_REPO_URL:-}"
    fi
    if [ -n "\$CURRENT_REPO" ]; then
      FIX_SH_RUNNING=1 "${work_dir}/fix.sh" --root "${root_prefix}" --work-dir "${work_dir}" --tmp-dir "${tmp_dir}" --repo "\$CURRENT_REPO" --no-check >&2 || true
    else
      FIX_SH_RUNNING=1 "${work_dir}/fix.sh" --root "${root_prefix}" --work-dir "${work_dir}" --tmp-dir "${tmp_dir}" --no-check >&2 || true
    fi
  fi
fi

if [ -x "${persist_prefix}/bin/heal-tmpfs-links" ]; then
  "${persist_prefix}/bin/heal-tmpfs-links" 2>/dev/null || true
fi

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
}
