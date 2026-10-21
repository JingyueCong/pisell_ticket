#!/bin/zsh
set -euo pipefail

readonly LABEL="com.pisell.lark-ticket-collector"
readonly PLIST_PATH="/Library/LaunchDaemons/${LABEL}.plist"
readonly SCRIPT_DIR="${0:A:h}"
readonly REPOSITORY_ROOT="${SCRIPT_DIR:h:h}"
readonly BRIDGE_DIR="${REPOSITORY_ROOT}/plugins/lark-ticket-collector/bridge"
readonly TEMPLATE_PATH="${SCRIPT_DIR}/${LABEL}.daemon.plist.in"

if [[ ${EUID} -eq 0 && -z "${SUDO_USER:-}" ]]; then
  print -u2 "Run this installer as the service account, not as root. It requests sudo only when needed."
  exit 2
fi

readonly TARGET_USER="${SUDO_USER:-$(id -un)}"
readonly TARGET_UID="$(id -u "${TARGET_USER}")"
readonly TARGET_GROUP="$(id -gn "${TARGET_USER}")"
readonly TARGET_HOME="$(dscl . -read "/Users/${TARGET_USER}" NFSHomeDirectory | awk '{print $2}')"
readonly LEGACY_PLIST="${TARGET_HOME}/Library/LaunchAgents/${LABEL}.plist"
readonly LEGACY_DISABLED="${LEGACY_PLIST}.disabled-by-launch-daemon"

find_node() {
  local candidate
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [[ -x "${candidate}" ]]; then
      print -r -- "${candidate}"
      return 0
    fi
  done
  return 1
}

health_check() {
  local attempt
  for attempt in {1..30}; do
    if /usr/bin/curl -fsS --max-time 3 http://127.0.0.1:8787/healthz >/dev/null; then
      return 0
    fi
    /bin/sleep 1
  done
  return 1
}

status() {
  sudo launchctl print "system/${LABEL}" 2>/dev/null | \
    /usr/bin/grep -E "state =|pid =|last exit code" | /usr/bin/head -8 || true
  /usr/bin/curl -sS --max-time 5 http://127.0.0.1:8787/healthz || true
  print
}

install_daemon() {
  local node_bin rendered
  node_bin="$(find_node)" || {
    print -u2 "Node.js was not found in the supported Homebrew/system paths."
    exit 3
  }
  [[ -f "${BRIDGE_DIR}/.env" ]] || {
    print -u2 "Missing ${BRIDGE_DIR}/.env"
    exit 4
  }
  [[ -f "${BRIDGE_DIR}/dist/src/main.js" ]] || {
    print -u2 "Missing built service at ${BRIDGE_DIR}/dist/src/main.js"
    exit 5
  }

  rendered="$(/usr/bin/mktemp "/private/tmp/${LABEL}.XXXXXX")"
  trap "/bin/rm -f -- '${rendered}'" EXIT
  /usr/bin/sed \
    -e "s|__TARGET_USER__|${TARGET_USER}|g" \
    -e "s|__TARGET_GROUP__|${TARGET_GROUP}|g" \
    -e "s|__TARGET_HOME__|${TARGET_HOME}|g" \
    -e "s|__NODE_BIN__|${node_bin}|g" \
    -e "s|__BRIDGE_DIR__|${BRIDGE_DIR}|g" \
    "${TEMPLATE_PATH}" > "${rendered}"
  /usr/bin/plutil -lint "${rendered}"

  # Request authorization before changing or stopping the working user service.
  sudo -v
  sudo /usr/bin/install -o root -g wheel -m 0644 "${rendered}" "${PLIST_PATH}"
  sudo launchctl bootout "system/${LABEL}" 2>/dev/null || true
  sudo launchctl bootstrap system "${PLIST_PATH}"

  # A system and user service with the same program must not compete for port 8787.
  launchctl bootout "gui/${TARGET_UID}/${LABEL}" 2>/dev/null || true
  launchctl bootout "user/${TARGET_UID}/${LABEL}" 2>/dev/null || true
  if [[ -f "${LEGACY_PLIST}" ]]; then
    /bin/mv -f "${LEGACY_PLIST}" "${LEGACY_DISABLED}"
  fi
  sudo launchctl kickstart -k "system/${LABEL}"

  if ! health_check; then
    print -u2 "The daemon was installed but did not become healthy."
    sudo launchctl print "system/${LABEL}" 2>/dev/null | /usr/bin/tail -80 || true
    /usr/bin/tail -80 "${TARGET_HOME}/Library/Logs/pisell-ticket-collector.error.log" || true
    exit 6
  fi
  print "Installed ${LABEL} as a boot-time LaunchDaemon."
  status
}

case "${1:-install}" in
  install)
    install_daemon
    ;;
  restart)
    sudo launchctl kickstart -k "system/${LABEL}"
    health_check
    status
    ;;
  status)
    status
    ;;
  *)
    print -u2 "Usage: $0 [install|restart|status]"
    exit 2
    ;;
esac
