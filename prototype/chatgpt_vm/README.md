# VM browser sign-in proof

This single-account prototype connects the FitCoachGPT PWA directly to one VM for ChatGPT sign-in. It does not make model requests. OAuth runs **inside the VM whose browser the iPhone user controls**. Opening the authorization URL in iPhone Safari would direct `127.0.0.1` to the phone and cannot complete this flow.

## Run on a disposable VM

Install a graphical browser and provide an authenticated HTTPS remote browser session that the iPhone can control. Do not enable browser-session recording. Use a fresh, single-user VM and protect its filesystem from other users.

For the current Oracle Ubuntu prototype, the Python dependencies and tests are in
`~/fitcoach-prototype` on the VM. A Firefox desktop is served by TigerVNC on
`127.0.0.1:5901` and noVNC on `127.0.0.1:6080`; neither port should be opened in
the VCN security list. Caddy exposes the desktop only through the gateway's
authenticated HTTPS browser route. Open TCP 80 and 443 in the Oracle VCN security
list and host firewall, then start Caddy so it can obtain a trusted certificate.
Do not expose the raw noVNC endpoint. The VM is an E5 paid shape, so stop it when the prototype is
idle and account for persistent boot-volume charges.
The loopback desktop is managed by the two units in [`systemd/`](systemd/):
`fitcoach-vnc.service` and `fitcoach-novnc.service`. They start after a VM reboot.
Enable the `ubuntu` user session at boot with `sudo loginctl enable-linger ubuntu`;
the Snap Firefox launcher needs its `/run/user/<uid>` runtime and D-Bus socket
when the gateway starts it from a system service.
The sign-in command launches Firefox with a dedicated owner-only profile at
`~/snap/firefox/common/fitcoach-browser-profile`. Keep that profile across VM
restarts. The VNC startup script starts only Openbox; Firefox opens when a
connection attempt starts. A fresh profile avoids Firefox's startup recovery
dialog, which can otherwise leave the remote desktop apparently blank.
The VNC display accepts connections only from VM loopback; the public browser
route is protected by the gateway's short-lived session. The gateway
service binds to `127.0.0.1:8787`; [Caddyfile.example](Caddyfile.example) is the
HTTPS reverse proxy. It requires a short-lived browser session before forwarding
any noVNC page or WebSocket. Only ports 80 and 443 need external access. The
installed but logged-out Tailscale client is not part of this route.

Set `VITE_CHATGPT_VM_URL` to the VM's HTTPS origin when building the PWA. On the VM,
put `FITCOACH_VM_SUPABASE_URL`, `FITCOACH_VM_SUPABASE_KEY` (the public anon key),
`FITCOACH_VM_PWA_ORIGIN`, and `FITCOACH_VM_PUBLIC_ORIGIN` in an owner-protected
`/etc/fitcoach-vm.env`. The gateway verifies each PWA bearer token with Supabase
Auth and binds this VM to the first account that submits a one-hour pairing code.
`FITCOACH_VM_PWA_ORIGIN` accepts a comma-separated list of exact HTTPS origins
when an existing PWA installation still uses an older deployment address.
Generate that code on the VM with:

```bash
cd ~/fitcoach-prototype
.venv/bin/python -m prototype.chatgpt_vm.gateway pair-code
```

Enter the code once in Settings. Then **Connect ChatGPT** creates a short-lived
attempt and opens the VM browser. The PWA polls for the result; it never receives
an OpenAI code or token. A second FitCoach user receives 403 from this VM. The
browser session lasts ten minutes and the launch link can be redeemed only once.
The training API and account sync remain separate.

```bash
python3 -m venv .venv
.venv/bin/pip install -r prototype/chatgpt_vm/requirements.txt
.venv/bin/python -m prototype.chatgpt_vm.siwc sign-in
```

Launch the command from the VM desktop, or from SSH with the same X display:

```bash
cd ~/fitcoach-prototype
DISPLAY=:1 XAUTHORITY="$HOME/.Xauthority" \
XDG_RUNTIME_DIR="/run/user/$(id -u)" \
DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus" \
BROWSER=/usr/bin/firefox \
  .venv/bin/python -m prototype.chatgpt_vm.siwc sign-in
```

From the iPhone, control the **VM browser** and finish OpenAI consent. The command waits five minutes for a one-use `http://127.0.0.1:<port>/auth/callback` request. It then exchanges the code with the issued client ID, verifies the signed ID token through OpenAI’s JWKS, and prints only the verified account and whether `chatgpt.tokens.use.direct` was granted. Tokens and the stable opaque host ID are written separately under `~/.config/fitcoach-siwc-prototype/` with owner-only permissions. Do not capture the authorization URL, browser session, terminal output, or credential files in diagnostics. Use `status` to check a restarted VM and `disconnect` to revoke the refresh token where possible and clear credentials.

```bash
.venv/bin/python -m prototype.chatgpt_vm.siwc status
.venv/bin/python -m prototype.chatgpt_vm.siwc disconnect
.venv/bin/python -m pytest -q prototype/chatgpt_vm/test_siwc.py
```

Successful local tests do not prove the iPhone to VM browser route or OpenAI authorization. Document a real iPhone run's callback, successful code exchange, validated identity, and granted scopes without recording the browser session or tokens. Stop the product integration if this gate fails. Before offering this flow to other users, confirm with OpenAI that FitCoachGPT-operated VMs are eligible for the open-source plan-usage flow; [OpenAI’s overview](https://developers.openai.com/siwc/token-sharing-open-source) directs remotely hosted apps to its interest process.
