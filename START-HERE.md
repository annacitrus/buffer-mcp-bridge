# Start here on Windows

This beta includes 17 local tests. Follow the full [README](README.md) for the live Buffer contract, PostgreSQL, OAuth, and deployment setup. You can run mock tests before creating keys or hosting resources. For the free personal laptop route, see [deploy/LAPTOP.md](deploy/LAPTOP.md).

The first live integration step is a read-only Buffer probe.

1. Open [Buffer](https://publish.buffer.com/), sign into the intended account, go to **Settings → API**, and create/copy an API key. Keep it private.
2. Open **Windows PowerShell** and run:

   ```powershell
   git clone https://github.com/annacitrus/buffer-mcp-bridge.git
   Set-Location buffer-mcp-bridge
   npm ci
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\new-keyring.ps1
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\probe.ps1
   ```

   The keyring command is a one-time step. If it says the keyring already exists, keep it and continue to the probe.

3. Paste your API key **into the hidden terminal prompt**, then press Enter. Nothing will be displayed as you type. The script does not save the key.
4. The probe displays your actual account and organizations locally. Copy an organization ID from that output into its next prompt. It performs only reads.
5. Keep `secrets/probe-private.json` private. The non-secret tool schemas are saved in `config/catalog.json`; they can be reviewed to finish the response mapping. The app stays closed until that live contract is reviewed, an OAuth provider is configured, and PostgreSQL is available.

The detailed [README](README.md) explains the response mapping, PostgreSQL, OAuth, public HTTPS deployment, Claude connection, backups, and adding a third account.
