setup_tmpfs_git_auth() {
  local tmp_dir="$1"
  local auth_input="${2:-}"
  local auth_worker_url="${3:-https://getgithubapptoken.maboco-mark.workers.dev/}"
  local token_file="${tmp_dir}/.git-token"
  local askpass_file="${tmp_dir}/git-askpass.sh"
  local req_file="${tmp_dir}/.git-auth-req"

  mkdir -p "$tmp_dir" 2>/dev/null || true

  # Migrate any accidental OverlayFS /root/.git-credentials into tmpfs and purge from /root
  if [ -f "/root/.git-credentials" ]; then
    local legacy_tok=""
    legacy_tok="$(grep -oE '(ghs_[A-Za-z0-9_.-]+|ghp_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)' /root/.git-credentials 2>/dev/null | head -n 1 || true)"
    if [ -n "$legacy_tok" ] && [ -z "$auth_input" ]; then
      auth_input="$legacy_tok"
    fi
    rm -f /root/.git-credentials 2>/dev/null || true
    /usr/bin/git config --global --unset-all credential.helper 2>/dev/null || true
  fi

  if [ -z "$auth_input" ] && [ -f "${tmp_dir}/.git-credentials" ]; then
    auth_input="$(grep -oE '(ghs_[A-Za-z0-9_.-]+|ghp_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)' "${tmp_dir}/.git-credentials" 2>/dev/null | head -n 1 || true)"
  fi

  local resolved_token=""
  if [ -n "$auth_input" ]; then
    local direct_tok=""
    direct_tok="$(printf '%s' "$auth_input" | grep -oE '(ghs_[A-Za-z0-9_.-]+|ghp_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)' | head -n 1 || true)"
    if [ -n "$direct_tok" ]; then
      resolved_token="$direct_tok"
    else
      local extracted_url=""
      extracted_url="$(printf '%s' "$auth_input" | grep -oE 'https?://[^"'\''[:space:]]+' | head -n 1 || true)"
      [ -n "$extracted_url" ] && auth_worker_url="$extracted_url"

      local req_id=""
      req_id="$(printf '%s' "$auth_input" | sed -nE 's/.*[xX]-[aA][gG][yY]-[rR][eE][qQ][uU][eE][sS][tT]-[iI][dD]:[[:space:]]*([^"'\''[:space:]]+).*/\1/p' | head -n 1)"
      if [ -z "$req_id" ]; then
        req_id="$(printf '%s' "$auth_input" | grep -oE '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}' | head -n 1 || true)"
      fi
      if [ -z "$req_id" ]; then
        req_id="$(printf '%s' "$auth_input" | tr -d '"' | tr -d "'" | tr -d '[:space:]')"
      fi

      if [ -n "$req_id" ]; then
        printf '%s\n%s\n' "$req_id" "$auth_worker_url" > "$req_file"
        chmod 600 "$req_file" 2>/dev/null || true
        local fetched=""
        fetched="$(curl -fsSL -H "x-agy-request-id: ${req_id}" "$auth_worker_url" 2>/dev/null | tr -d '\r\n[:space:]' || true)"
        if [[ "$fetched" == ghs_* || "$fetched" == ghp_* || "$fetched" == github_pat_* ]]; then
          resolved_token="$fetched"
        fi
      fi
    fi
  fi

  if [ -n "$resolved_token" ]; then
    printf '%s' "$resolved_token" > "$token_file"
    chmod 600 "$token_file" 2>/dev/null || true
  fi

  cat << EOF > "$askpass_file"
#!/usr/bin/env bash
case "\${1:-}" in
  *Username*|*username*) echo "x-access-token" ;;
  *)
    if [ -s "${token_file}" ]; then
      cat "${token_file}" 2>/dev/null || true
    elif [ -s "${req_file}" ]; then
      REQ_ID="\$(sed -n '1p' "${req_file}" 2>/dev/null || true)"
      WORKER_URL="\$(sed -n '2p' "${req_file}" 2>/dev/null || true)"
      if [ -n "\$REQ_ID" ] && [ -n "\$WORKER_URL" ]; then
        TOK="\$(curl -fsSL -H "x-agy-request-id: \${REQ_ID}" "\$WORKER_URL" 2>/dev/null | tr -d '\r\n[:space:]' || true)"
        if [[ "\$TOK" == ghs_* || "\$TOK" == ghp_* || "\$TOK" == github_pat_* ]]; then
          printf '%s' "\$TOK" > "${token_file}"
          chmod 600 "${token_file}" 2>/dev/null || true
          printf '%s' "\$TOK"
        fi
      fi
    fi
    ;;
esac
EOF
  chmod 700 "$askpass_file" 2>/dev/null || true

  if [ -s "$token_file" ]; then
    export GIT_ASKPASS="$askpass_file"
    export GIT_TERMINAL_PROMPT=0
    export GITHUB_TOKEN="$(cat "$token_file" 2>/dev/null || true)"
  fi
}

setup_tmpfs_link_healer() {
  local persist_prefix="$1"
  local tmp_dir="$2"
  local work_dir="$3"
  mkdir -p "${persist_prefix}/bin" 2>/dev/null || true

  cat << EOF > "${persist_prefix}/bin/heal-tmpfs-links"
#!/usr/bin/env bash
# Fast idempotent /tmp target directory healer (0 network calls).
# Prevents dangling symlinks across /work repositories after container /tmp resets.
mkdir -p "${tmp_dir}/pnpm-store" "${tmp_dir}/pnpm-cache" "${tmp_dir}/npm-cache" 2>/dev/null || true

STATE_REPO_DIR=""
if [ -f "${work_dir}/.fix_state" ]; then
  . "${work_dir}/.fix_state" 2>/dev/null || true
  if [ -n "\${LAST_REPO_NAME:-}" ] && [ -d "${work_dir}/\${LAST_REPO_NAME}" ]; then
    STATE_REPO_DIR="${work_dir}/\${LAST_REPO_NAME}"
  fi
fi

TOP_DIR="\$(/usr/bin/git rev-parse --show-toplevel 2>/dev/null || pwd)"

for base_dir in "\$PWD" "\$TOP_DIR" "\$STATE_REPO_DIR"; do
  [ -n "\$base_dir" ] && [ -d "\$base_dir" ] || continue
  for rel_link in node_modules dist .vite crates/target src-tauri/target public; do
    link_path="\${base_dir}/\${rel_link}"
    if [ -L "\$link_path" ] && [ ! -e "\$link_path" ]; then
      mkdir -p "\$(readlink "\$link_path")" 2>/dev/null || true
    fi
  done
  wasm_link="\${base_dir}/src/physics/core.wasm"
  if [ -L "\$wasm_link" ]; then
    mkdir -p "\$(dirname "\$(readlink "\$wasm_link")")" 2>/dev/null || true
  fi
done
EOF
  chmod +x "${persist_prefix}/bin/heal-tmpfs-links"
}

setup_git_wrapper() {
  local persist_prefix="$1"
  local tmp_dir="${2:-/tmp}"
  mkdir -p "${persist_prefix}/bin" 2>/dev/null || true

  if [ -x "/usr/bin/git" ]; then
    cat << EOF > "${persist_prefix}/bin/git"
#!/usr/bin/env bash
if [ -x "${persist_prefix}/bin/heal-tmpfs-links" ]; then
  "${persist_prefix}/bin/heal-tmpfs-links" 2>/dev/null || true
fi

if [ -x "${tmp_dir}/git-askpass.sh" ] && { [ -s "${tmp_dir}/.git-token" ] || [ -s "${tmp_dir}/.git-auth-req" ]; }; then
  export GIT_ASKPASS="${tmp_dir}/git-askpass.sh"
  export GIT_TERMINAL_PROMPT=0
fi

case "\$*" in
  *checkout*|*switch*|*reset*|*merge*|*pull*|*rebase*)
    TOP_DIR="\$(/usr/bin/git rev-parse --show-toplevel 2>/dev/null || true)"
    if [ -n "\$TOP_DIR" ] && [ -L "\${TOP_DIR}/src/physics/core.wasm" ]; then
      if ! /usr/bin/git -C "\$TOP_DIR" ls-files --error-unmatch "src/physics/core.wasm" >/dev/null 2>&1; then
        rm -f "\${TOP_DIR}/src/physics/core.wasm" 2>/dev/null || true
      fi
    fi
    ;;
esac

/usr/bin/git "\$@"
GIT_EXIT=\$?
if [ \$GIT_EXIT -eq 0 ]; then
  case "\$*" in
    *reset*--hard*|*checkout*|*switch*|*merge*|*pull*|*rebase*)
      TOP_DIR="\$(/usr/bin/git rev-parse --show-toplevel 2>/dev/null || true)"
      if [ -n "\$TOP_DIR" ] && [ -x "\${TOP_DIR}/.git/hooks/post-checkout" ]; then
        "\${TOP_DIR}/.git/hooks/post-checkout" HEAD HEAD 1 >/dev/null 2>&1 || true
      fi
      if [ -x "${persist_prefix}/bin/heal-tmpfs-links" ]; then
        "${persist_prefix}/bin/heal-tmpfs-links" 2>/dev/null || true
      fi
      ;;
  esac
fi
exit \$GIT_EXIT
EOF
    chmod +x "${persist_prefix}/bin/git"
  fi
}
