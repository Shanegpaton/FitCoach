# VM browser sign-in proof

This single-account prototype connects the FitCoachGPT PWA directly to one VM for ChatGPT sign-in. It does not make model requests. OAuth runs **inside the VM whose browser the iPhone user controls**. Opening the authorization URL in iPhone Safari would direct `127.0.0.1` to the phone and cannot complete this flow.

## Run on a disposable VM

Install a graphical browser and provide an authenticated HTTPS remote browser session that the iPhone can control. Do not enable browser-session recording. Use a fresh, single-user VM and protect its filesystem from other users.

For the current Oracle Ubuntu prototype, the live Python code and virtual environment are root-owned under
`/opt/fitcoach-vm`. A Firefox desktop runs as the unprivileged `fitcoach-browser` user, with no sudo access, and is served by TigerVNC on
`127.0.0.1:5901` and noVNC on `127.0.0.1:6080`; neither port should be opened in
the VCN security list. The PWA embeds a noVNC client and connects to the gateway's
authenticated WebSocket relay at `/v1/viewer`. Open TCP 80 and 443 in the Oracle VCN security
list and host firewall, then start Caddy so it can obtain a trusted certificate.
Do not expose the raw noVNC endpoint. The VM is an E5 paid shape, so stop it when the prototype is
idle and account for persistent boot-volume charges.
The loopback desktop is managed by `fitcoach-vnc.service` and `fitcoach-novnc.service` in
[`systemd/`](systemd/). `fitcoach-browser-launcher.service` opens only approved OpenAI authorization URLs.
The gateway and OAuth callback run as the separate `fitcoach-auth` system user. Its owner-only state directory
is `/var/lib/fitcoach-auth/state`, including `credentials.json`, `host.json`, and `owner.json`.
The browser user cannot read that directory, use sudo, or edit the root-owned code used by the gateway.
These services start after a VM reboot.
When setting up another VM, create `fitcoach-browser` without sudo and `fitcoach-auth` as separate
system users. Add `fitcoach-auth` to the `fitcoach-browser` group so it can reach the local launcher
socket, keep `/var/lib/fitcoach-auth` mode `0700` and its JSON files mode `0600`, and make
`/opt/fitcoach-vm` and its virtual environment root-owned without group or other write permission.
Do not run the VNC desktop as the default `ubuntu` user on Oracle images, because that user has
passwordless sudo. The browser profile from the earlier `ubuntu` desktop was archived inside the
protected auth home when this VM was migrated.
Install Mozilla's signed `firefox-esr` DEB package from its official APT
repository. The gateway retains `NoNewPrivileges=true`; Ubuntu's Snap Firefox
cannot start under that restriction. The sign-in process uses
`/usr/bin/firefox-esr`; an alternative path can be set with
`FITCOACH_VM_FIREFOX`.
The browser launcher opens Firefox with a dedicated profile at
`/var/lib/fitcoach-browser/.local/share/fitcoach-firefox-profile`. Keep that profile across VM
restarts. The VNC startup script starts only Openbox; Firefox opens when a
connection attempt starts. A fresh profile avoids Firefox's startup recovery
dialog, which can otherwise leave the remote desktop apparently blank.
The VNC display accepts connections only from VM loopback; the public viewer
requires an attempt-specific token and an exact allowed PWA origin. The gateway
service binds to `127.0.0.1:8787`; [Caddyfile.example](Caddyfile.example) is the
HTTPS reverse proxy. Its older `/browser/*` route remains protected for previous
PWA deployments. Only ports 80 and 443 need external access. The
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
cd /opt/fitcoach-vm
sudo -u fitcoach-auth HOME=/var/lib/fitcoach-auth .venv/bin/python -m prototype.chatgpt_vm.gateway pair-code --storage /var/lib/fitcoach-auth/state
```

Enter the code once in Settings. Then **Connect ChatGPT** creates a short-lived
attempt and shows the VM browser inside the PWA. The PWA polls for the result; it
never receives an OpenAI code or token. A second FitCoach user receives 403 from
this VM. The viewer token is held only in PWA memory and is valid for ten minutes.
Older deployments may still use a one-use launch link.
The training API and account sync remain separate.

From the iPhone, control the **VM browser** and finish OpenAI consent. The protected OAuth process waits five minutes for a one-use `http://127.0.0.1:<port>/auth/callback` request. It then exchanges the code with the issued client ID and verifies the signed ID token through OpenAI’s JWKS. Tokens and the stable opaque host ID stay in the protected state directory. The browser receives the OpenAI page and callback response, never the token JSON. Do not capture the authorization URL, browser session, terminal output, or credential files in diagnostics. The browser is still a full desktop, so this prototype should serve only its single paired account.

```bash
sudo -u fitcoach-auth HOME=/var/lib/fitcoach-auth .venv/bin/python -m prototype.chatgpt_vm.siwc status --storage /var/lib/fitcoach-auth/state
sudo -u fitcoach-auth HOME=/var/lib/fitcoach-auth .venv/bin/python -m prototype.chatgpt_vm.siwc disconnect --storage /var/lib/fitcoach-auth/state
.venv/bin/python -m pytest -q prototype/chatgpt_vm/test_siwc.py prototype/chatgpt_vm/test_browser_launcher.py
```

Successful local tests do not prove the iPhone to VM browser route or OpenAI authorization. Document a real iPhone run's callback, successful code exchange, validated identity, and granted scopes without recording the browser session or tokens. Stop the product integration if this gate fails. Before offering this flow to other users, confirm with OpenAI that FitCoachGPT-operated VMs are eligible for the open-source plan-usage flow; [OpenAI’s overview](https://developers.openai.com/siwc/token-sharing-open-source) directs remotely hosted apps to its interest process.
