# macOS unattended service

The production bridge should run as a system LaunchDaemon. Unlike a file in
`~/Library/LaunchAgents`, the daemon starts at boot and does not depend on the
`piai` account having an active desktop login.

From the repository root on the Mac mini:

```sh
./deploy/macos/install-launch-daemon.sh install
```

The installer requests administrator authorization, installs a root-owned
plist in `/Library/LaunchDaemons`, disables the older per-login LaunchAgent,
starts the daemon, and waits for `/healthz` to report success. Secrets stay in
the existing bridge `.env`; they are not copied into the plist.

Useful checks:

```sh
./deploy/macos/install-launch-daemon.sh status
./deploy/macos/install-launch-daemon.sh restart
```
